/**
 * The wire contract between the hub server and the web client.
 *
 * Every agent CLI emits its own dialect of JSON lines; adapters normalize all of
 * them into `AgentEvent` so the frontend never learns three formats. Anything an
 * adapter cannot map lands as `raw`, which the UI shows in a debug drawer rather
 * than dropping silently.
 */

export type AgentId = 'claude' | 'kimi' | 'qwen';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'kimi', 'qwen'] as const;

/** Normalized permission posture. Each adapter maps this onto its own flags. */
export type PermissionMode =
  | 'default' // ask about sensitive tools (agent decides what that means)
  | 'plan' // read-only: produce a plan, change nothing
  | 'acceptEdits' // auto-approve file edits, still gate shells/network
  | 'bypass'; // auto-approve everything — use only in trusted repos

/**
 * A file the operator attached to a prompt.
 *
 * Agents receive attachments by **path**, never inline: none of the three CLIs
 * accept image or file data in a headless prompt, but all three can read a file
 * off disk with their own tools. `path` therefore points inside the session's
 * repo — the only location all three reach, since `qwen` confines its file
 * tools to the workspace root and has no `--add-dir` to widen it.
 */
export interface Attachment {
  /**
   * On-disk basename inside the session's attachment directory. Doubles as the
   * id: it is what the client sends back with a prompt, and the server rebuilds
   * the absolute path from it rather than trusting a client-supplied one.
   */
  storedName: string;
  /** Display name — `storedName` without its collision-breaking prefix. */
  name: string;
  /** Absolute path, inside the session's repo, handed to the agent. */
  path: string;
  mimeType: string;
  size: number;
}

export interface AgentEvent {
  /** Monotonic per-session sequence, assigned by the server. */
  seq: number;
  sessionId: string;
  at: number;
  body: AgentEventBody;
}

export type AgentEventBody =
  /** Session metadata discovered at turn start (model, tools, slash commands). */
  | { kind: 'init'; model: string | null; tools: string[]; slashCommands: string[]; nativeSessionId: string | null }
  /**
   * Visible prose. `from: 'operator'` marks the echo of what the user typed,
   * which the transcript replays so a reconnecting client sees both sides.
   *
   * Marked structurally rather than by a `> ` prefix because the UI renders
   * agent prose as markdown, where a leading `> ` is a blockquote — an agent
   * quoting anything would otherwise be drawn as if the user had said it, and
   * the user's own words would be reformatted instead of shown as typed.
   */
  | { kind: 'text'; text: string; from?: 'operator' }
  /** Files the operator attached to the prompt that follows. */
  | { kind: 'attachments'; items: Attachment[] }
  /** Extended-thinking content, rendered collapsed. */
  | { kind: 'thinking'; text: string }
  /** The agent invoked a tool. */
  | { kind: 'tool_call'; toolId: string; name: string; input: unknown }
  /** A tool returned. `isError` drives the red/green treatment in the UI. */
  | { kind: 'tool_result'; toolId: string; content: string; isError: boolean }
  /** The turn finished. This is the single hook point for the Discord notifier. */
  | { kind: 'turn_end'; reason: TurnEndReason; summary: string; usage: TurnUsage | null }
  /** The adapter or the process itself failed. */
  | { kind: 'error'; message: string }
  /** Unmapped passthrough, for the debug drawer. */
  | { kind: 'raw'; line: string };

/**
 * Why a turn ended. `awaiting_input` is the case worth a phone notification —
 * the agent stopped to ask something rather than finishing the job.
 */
export type TurnEndReason = 'completed' | 'awaiting_input' | 'error' | 'interrupted';

export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  /** Notional cost as reported by the CLI. Subscription turns are not billed at this rate. */
  costUsd: number | null;
}

/** One agent's standing against its plan limits. */
export interface UsageSnapshot {
  agent: AgentId;
  /** null when the provider genuinely cannot determine it — never faked to 0. */
  windows: UsageWindow[];
  /** Human-readable note when data is partial, stale, or estimated. */
  caveat: string | null;
  fetchedAt: number;
}

export interface UsageWindow {
  label: string;
  /** 0-100, or null if the denominator is unknown. */
  percent: number | null;
  /** Free-text detail, e.g. "8.2M / 30M tokens" or "resets in 3h". */
  detail: string | null;
  resetsAt: number | null;
  /**
   * How long the window spans, in ms. With `resetsAt` this pins down when the
   * window opened, which is the only way to say whether consumption is ahead of
   * or behind an even burn. Null when the provider genuinely does not know the
   * duration — the UI then falls back to absolute `severity` rather than
   * inventing a start time.
   */
  windowMs: number | null;
  severity: 'normal' | 'warning' | 'critical' | 'unknown';
}

export interface SessionRecord {
  id: string;
  agent: AgentId;
  /** Absolute path to the repo this session runs in. */
  repo: string;
  title: string;
  /** The agent CLI's own session id, used to resume. Null until the first turn completes. */
  nativeSessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  notifyDiscord: boolean;
  createdAt: number;
  lastActiveAt: number;
  status: 'idle' | 'running';
}

export interface RepoEntry {
  path: string;
  name: string;
  branch: string | null;
  dirty: boolean;
}

/** Server → client websocket frames. */
export type ServerFrame =
  | { type: 'event'; event: AgentEvent }
  | { type: 'session'; session: SessionRecord }
  | { type: 'usage'; usage: UsageSnapshot[] }
  | { type: 'history'; sessionId: string; events: AgentEvent[] };

/**
 * Client → server websocket frames.
 *
 * A client may hold several subscriptions at once — the desktop workspace shows
 * multiple sessions side by side — so `unsubscribe` exists to drop one without
 * tearing down the socket.
 */
export type ClientFrame =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  /**
   * `attachments` carries `storedName`s of files already uploaded over REST,
   * not paths: the server resolves each against the session's own attachment
   * directory, so a client cannot point an agent at an arbitrary file.
   */
  | { type: 'prompt'; sessionId: string; text: string; attachments?: string[] }
  | { type: 'interrupt'; sessionId: string };
