import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEventBody, AgentId, PermissionMode, TurnEndReason, TurnUsage } from '../../../shared/protocol.ts';

export interface TurnRequest {
  repo: string;
  prompt: string;
  /** The CLI's own session id to resume, or null to start fresh. */
  nativeSessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
}

/** Mutable state an adapter accumulates while mapping one turn's lines. */
export interface TurnState {
  nativeSessionId: string | null;
  lastText: string;
  sawQuestionTool: boolean;
  usage: TurnUsage | null;
  endReason: TurnEndReason | null;
}

export interface AgentAdapter {
  id: AgentId;
  /** Executable to spawn. Resolved on PATH. */
  command: string;
  /** Models to offer in the UI picker. Static per agent; cheap to keep here. */
  models: readonly string[];
  /** Permission modes this agent can actually honor. */
  supportedModes: readonly PermissionMode[];
  /**
   * Mode a new session gets when the operator expresses no preference.
   *
   * Per-agent rather than a single global constant because the agents are not
   * equally capable of honoring one: a headless turn has nobody to answer a
   * permission prompt, so whatever the CLI would have asked about is denied
   * instead. The posture that makes an agent useful is therefore the one it can
   * actually act under, and that differs per CLI. Must be a member of
   * `supportedModes` — `adapters.test.ts` asserts it.
   */
  defaultMode: PermissionMode;
  /**
   * How the prompt reaches the CLI. 'stdin' is preferred — it keeps prompt text
   * out of `ps` output and has no length limit — but Kimi's `-p` requires the
   * prompt as an argv value, so it must opt into 'argv'.
   */
  promptVia: 'stdin' | 'argv';
  buildArgs(req: TurnRequest): string[];
  /**
   * Map one parsed stdout line into normalized events, updating `state`.
   * Returning an empty array means "recognized but not worth showing".
   */
  mapLine(line: unknown, state: TurnState): AgentEventBody[];
}

/** What the caller needs from a finished turn beyond the events it already saw. */
export interface TurnOutcome {
  /**
   * The CLI's own session id as of the end of the turn, or null if it never
   * named one. Reported here rather than left to the event stream because *when*
   * an agent discloses its id is dialect, and the caller must not have to know
   * it: claude and qwen announce theirs in an opening init frame, but kimi emits
   * no init frame at all and only drops a `session.resume_hint` on its very last
   * line. A caller that only watched for init would therefore never learn kimi's
   * id, would never pass `--session` on the next turn, and every kimi turn would
   * silently start a brand-new CLI session with no memory of the last one.
   */
  nativeSessionId: string | null;
}

export interface RunHandle {
  /** Resolves once the turn has fully ended and turn_end has been emitted. */
  done: Promise<TurnOutcome>;
  /** Terminate the turn early; emits turn_end with reason 'interrupted'. */
  interrupt(): void;
}

/**
 * How long an interrupted turn gets to exit on its own before it is killed
 * outright, and then how long its pipes get to close before the turn is settled
 * regardless. Both are deliberately short: the operator pressed Stop, so the
 * only thing being waited on is a tidy exit, not useful work.
 */
const INTERRUPT_GRACE_MS = 4_000;
const REAP_GRACE_MS = 2_000;

/**
 * Run exactly one turn and stream normalized events to `onEvent`.
 *
 * Every path emits precisely one terminal `turn_end` — including spawn failure,
 * nonzero exit, and interrupt — because that event is what fires the Discord
 * notifier. Dropping it on an error path would mean silent failures on the phone.
 */
