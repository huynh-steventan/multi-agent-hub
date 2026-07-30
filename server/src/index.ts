import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AgentEvent,
  AgentEventBody,
  AgentId,
  Attachment,
  ClientFrame,
  PermissionMode,
  ServerFrame,
  UsageSnapshot,
} from '../../shared/protocol.ts';
import { AGENT_IDS } from '../../shared/protocol.ts';
import { getAdapter, runTurn, type RunHandle } from './adapters/index.ts';
import { allAdapters } from './adapters/index.ts';
import {
  composePrompt,
  deleteAttachment,
  deleteSessionAttachments,
  findAttachment,
  isInlineType,
  saveAttachment,
} from './attachments.ts';
import { config } from './config.ts';
import { notifyTurnEnd } from './notify.ts';
import { listRepos, repoStatus } from './repos.ts';
import { store } from './store.ts';
import { collectUsage } from './usage/index.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** Sockets currently watching a given session. */
const watchers = new Map<string, Set<WebSocket>>();
/** In-flight turns, so they can be interrupted. */
const active = new Map<string, RunHandle>();

let usageCache: UsageSnapshot[] = [];
/** When `usageCache` was collected, so REST reads can reuse it within the TTL. */
let usageCacheAt = 0;

// --- REST -------------------------------------------------------------------

app.get('/api/agents', (_req, res) => {
  res.json(
    allAdapters().map((a) => ({
      id: a.id,
      models: a.models,
      supportedModes: a.supportedModes,
      defaultMode: a.defaultMode,
    })),
  );
});

app.get('/api/repos', async (_req, res) => {
  res.json(await listRepos());
});

app.get('/api/repos/status', async (req, res) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  res.json(await repoStatus(path));
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: store.listSessions(), defaults: store.getSettings() });
});

app.post('/api/sessions', (req, res) => {
  const body = req.body as Record<string, unknown>;
  const agent = body.agent;
  const repo = body.repo;

  if (!isAgentId(agent)) {
    res.status(400).json({ error: `agent must be one of ${AGENT_IDS.join(', ')}` });
    return;
  }
  if (typeof repo !== 'string' || !existsSync(repo)) {
    res.status(400).json({ error: 'repo must be an existing directory path' });
    return;
  }

  const adapter = getAdapter(agent);
  const requestedMode = isPermissionMode(body.permissionMode) ? body.permissionMode : adapter.defaultMode;
  // Refuse silently-wrong behavior: if the agent cannot honor the requested
  // mode, fall back to one it can rather than pretending it applied.
  const permissionMode = adapter.supportedModes.includes(requestedMode) ? requestedMode : adapter.defaultMode;

  const session = store.createSession({
    agent,
    repo,
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled session',
    model: typeof body.model === 'string' ? body.model : null,
    permissionMode,
    notifyDiscord: body.notifyDiscord === true,
  });
  res.status(201).json(session);
});

app.patch('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.model === 'string') patch.model = body.model;
  if (typeof body.notifyDiscord === 'boolean') patch.notifyDiscord = body.notifyDiscord;
  if (isPermissionMode(body.permissionMode)) {
    const session = store.get(id);
    if (session && getAdapter(session.agent).supportedModes.includes(body.permissionMode)) {
      patch.permissionMode = body.permissionMode;
    }
  }

  const updated = store.updateSession(id, patch);
  if (!updated) {
    res.status(404).json({ error: 'no such session' });
    return;
  }
  broadcastSession(updated.id);
  res.json(updated);
});

app.delete('/api/sessions/:id', async (req, res) => {
  active.get(req.params.id)?.interrupt();
  active.delete(req.params.id);
  // Read the record before deleting it — it is what knows where the session's
  // attachments were written, and a deleted session must not leave files behind
  // in the operator's repo.
  const session = store.get(req.params.id);
  if (session) await deleteSessionAttachments(session).catch(() => undefined);
  res.json({ deleted: store.deleteSession(req.params.id) });
});

// --- attachments ------------------------------------------------------------

/**
 * Upload one file for a session.
 *
 * Raw body rather than multipart: one file per request needs no boundary
 * parsing and therefore no dependency, and it gives the UI a natural unit to
 * show progress and failure against. The filename rides in the query string
 * because a browser cannot set arbitrary headers on a `fetch` body without
 * tripping preflight for no gain.
 */
