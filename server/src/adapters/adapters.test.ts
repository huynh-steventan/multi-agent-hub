import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurnRequest, TurnState } from './base.ts';
import { claudeAdapter } from './claude.ts';
import { kimiAdapter } from './kimi.ts';
import { qwenAdapter } from './qwen.ts';

function freshState(nativeSessionId: string | null = null): TurnState {
  return { nativeSessionId, lastText: '', sawQuestionTool: false, usage: null, endReason: null };
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    repo: '/tmp/repo',
    prompt: 'hello',
    nativeSessionId: null,
    model: null,
    permissionMode: 'default',
    ...over,
  };
}

// --- argv construction ------------------------------------------------------

test('claude never passes --bare, which would bypass subscription OAuth', () => {
  for (const mode of claudeAdapter.supportedModes) {
    const args = claudeAdapter.buildArgs(req({ permissionMode: mode }));
    assert.ok(!args.includes('--bare'), `--bare leaked into args for mode ${mode}`);
  }
});

test('claude requests stream-json with --verbose, which the CLI requires', () => {
  const args = claudeAdapter.buildArgs(req());
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--verbose'));
});

test('claude resumes by native session id when one is known', () => {
  const args = claudeAdapter.buildArgs(req({ nativeSessionId: 'abc-123' }));
  assert.equal(args[args.indexOf('--resume') + 1], 'abc-123');
});

test('claude maps bypass onto the CLI spelling bypassPermissions', () => {
  const args = claudeAdapter.buildArgs(req({ permissionMode: 'bypass' }));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('kimi passes the prompt on argv, last, because its -p takes a value', () => {
  const args = kimiAdapter.buildArgs(req({ prompt: 'do the thing' }));
  assert.equal(kimiAdapter.promptVia, 'argv');
  assert.equal(args[args.length - 2], '-p');
  assert.equal(args[args.length - 1], 'do the thing');
});

test('kimi advertises only the default mode, since -p rejects permission flags', () => {
  assert.deepEqual([...kimiAdapter.supportedModes], ['default']);
});

// --- default permission mode ------------------------------------------------

test('every adapter defaults to a mode it can actually honor', () => {
  for (const adapter of [claudeAdapter, kimiAdapter, qwenAdapter]) {
    assert.ok(
      adapter.supportedModes.includes(adapter.defaultMode),
      `${adapter.id} defaults to ${adapter.defaultMode}, which is not in supportedModes`,
    );
  }
});

test('the per-agent default modes are the intended postures', () => {
  // Fully permissive wherever it can be expressed, because a headless turn has
  // nobody to answer a prompt. Kimi's lone 'default' is already yolo in
  // practice, so all three end up at the same posture by different routes.
  assert.equal(claudeAdapter.defaultMode, 'bypass');
  assert.equal(qwenAdapter.defaultMode, 'bypass');
  assert.equal(kimiAdapter.defaultMode, 'default');
});

test('claude maps its default mode onto bypassPermissions', () => {
  const args = claudeAdapter.buildArgs(req({ permissionMode: claudeAdapter.defaultMode }));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('qwen turns yolo on for its default mode', () => {
  const args = qwenAdapter.buildArgs(req({ permissionMode: qwenAdapter.defaultMode }));
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'yolo');
});

test('qwen always states an approval mode, because omitting it is read-only', () => {
  // qwen drops run_shell_command/write_file/edit from the tool registry rather
  // than denying them, so an unstated mode is a silently crippled session.
  for (const mode of qwenAdapter.supportedModes) {
    const args = qwenAdapter.buildArgs(req({ permissionMode: mode }));
    assert.ok(args.includes('--approval-mode'), `no --approval-mode for ${mode}`);
  }
});

test('qwen maps acceptEdits to auto-edit, which withholds the shell', () => {
  // auto-edit registers edit/write_file/notebook_edit but not
  // run_shell_command — the promise the normalized mode makes. yolo here would
  // grant shell access to a session labelled "Accept edits".
  const args = qwenAdapter.buildArgs(req({ permissionMode: 'acceptEdits' }));
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'auto-edit');
});

test('qwen honors plan mode instead of silently ignoring it', () => {
  const args = qwenAdapter.buildArgs(req({ permissionMode: 'plan' }));
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'plan');
});

test('qwen resumes by session id and selects a model', () => {
  const args = qwenAdapter.buildArgs(req({ nativeSessionId: 'sess-9', model: 'qwen3.6-flash' }));
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-9');
  assert.equal(args[args.indexOf('-m') + 1], 'qwen3.6-flash');
});

// --- claude line mapping ----------------------------------------------------

test('claude maps an init frame and captures the session id', () => {
  const state = freshState();
  const out = claudeAdapter.mapLine(
    {
      type: 'system',
      subtype: 'init',
      session_id: 'sid-1',
      model: 'claude-opus-5',
      tools: ['Bash', 'Read'],
      slash_commands: ['init'],
    },
    state,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    kind: 'init',
    model: 'claude-opus-5',
    tools: ['Bash', 'Read'],
    slashCommands: ['init'],
    nativeSessionId: 'sid-1',
  });
  assert.equal(state.nativeSessionId, 'sid-1');
});

