import type { AgentEventBody } from '../../../shared/protocol.ts';
import { clipToolResult, type AgentAdapter, type TurnRequest, type TurnState } from './base.ts';
import { isRecord, num, pick, str, strArray, stringifyContent } from './claude.ts';

/**
 * Qwen Code adapter.
 *
 * Qwen Code emits a near-identical envelope to Claude Code (`system/init` →
 * `assistant` with Anthropic-style content blocks → `result`), so the mapping is
 * deliberately parallel. It diverges in three ways that matter here: the
 * permission field is `permission_mode`, usage rides on each assistant message
 * as well as the result, and it prints settings warnings to stderr that must not
 * be mistaken for failure output.
 *
 * The fourth divergence is the load-bearing one. Where `claude` keeps every tool
 * registered and *denies* the calls a mode disallows, **qwen removes the tools
 * from the registry outright** — under `--approval-mode default` the model is
 * never offered `run_shell_command`, `write_file`, `edit`, `notebook_edit` or
 * `monitor` at all, and correctly reports that it has no way to write or run
 * anything. So an approval mode must always be passed explicitly: omitting the
 * flag is not "leave it to the operator's config", it is a silent read-only
 * session. Measured 2026-07-28 from the init frame's `tools[]`:
 *
 *   plan | default | auto   58 tools — read-only
 *   auto-edit               61 tools — adds edit, write_file, notebook_edit
 *   yolo                    63 tools — adds run_shell_command, monitor
 */
export const qwenAdapter: AgentAdapter = {
  id: 'qwen',
  command: 'qwen',
  models: ['qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
  supportedModes: ['default', 'plan', 'acceptEdits', 'bypass'],
  // `--approval-mode yolo` — the only mode that registers `run_shell_command`.
  defaultMode: 'bypass',
  promptVia: 'stdin',

  buildArgs(req: TurnRequest): string[] {
    const args = ['-o', 'stream-json'];
    if (req.nativeSessionId) args.push('--resume', req.nativeSessionId);
    if (req.model) args.push('-m', req.model);
    // Unconditional: see the note above on why an omitted flag is a read-only
    // session rather than a neutral one.
    args.push('--approval-mode', mapMode(req.permissionMode));
    return args;
  },

  mapLine(line: unknown, state: TurnState): AgentEventBody[] {
    if (!isRecord(line)) return [];
    const type = str(line.type);

    const sid = str(line.session_id);
    if (sid) state.nativeSessionId = sid;

    if (type === 'system' && str(line.subtype) === 'init') {
      return [
        {
          kind: 'init',
          model: str(line.model),
          tools: strArray(line.tools),
          slashCommands: strArray(line.slash_commands),
          nativeSessionId: sid,
        },
      ];
    }

    if (type === 'assistant') {
      const message = isRecord(line.message) ? line.message : null;
      const content = message && Array.isArray(message.content) ? message.content : [];
      return content.flatMap((block) => mapBlock(block, state));
    }

    if (type === 'user') {
      const message = isRecord(line.message) ? line.message : null;
      const content = message && Array.isArray(message.content) ? message.content : [];
      return content.flatMap((block) => {
        if (!isRecord(block) || str(block.type) !== 'tool_result') return [];
        return [
          {
            kind: 'tool_result' as const,
            toolId: str(block.tool_use_id) ?? '',
            content: clipToolResult(stringifyContent(block.content)),
            isError: block.is_error === true,
          },
        ];
      });
    }

    if (type === 'result') {
      state.usage = {
        inputTokens: num(pick(line.usage, 'input_tokens')),
        outputTokens: num(pick(line.usage, 'output_tokens')),
        cachedTokens: num(pick(line.usage, 'cache_read_input_tokens')),
        totalTokens: num(pick(line.usage, 'total_tokens')),
        costUsd: null, // Qwen bills against a Bailian token plan, not per-turn USD.
      };
      if (line.is_error === true) state.endReason = 'error';
      const text = str(line.result);
      if (text) state.lastText = text;
      return [];
    }

    if (type === 'system') return [];
    return [{ kind: 'raw', line: JSON.stringify(line).slice(0, 500) }];
  },
};

/**
 * Normalized mode → qwen's spelling.
 *
 * `--approval-mode` is **undocumented in `qwen --help`** but real; its choices
 * (`plan | default | auto-edit | auto | yolo`) surface only by passing an
 * invalid value. `acceptEdits` maps to `auto-edit`, not `yolo`: `auto-edit`
 * registers the file-writing tools while withholding `run_shell_command`, which
 * is exactly what the normalized mode promises. Mapping it to `yolo` — as this
 * did until 2026-07-28 — handed out shell access to a session whose settings
 * panel said "Accept edits".
 *
 * `auto` is deliberately unused: despite the name it registers no more than
 * `default` does, so it would be a mode that reads permissive and acts
 * read-only.
 */
function mapMode(mode: TurnRequest['permissionMode']): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'auto-edit';
    case 'bypass':
      return 'yolo';
    default:
      return 'default';
  }
}

function mapBlock(block: unknown, state: TurnState): AgentEventBody[] {
  if (!isRecord(block)) return [];
  const t = str(block.type);
  if (t === 'text') {
    const text = str(block.text) ?? '';
    state.lastText = text;
    return [{ kind: 'text', text }];
  }
  if (t === 'thinking') {
    return [{ kind: 'thinking', text: str(block.thinking) ?? '' }];
  }
  if (t === 'tool_use') {
    const name = str(block.name) ?? 'tool';
    if (name === 'ask_user_question') state.sawQuestionTool = true;
    return [{ kind: 'tool_call', toolId: str(block.id) ?? '', name, input: block.input ?? null }];
  }
  return [];
}