app.post(
  '/api/sessions/:id/attachments',
  express.raw({ type: '*/*', limit: config.attachmentMaxBytes }),
  async (req, res) => {
    const session = store.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty upload' });
      return;
    }

    try {
      const attachment = await saveAttachment(session, name, req.get('content-type') ?? null, req.body);
      res.status(201).json(attachment);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/** Serve an attachment back so the UI can preview what was sent. */
app.get('/api/sessions/:id/attachments/:name', async (req, res) => {
  const session = store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'no such session' });
    return;
  }
  const attachment = await findAttachment(session, req.params.name);
  if (!attachment) {
    res.status(404).json({ error: 'no such attachment' });
    return;
  }

  // These bytes are operator-supplied and served from the app's own origin, so
  // only known image types are allowed to render in place; anything else is
  // forced to download rather than being interpreted as markup or script.
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `${isInlineType(attachment.mimeType) ? 'inline' : 'attachment'}; filename="${attachment.name}"`,
  );
  createReadStream(attachment.path).pipe(res);
});

app.delete('/api/sessions/:id/attachments/:name', async (req, res) => {
  const session = store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'no such session' });
    return;
  }
  res.json({ deleted: await deleteAttachment(session, req.params.name) });
});

/**
 * Quota, from the poller's cache.
 *
 * Re-collecting per request would mean every page load and every reconnect
 * fires two upstream API calls, which buys nothing: these windows move over
 * hours. Past the TTL the read refreshes so a long-idle tab is not served
 * something stale.
 */
app.get('/api/usage', async (_req, res) => {
  if (Date.now() - usageCacheAt >= config.usagePollMs) await refreshUsage();
  res.json(usageCache);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sessions: store.listSessions().length });
});

// Serve the built frontend when it exists; in dev, Vite serves it instead.
const webDist = resolve(process.cwd(), 'web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

// --- WebSocket --------------------------------------------------------------

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
    } catch {
      return;
    }
    handleFrame(socket, frame).catch((err: unknown) => {
      console.error('[ws] frame handler failed:', err);
    });
  });

  socket.on('close', () => {
    for (const set of watchers.values()) set.delete(socket);
  });

  send(socket, { type: 'usage', usage: usageCache });
});

async function handleFrame(socket: WebSocket, frame: ClientFrame): Promise<void> {
  if (frame.type === 'subscribe') {
    let set = watchers.get(frame.sessionId);
    if (!set) {
      set = new Set();
      watchers.set(frame.sessionId, set);
    }
    set.add(socket);
    // A client that reconnects (mobile suspends the socket constantly — a
    // locked screen or backgrounded tab both drop it) missed every
    // `broadcastSession` that fired while it was gone. Replaying history
    // catches the transcript up but says nothing about status, so a turn that
    // ended mid-disconnect left Stop showing forever until a manual reload.
    const session = store.get(frame.sessionId);
    if (session) send(socket, { type: 'session', session });
    send(socket, { type: 'history', sessionId: frame.sessionId, events: store.history(frame.sessionId) });
    return;
  }

  if (frame.type === 'unsubscribe') {
    const set = watchers.get(frame.sessionId);
    set?.delete(socket);
    if (set && set.size === 0) watchers.delete(frame.sessionId);
    return;
  }

  if (frame.type === 'interrupt') {
    active.get(frame.sessionId)?.interrupt();
    return;
  }

  if (frame.type === 'prompt') {
    await startTurn(frame.sessionId, frame.text, frame.attachments ?? []);
  }
}

/**
 * Run one turn for a session.
 *
 * Turns are one-shot CLI invocations resumed by native session id, so the hub
 * holds no long-lived agent processes: a restart loses nothing but an in-flight
 * turn, and the conversation itself is recoverable from the CLI's own store.
 */