export function runTurn(
  adapter: AgentAdapter,
  req: TurnRequest,
  onEvent: (body: AgentEventBody) => void,
): RunHandle {
  const state: TurnState = {
    nativeSessionId: req.nativeSessionId,
    lastText: '',
    sawQuestionTool: false,
    usage: null,
    endReason: null,
  };

  let settled = false;
  let interrupted = false;

  const child = spawn(adapter.command, adapter.buildArgs(req), {
    cwd: req.repo,
    // Strip ANTHROPIC_API_KEY so the claude CLI cannot silently fall off the
    // user's OAuth subscription onto metered API billing. Same for the others.
    env: scrubbedEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Give the turn its own process group so interrupt() can signal the whole
    // tree. What we spawn is often not the agent: `qwen`'s bin is a launcher
    // that spawnSync's the real CLI, which in turn spawns `caffeinate`. Killing
    // only the direct child left the actual agent running and reparented to
    // init — still burning quota, still editing the repo. See interrupt().
    detached: true,
  });

  // Adapters that take the prompt on argv have already embedded it in buildArgs;
  // stdin still needs closing or the CLI waits forever for more input.
  child.stdin.end(adapter.promptVia === 'stdin' ? req.prompt : '');

  const stderrChunks: string[] = [];
  child.stderr.on('data', (c: Buffer) => {
    stderrChunks.push(c.toString());
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onEvent({ kind: 'raw', line: trimmed });
      return;
    }
    let bodies: AgentEventBody[];
    try {
      bodies = adapter.mapLine(parsed, state);
    } catch (err) {
      onEvent({ kind: 'error', message: `adapter ${adapter.id} failed to map a line: ${errText(err)}` });
      return;
    }
    for (const b of bodies) onEvent(b);
  });

  let resolveDone!: (outcome: TurnOutcome) => void;
  const done = new Promise<TurnOutcome>((resolve) => {
    resolveDone = resolve;
  });

  let killTimer: NodeJS.Timeout | undefined;
  let reapTimer: NodeJS.Timeout | undefined;

  const settle = (reason: TurnEndReason, summary: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    clearTimeout(reapTimer);
    // Stop mapping lines: past the terminal event, anything still arriving from
    // a survivor we could not kill would append to an ended turn.
    rl.close();
    onEvent({ kind: 'turn_end', reason, summary, usage: state.usage });
    // Report the id from every path, interrupt and error included: a turn the
    // operator stopped still created a real CLI session, and forgetting its id
    // would strand that session's context for good.
    resolveDone({ nativeSessionId: state.nativeSessionId });
  };

  /**
   * Signal the turn's whole process group.
   *
   * `detached: true` above made the child a group leader, so a negative pid
   * reaches it and everything it started. This matters beyond leaving strays
   * around: a survivor inherits the stdout pipe, and node fires `close` only
   * once every holder of it is gone. One orphan therefore keeps the turn from
   * ever settling, which locks the session at "running" and makes the Stop
   * button look inert no matter how many times it is pressed.
   */
  const signalTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // No such group — it either already exited or never formed. Fall back to
      // the direct child; if that throws too, there is nothing left to signal.
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  child.on('error', (err) => {
    onEvent({ kind: 'error', message: `failed to launch ${adapter.command}: ${errText(err)}` });
    settle('error', `could not launch ${adapter.command}`);
  });

  child.on('close', (code) => {
    if (interrupted) {
      settle('interrupted', 'Turn interrupted.');
      return;
    }
    if (code !== 0) {
      const detail = stderrChunks.join('').trim().slice(-500);
      if (detail) onEvent({ kind: 'error', message: detail });
      settle('error', detail || `${adapter.command} exited with code ${code}`);
      return;
    }
    settle(resolveEndReason(state), summarize(state));
  });

  return {
    done,
    interrupt() {
      if (settled || interrupted) return;
      interrupted = true;
      signalTree('SIGTERM');

      // Escalate rather than trust the CLI to honor SIGTERM, and then settle on
      // a timer even if the pipes never close. Stop has to end the turn from the
      // operator's side unconditionally: a turn that cannot settle leaves the
      // session wedged and refusing new prompts, which is worse than ending one
      // whose last few lines went unread.
      killTimer = setTimeout(() => {
        signalTree('SIGKILL');
        reapTimer = setTimeout(() => {
          settle('interrupted', 'Turn interrupted (forced).');
        }, REAP_GRACE_MS);
      }, INTERRUPT_GRACE_MS);
    },
  };
}

/**
 * Distinguish "finished the job" from "stopped to ask me something" — the phone
 * notification reads very differently in each case. The CLIs do not label this,
 * so it is inferred: an explicit ask-the-user tool is decisive, and otherwise a
 * final message ending in a question mark is the usable signal.
 */
function resolveEndReason(state: TurnState): TurnEndReason {
  if (state.endReason) return state.endReason;
  if (state.sawQuestionTool) return 'awaiting_input';
  if (/\?\s*$/.test(state.lastText.trim())) return 'awaiting_input';
  return 'completed';
}

function summarize(state: TurnState): string {
  const text = state.lastText.trim();
  if (!text) return '(no text output)';
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shorten a tool result for transport; the UI can request nothing longer. */
export function clipToolResult(content: string): string {
  const LIMIT = 4000;
  return content.length > LIMIT ? `${content.slice(0, LIMIT)}\n… (${content.length - LIMIT} more chars)` : content;
}
