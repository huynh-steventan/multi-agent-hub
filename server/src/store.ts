import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent, AgentId, PermissionMode, SessionRecord } from '../../shared/protocol.ts';
import { config, eventsDir, sessionsFile, settingsFile } from './config.ts';

/** Most recent events kept per session, in memory and on disk. */
const MAX_EVENTS = 2000;

/**
 * How long to batch event writes before flushing.
 *
 * A streaming turn appends dozens of events a second; writing the log on each
 * one would turn the transcript into a disk-thrash loop for no benefit, since
 * nothing reads the file until the next boot. Losing at most this much
 * scrollback to a hard kill is the accepted trade.
 */
const EVENT_FLUSH_MS = 750;

interface HubSettings {
  /** Last repo chosen, so new sessions can default to it. */
  lastRepo: string | null;
  lastAgent: AgentId | null;
}

/**
 * Session registry and event log.
 *
 * Deliberately file-backed rather than a database: the volume is a handful of
 * sessions on one machine, and plain JSON stays inspectable and trivially
 * backed up. Conversation content itself lives in each CLI's own session store —
 * this only tracks what the hub needs to resume and display.
 *
 * The event log is persisted too, not just held in memory. It is what the UI
 * replays on subscribe, so keeping it only in memory meant every server
 * redeploy silently blanked every open session's transcript, even though the
 * sessions themselves survived.
 */
export class Store {
  private sessions = new Map<string, SessionRecord>();
  private events = new Map<string, AgentEvent[]>();
  private settings: HubSettings = { lastRepo: null, lastAgent: null };
  private seq = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();
  private dirtyEvents = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  async load(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    await mkdir(eventsDir, { recursive: true });
    const sessions = await readJson<SessionRecord[]>(sessionsFile);
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        // The id also names this session's event log on disk, so only ids this
        // store could have generated are admitted back in.
        if (!isSessionId(s?.id)) continue;
        // A session cannot survive a restart mid-turn; reset it to idle so the
        // UI never shows a spinner for a process that no longer exists.
        this.sessions.set(s.id, { ...s, status: 'idle' });
      }
    }
    const settings = await readJson<HubSettings>(settingsFile);
    if (settings) this.settings = { lastRepo: settings.lastRepo ?? null, lastAgent: settings.lastAgent ?? null };

    // Only load logs for sessions that still exist — an orphaned file would
    // otherwise be resurrected forever by the next flush.
    for (const id of this.sessions.keys()) {
      const log = await readJson<AgentEvent[]>(eventsFile(id));
      if (!Array.isArray(log) || log.length === 0) continue;
      this.events.set(id, log);
      // Resume the sequence where the last run left off, so replayed and new
      // events keep a single ordering and React keys stay unique.
      this.seq.set(id, log[log.length - 1]?.seq ?? 0);
    }
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  createSession(input: {
    agent: AgentId;
    repo: string;
    title: string;
    model: string | null;
    permissionMode: PermissionMode;
    notifyDiscord: boolean;
  }): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID(),
      agent: input.agent,
      repo: input.repo,
      title: input.title,
      nativeSessionId: null,
      model: input.model,
      permissionMode: input.permissionMode,
      notifyDiscord: input.notifyDiscord,
      createdAt: now,
      lastActiveAt: now,
      status: 'idle',
    };
    this.sessions.set(session.id, session);
    this.settings = { lastRepo: input.repo, lastAgent: input.agent };
    this.persist();
    return session;
  }

  updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, id: existing.id };
    this.sessions.set(id, updated);
    this.persist();
    return updated;
  }

  deleteSession(id: string): boolean {
    const had = this.sessions.delete(id);
    this.events.delete(id);
    this.seq.delete(id);
    this.dirtyEvents.delete(id);
    if (had) {
      this.persist();
      this.enqueue(() => rm(eventsFile(id), { force: true }));
    }
    return had;
  }

  /** Append an event, assigning its per-session sequence number. */
  appendEvent(sessionId: string, body: AgentEvent['body']): AgentEvent {
    const next = (this.seq.get(sessionId) ?? 0) + 1;
    this.seq.set(sessionId, next);
    const event: AgentEvent = { seq: next, sessionId, at: Date.now(), body };
    const log = this.events.get(sessionId) ?? [];
    log.push(event);
    // Bound memory: a long-running session's transcript is in the CLI's own
    // store, so the hub only needs enough scrollback to render the view.
    if (log.length > MAX_EVENTS) log.splice(0, log.length - MAX_EVENTS);
    this.events.set(sessionId, log);
    this.scheduleEventFlush(sessionId);
    return event;
  }

  history(sessionId: string): AgentEvent[] {
    return this.events.get(sessionId) ?? [];
  }

  getSettings(): HubSettings {
    return this.settings;
  }

  /** Write every pending event log now. Used on shutdown. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushEvents();
    await this.writeQueue;
  }

  /**
   * Serialize writes so concurrent turns cannot interleave and truncate the
   * file, and write via a temp file + rename so a crash mid-write cannot leave
   * a half-written registry behind.
   */
  private persist(): void {
    const sessions = this.listSessions();
    const settings = this.settings;
    this.enqueue(async () => {
      await mkdir(config.dataDir, { recursive: true });
      await writeAtomic(sessionsFile, JSON.stringify(sessions, null, 2));
      await writeAtomic(settingsFile, JSON.stringify(settings, null, 2));
    });
  }

  /** Coalesce the event writes of a burst of streamed output into one flush. */
  private scheduleEventFlush(sessionId: string): void {
    this.dirtyEvents.add(sessionId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushEvents();
    }, EVENT_FLUSH_MS);
    // Never hold the process open for a transcript write.
    this.flushTimer.unref?.();
  }

  private flushEvents(): void {
    if (this.dirtyEvents.size === 0) return;
    const pending = [...this.dirtyEvents].map((id) => [id, this.events.get(id) ?? []] as const);
    this.dirtyEvents.clear();
    this.enqueue(async () => {
      await mkdir(eventsDir, { recursive: true });
      for (const [id, log] of pending) {
        // A session deleted between scheduling and flushing must not be
        // written back out from the snapshot taken above.
        if (!this.sessions.has(id)) continue;
        await writeAtomic(eventsFile(id), JSON.stringify(log));
      }
    });
  }

  /** Append to the single serialized write chain; failures are logged, not thrown. */
  private enqueue(work: () => Promise<unknown>): void {
    this.writeQueue = this.writeQueue
      .then(work)
      .then(() => undefined)
      .catch((err: unknown) => {
        console.error('[store] failed to persist:', err);
      });
  }
}

/**
 * Session ids are server-generated UUIDs and they also name files on disk, so
 * every id is re-checked before it is turned into a path.
 */
function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function eventsFile(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`refusing to build a path from ${JSON.stringify(sessionId)}`);
  return join(eventsDir, `${sessionId}.json`);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = join(config.dataDir, `.tmp-${randomUUID()}`);
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export const store = new Store();
