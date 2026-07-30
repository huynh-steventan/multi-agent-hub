import type { AgentEventBody } from '../../../shared/protocol.ts';
import { clipToolResult, type AgentAdapter, type TurnRequest, type TurnState } from './base.ts';
import { isRecord, str } from './claude.ts';

/**
 * Kimi Code adapter.
 *
 * Kimi is the outlier of the three. Its stream-json is OpenAI chat-completion
 * shaped (`{role, content}` / `{role, tool_calls}` / `{role: 'tool'}`) rather
 * than Anthropic-shaped, it emits no init frame and no token usage at all, and
 * its session id arrives only at the very end in a `meta` resume hint.
 *
 * It also rejects `-p` combined with `--yolo`, `--auto`, or `--plan`, so
 * permission mode is not selectable for headless turns — hence the single
 * supported mode. That costs nothing: `-p` is *already* yolo. Verified
 * 2026-07-28 by a headless turn that wrote a file and ran a shell command with
 * no approval step and nothing refused. The UI surfaces the single mode rather
 * than pretending a toggle works.
 */
export const kimiAdapter: AgentAdapter = {
  id: 'kimi',
  command: 'kimi',
  models: ['kimi-code/k3', 'kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed', 'kimi-code/k3-256k'],
  supportedModes: ['default'],
  // Not a choice: `-p` rejects `--yolo` outright, so 'default' is the only mode
  // Kimi has. It is also the only one needed — headless Kimi already behaves as
  // yolo. Do not try to buy the same posture by injecting a `/yolo` first turn:
  // it spends real quota to be told "already active", and the flag it would
  // stand in for cannot be passed anyway.
  defaultMode: 'default',
  // `-p/--prompt <prompt>` takes a value; Kimi does not read the prompt from stdin.
  promptVia: 'argv',

  buildArgs(req: TurnRequest): string[] {
    const args = ['--output-format', 'stream-json'];
    if (req.nativeSessionId) args.push('--session', req.nativeSessionId);
    if (req.model) args.push('-m', req.model);
    // Must come last so the prompt value is unambiguous.
    args.push('-p', req.prompt);
    return args;
  },

  mapLine(line: unknown, state: TurnState): AgentEventBody[] {
    if (!isRecord(line)) return [];
    const role = str(line.role);

    if (role === 'meta') {
      const sid = str(line.session_id);
      if (sid) state.nativeSessionId = sid;
      return [];
    }

    if (role === 'assistant') {
      const out: AgentEventBody[] = [];

      if (Array.isArray(line.tool_calls)) {
        for (const call of line.tool_calls) {
          if (!isRecord(call)) continue;
          const fn = isRecord(call.function) ? call.function : null;
          const name = (fn && str(fn.name)) ?? 'tool';
          out.push({
            kind: 'tool_call',
            toolId: str(call.id) ?? '',
            name,
            input: parseArguments(fn?.arguments),
          });
        }
      }

      const content = str(line.content);
      if (content) {
        state.lastText = content;
        out.push({ kind: 'text', text: content });
      }

      const reasoning = str(line.reasoning_content);
      if (reasoning) out.unshift({ kind: 'thinking', text: reasoning });

      return out;
    }

    if (role === 'tool') {
      const content = str(line.content) ?? '';
      return [
        {
          kind: 'tool_result',
          toolId: str(line.tool_call_id) ?? '',
          content: clipToolResult(content),
          // Kimi does not flag tool failure structurally; leave it unmarked
          // rather than guess from the text and mislabel legitimate output.
          isError: false,
        },
      ];
    }

    return [{ kind: 'raw', line: JSON.stringify(line).slice(0, 500) }];
  },
};

/** Tool arguments arrive as a JSON *string*; show the raw text if it will not parse. */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
