import type { AgentEventBody } from '../../../shared/protocol.ts';
import { clipToolResult, type AgentAdapter, type TurnRequest, type TurnState } from './base.ts';

/**
 * Claude Code adapter.
 *
 * Emits the richest stream of the three: a `system/init` frame carrying the
 * model and tool list, `assistant` frames whose content is an Anthropic block
 * array, and a terminal `result` frame with usage and cost.
 *
 * `--bare` is deliberately never passed: that mode ignores OAuth entirely and
 * demands ANTHROPIC_API_KEY, which would move turns off the subscription.
 */
export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  command: 'claude',
  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5-20251001'],
  supportedModes: ['default', 'plan', 'acceptEdits', 'bypass'],
  // `--permission-mode bypassPermissions` — approve everything. The weaker
  // `acceptEdits` covers file writes only, so a Bash command the CLI would have
  // prompted about is still denied on a headless turn, and a denial is
  // indistinguishable from a genuine failure in the transcript. The hub only
  // ever points an agent at a repo the operator picked on their own machine,
  // which is the trusted-repo precondition this mode asks for.
  defaultMode: 'bypass',
  promptVia: 'stdin',

  buildArgs(req: TurnRequest): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (req.nativeSessionId) args.push('--resume', req.nativeSessionId);
    if (req.model) args.push('--model', req.model);
    args.push('--permission-mode', mapMode(req.permissionMode));
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
      // Tool results come back wrapped in a synthetic user message.
      const message = isRecord(line.message) ? line.message : null;
      const content = message && Array.isArray(message.content) ? message.content : [];
      return content.flatMap((block) => mapToolResultBlock(block));
    }

    if (type === 'result') {
      state.usage = {
        inputTokens: num(pick(line.usage, 'input_tokens')),
        outputTokens: num(pick(line.usage, 'output_tokens')),
        cachedTokens: num(pick(line.usage, 'cache_read_input_tokens')),
        totalTokens: null,
        costUsd: num(line.total_cost_usd),
      };
      if (line.is_error === true) state.endReason = 'error';
      const text = str(line.result);
      if (text) state.lastText = text;
      return [];
    }

    // system/thinking_tokens, rate_limit_event, etc. — recognized, not shown.
    if (type === 'system' || type === 'rate_limit_event') return [];
    return [{ kind: 'raw', line: JSON.stringify(line).slice(0, 500) }];
  },
};

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
    if (name === 'AskUserQuestion') state.sawQuestionTool = true;
    return [{ kind: 'tool_call', toolId: str(block.id) ?? '', name, input: block.input ?? null }];
  }
  return [];
}

function mapToolResultBlock(block: unknown): AgentEventBody[] {
  if (!isRecord(block) || str(block.type) !== 'tool_result') return [];
  return [
    {
      kind: 'tool_result',
      toolId: str(block.tool_use_id) ?? '',
      content: clipToolResult(stringifyContent(block.content)),
      isError: block.is_error === true,
    },
  ];
}

function mapMode(mode: TurnRequest['permissionMode']): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'bypass':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

// --- narrow helpers, shared in spirit with the other adapters ---------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
export function pick(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}
export function stringifyContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
      .join('\n');
  }
  return v == null ? '' : JSON.stringify(v);
}
