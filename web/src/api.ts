import type {
  AgentEvent,
  AgentId,
  Attachment,
  PermissionMode,
  RepoEntry,
  ServerFrame,
  SessionRecord,
  UsageSnapshot,
} from '../../shared/protocol.ts';

export interface AgentInfo {
  id: AgentId;
  models: string[];
  supportedModes: PermissionMode[];
  /** What a new session gets when the operator picks nothing. Per-agent. */
  defaultMode: PermissionMode;
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  agents: () => json<AgentInfo[]>('/api/agents'),
  repos: () => json<RepoEntry[]>('/api/repos'),
  usage: () => json<UsageSnapshot[]>('/api/usage'),
  sessions: () =>
    json<{ sessions: SessionRecord[]; defaults: { lastRepo: string | null; lastAgent: AgentId | null } }>(
      '/api/sessions',
    ),
  createSession: (input: {
    agent: AgentId;
    repo: string;
    title: string;
    model: string | null;
    permissionMode: PermissionMode;
    notifyDiscord: boolean;
  }) => json<SessionRecord>('/api/sessions', { method: 'POST', body: JSON.stringify(input) }),
  updateSession: (id: string, patch: Partial<SessionRecord>) =>
    json<SessionRecord>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => json<{ deleted: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  /**
   * Upload one attachment.
   *
   * The file goes up as a raw body with its name in the query string — the
   * server takes it that way so neither side needs a multipart library, and one
   * request per file is what lets the composer show a single chip failing
   * rather than a whole batch.
   */
  uploadAttachment: (sessionId: string, file: File) =>
    json<Attachment>(`/api/sessions/${sessionId}/attachments?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      // Deliberately overrides the JSON default in `json()`.
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),

  deleteAttachment: (sessionId: string, storedName: string) =>
    json<{ deleted: boolean }>(
      `/api/sessions/${sessionId}/attachments/${encodeURIComponent(storedName)}`,
      { method: 'DELETE' },
    ),
};

/** Where the UI reads an attachment back from, for previews and downloads. */
export function attachmentUrl(sessionId: string, storedName: string): string {
  return `/api/sessions/${sessionId}/attachments/${encodeURIComponent(storedName)}`;
}

type Listener = (frame: ServerFrame) => void;

/**
 * Auto-reconnecting websocket.
 *
 * A phone backgrounds the tab constantly, so drops are the normal case rather
 * than an error. On reconnect the client re-subscribes and the server replays
 * each session's history, which is why reconnection can be silent.
 *
 * Subscriptions are a set, not a single id: the desktop workspace shows several
 * sessions side by side and every one of them streams at once.
 */
export class HubSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>();
  private retry = 0;
  private closed = false;

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.retry = 0;
      for (const id of this.subscribed) this.send({ type: 'subscribe', sessionId: id });
    };
    socket.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data as string) as ServerFrame;
      } catch {
        return;
      }
      for (const l of this.listeners) l(frame);
    };
    socket.onclose = () => {
      if (this.closed) return;
      this.retry += 1;
      setTimeout(() => this.connect(), Math.min(1000 * this.retry, 10_000));
    };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribe(sessionId: string): void {
    this.subscribed.add(sessionId);
    this.send({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscribed.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }

  /** Bring the live subscriptions in line with the sessions currently on screen. */
  syncSubscriptions(sessionIds: string[]): void {
    const wanted = new Set(sessionIds);
    // Snapshot first — unsubscribe() mutates the set being compared against.
    for (const id of [...this.subscribed]) if (!wanted.has(id)) this.unsubscribe(id);
    for (const id of wanted) if (!this.subscribed.has(id)) this.subscribe(id);
  }

  /** `attachments` are `storedName`s from `uploadAttachment`, not paths. */
  prompt(sessionId: string, text: string, attachments: string[] = []): void {
    this.send({ type: 'prompt', sessionId, text, attachments });
  }

  interrupt(sessionId: string): void {
    this.send({ type: 'interrupt', sessionId });
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
}

export type { AgentEvent, Attachment, SessionRecord, UsageSnapshot, RepoEntry };