test('claude maps text, thinking and tool_use blocks from one assistant frame', () => {
  const state = freshState();
  const out = claudeAdapter.mapLine(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'here you go' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    state,
  );
  assert.deepEqual(out.map((e) => e.kind), ['thinking', 'text', 'tool_call']);
  assert.equal(state.lastText, 'here you go');
});

test('claude flags the ask-user tool so the turn is reported as awaiting input', () => {
  const state = freshState();
  claudeAdapter.mapLine(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: {} }] } },
    state,
  );
  assert.equal(state.sawQuestionTool, true);
});

test('claude records usage and cost from the result frame', () => {
  const state = freshState();
  claudeAdapter.mapLine(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.019,
      usage: { input_tokens: 10, output_tokens: 39, cache_read_input_tokens: 20372 },
    },
    state,
  );
  assert.equal(state.usage?.inputTokens, 10);
  assert.equal(state.usage?.outputTokens, 39);
  assert.equal(state.usage?.cachedTokens, 20372);
  assert.equal(state.usage?.costUsd, 0.019);
  assert.equal(state.lastText, 'done');
});

test('claude marks an errored result so the turn does not report success', () => {
  const state = freshState();
  claudeAdapter.mapLine({ type: 'result', is_error: true, usage: {} }, state);
  assert.equal(state.endReason, 'error');
});

// --- kimi line mapping ------------------------------------------------------

test('kimi maps OpenAI-shaped tool calls and parses their JSON arguments', () => {
  const state = freshState();
  const out = kimiAdapter.mapLine(
    {
      role: 'assistant',
      tool_calls: [{ type: 'function', id: 'tool_1', function: { name: 'Read', arguments: '{"path":"f.txt"}' } }],
    },
    state,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { kind: 'tool_call', toolId: 'tool_1', name: 'Read', input: { path: 'f.txt' } });
});

test('kimi keeps unparseable tool arguments as raw text rather than dropping them', () => {
  const state = freshState();
  const out = kimiAdapter.mapLine(
    { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'T', arguments: 'not json' } }] },
    state,
  );
  assert.equal(out[0]?.kind, 'tool_call');
  assert.equal(out[0]!.kind === 'tool_call' ? out[0].input : null, 'not json');
});

test('kimi maps a tool role frame to a tool result', () => {
  const out = kimiAdapter.mapLine({ role: 'tool', tool_call_id: 'tool_1', content: '1\thello' }, freshState());
  assert.deepEqual(out[0], { kind: 'tool_result', toolId: 'tool_1', content: '1\thello', isError: false });
});

test('kimi captures its session id from the trailing resume hint', () => {
  const state = freshState();
  const out = kimiAdapter.mapLine(
    { role: 'meta', type: 'session.resume_hint', session_id: 'session_abc' },
    state,
  );
  assert.deepEqual(out, []);
  assert.equal(state.nativeSessionId, 'session_abc');
});

// --- qwen line mapping ------------------------------------------------------

test('qwen maps its Claude-shaped init frame', () => {
  const state = freshState();
  const out = qwenAdapter.mapLine(
    { type: 'system', subtype: 'init', session_id: 'q1', model: 'qwen3.6-flash', tools: [], slash_commands: [] },
    state,
  );
  assert.equal(out[0]?.kind, 'init');
  assert.equal(state.nativeSessionId, 'q1');
});

test('qwen reports token totals but no per-turn USD, since it bills a token plan', () => {
  const state = freshState();
  qwenAdapter.mapLine(
    { type: 'result', is_error: false, result: 'OK', usage: { input_tokens: 31599, output_tokens: 202, total_tokens: 31801 } },
    state,
  );
  assert.equal(state.usage?.totalTokens, 31801);
  assert.equal(state.usage?.costUsd, null);
});

test('every adapter surfaces unrecognized lines instead of silently dropping them', () => {
  for (const adapter of [claudeAdapter, kimiAdapter, qwenAdapter]) {
    const out = adapter.mapLine({ type: 'totally-unknown', role: 'nonsense' }, freshState());
    assert.equal(out[0]?.kind, 'raw', `${adapter.id} dropped an unknown line`);
  }
});