async function startTurn(sessionId: string, text: string, attachmentNames: string[]): Promise<void> {
  const session = store.get(sessionId);
  if (!session) return;
  if (active.has(sessionId)) {
    emit(sessionId, { kind: 'error', message: 'A turn is already running for this session.' });
    return;
  }

  // Resolve names the client sent against this session's own directory, rather
  // than trusting a path from the wire: the agent is about to be told to read
  // whatever comes back, so it must be a path the server built.
  const resolved = await Promise.all(attachmentNames.slice(0, 20).map((n) => findAttachment(session, n)));
  const attachments = resolved.filter((a): a is Attachment => a !== null);
  const missing = resolved.length - attachments.length;

  store.updateSession(sessionId, { status: 'running', lastActiveAt: Date.now() });
  broadcastSession(sessionId);

  // Echo the prompt into the log so reconnecting clients see the full exchange.
  if (attachments.length > 0) emit(sessionId, { kind: 'attachments', items: attachments });
  if (missing > 0) {
    emit(sessionId, {
      kind: 'error',
      message: `${missing} attachment(s) were no longer on disk and were not sent.`,
    });
  }
  // An attachment on its own is a valid prompt, and echoing a bare "> " for it
  // would read as the user having sent nothing.
  if (text.trim()) emit(sessionId, { kind: 'text', text, from: 'operator' });

  const adapter = getAdapter(session.agent);
  const handle = runTurn(
    adapter,
    {
      repo: session.repo,
      prompt: composePrompt(text, attachments),
      nativeSessionId: session.nativeSessionId,
      model: session.model,
      permissionMode: session.permissionMode,
    },
    (body) => {
      emit(sessionId, body);
      // Persist early when the agent opens with its id, so an id already known
      // mid-turn survives a server restart that kills the turn under it.
      if (body.kind === 'init' && body.nativeSessionId) {
        store.updateSession(sessionId, { nativeSessionId: body.nativeSessionId });
      }
    },
  );

  active.set(sessionId, handle);

  const outcome = await handle.done;
  active.delete(sessionId);

  // Persist again from the outcome, because an init frame is not where every
  // agent names itself — kimi emits none and discloses its id on the stream's
  // last line. Without this the id never reaches the store, `--session` is never
  // passed, and every kimi turn silently starts a fresh CLI session.
  if (outcome.nativeSessionId) {
    store.updateSession(sessionId, { nativeSessionId: outcome.nativeSessionId });
  }

  const latest = store.get(sessionId);
  store.updateSession(sessionId, { status: 'idle', lastActiveAt: Date.now() });
  broadcastSession(sessionId);

  const endEvent = [...store.history(sessionId)].reverse().find((e) => e.body.kind === 'turn_end');
  if (endEvent && endEvent.body.kind === 'turn_end' && latest) {
    await notifyTurnEnd(latest, endEvent.body.reason, endEvent.body.summary, endEvent.body.usage);
  }
}

function emit(sessionId: string, body: AgentEventBody): void {
  const event = store.appendEvent(sessionId, body);
  broadcast(sessionId, { type: 'event', event });
}

function broadcastSession(sessionId: string): void {
  const session = store.get(sessionId);
  if (session) broadcast(sessionId, { type: 'session', session });
}

function broadcast(sessionId: string, frame: ServerFrame): void {
  for (const socket of watchers.get(sessionId) ?? []) send(socket, frame);
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v);
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'default' || v === 'plan' || v === 'acceptEdits' || v === 'bypass';
}

// --- boot -------------------------------------------------------------------

/** Re-collect quota and push it to every connected client. */
async function refreshUsage(): Promise<void> {
  usageCache = await collectUsage();
  usageCacheAt = Date.now();
  const frame: ServerFrame = { type: 'usage', usage: usageCache };
  for (const socket of wss.clients) send(socket, frame);
}

async function main(): Promise<void> {
  await store.load();

  await refreshUsage();
  setInterval(() => {
    refreshUsage().catch((err: unknown) => console.error('[usage] poll failed:', err));
  }, config.usagePollMs).unref();

  // A redeploy is a normal event here, and the transcript the UI replays lives
  // in the event log — flush it rather than losing the last few hundred ms.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // Turns run in their own process group, so they no longer die alongside
      // the server the way a same-group child would. Ending them here is what
      // keeps a restart from leaving agents running against the operator's
      // repos with nothing left to stream them to.
      for (const handle of active.values()) handle.interrupt();
      active.clear();

      store
        .flush()
        .catch((err: unknown) => console.error('[store] flush on shutdown failed:', err))
        .finally(() => process.exit(0));
    });
  }

  // Loopback-only bind. Remote access is Tailscale's job (`tailscale serve`),
  // which terminates TLS and restricts reachability to the tailnet. Binding
  // 0.0.0.0 here would expose an unauthenticated shell-equivalent to the LAN.
  httpServer.listen(config.port, '127.0.0.1', () => {
    console.log(`multi-agent-hub listening on http://127.0.0.1:${config.port}`);
    console.log(`expose to your tailnet with:  tailscale serve --bg ${config.port}`);
  });
}

main().catch((err: unknown) => {
  console.error('multi-agent-hub failed to start:', err);
  process.exit(1);
});

export type { AgentEvent };
