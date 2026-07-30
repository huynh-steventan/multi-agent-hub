# ADAPTERS.md — the CLI adapter interface

Everything an agent-specific behavior can live in is here. Nothing above `server/src/adapters/` may
branch on `agent === 'x'` for protocol reasons; if you find yourself wanting to, the thing you want
belongs in the adapter.

## The interface

```ts
export interface AgentAdapter {
  id: AgentId;
  command: string;                          // executable, resolved on PATH
  models: readonly string[];                // offered in the UI picker
  supportedModes: readonly PermissionMode[];// modes this CLI can actually honor
  defaultMode: PermissionMode;              // must be a member of supportedModes
  promptVia: 'stdin' | 'argv';
  buildArgs(req: TurnRequest): string[];
  mapLine(line: unknown, state: TurnState): AgentEventBody[];
}
```

`runTurn()` in [`base.ts`](../server/src/adapters/base.ts) owns everything else: spawning, process-group
signalling, line parsing, the terminal `turn_end`, and inferring `awaiting_input` vs `completed`.
An adapter is a description of a dialect, not a driver.

### `mapLine` contract

Called once per parsed line of the CLI's stdout. Returns the normalized events that line produces —
an **empty array means "recognized, not worth showing"**, which is different from not handling it.
Anything unrecognized should fall through to `{ kind: 'raw' }` rather than being dropped: a silent
drop is unfalsifiable, and a visible raw line is how you discover a dialect change.

Accumulate cross-line state on `state` (session id, last text, usage, whether an ask-the-user tool
appeared). `mapLine` may throw; the runner catches it and emits an error event rather than killing
the turn.

### `defaultMode` is per-adapter on purpose

A headless turn has nobody to answer a permission prompt, so anything requiring approval is
auto-denied — and a denial is indistinguishable from a real failure downstream. The posture that
makes an agent *useful* is therefore the one it can actually act under, and that differs per CLI.
`adapters.test.ts` asserts `defaultMode ∈ supportedModes`.

## The three shipped dialects

| | claude | kimi | qwen |
|---|---|---|---|
| headless | `-p` | `-p <prompt>` | `-p` |
| stream | `--output-format stream-json` **+ `--verbose`** | `--output-format stream-json` | `-o stream-json` |
| resume | `--resume <id>` | `--session <id>` | `--resume <id>` |
| prompt via | stdin | **argv only** | stdin |
| permission flag | `--permission-mode` | *none — rejects them under `-p`* | `--approval-mode` |
| envelope | Anthropic blocks | OpenAI chat-completion | Anthropic blocks |
| init frame | yes | **no** | yes |
| session id arrives | init frame | **last line** (`meta` resume hint) | init frame |
| token usage | yes | **none** | yes |

Non-obvious facts, each of which cost a debugging session:

- **`claude` requires `--verbose`** alongside `--output-format stream-json` under `--print`, or it
  exits with an error. It is not implied by the flag.
- **`kimi`'s `-p` rejects `--yolo`, `--auto`, and `--plan`.** Permission mode is not selectable for
  headless Kimi turns, which is why it advertises exactly one mode. It costs nothing: headless `-p`
  is already fully permissive. Do not try to buy the same posture by sending `/yolo` as a first
  turn — it answers "Yolo mode is already active" and spends real quota to learn nothing.
- **`qwen` removes tools rather than denying them.** Under `--approval-mode default` the model is
  never offered `run_shell_command`, `write_file`, `edit`, `notebook_edit` or `monitor` at all, and
  correctly reports it has no way to write or run anything. An *omitted* flag is therefore not
  "leave it to the operator's config" — it is a silent read-only session. The adapter passes the
  flag unconditionally. Measured from the init frame's `tools[]`:

  | `--approval-mode` | tools | vs `yolo` |
  |---|---|---|
  | `plan`, `default`, `auto` | 58 | no `edit`, `write_file`, `notebook_edit`, `run_shell_command`, `monitor` |
  | `auto-edit` | 61 | no `run_shell_command`, `monitor` |
  | `yolo` | 63 | — |

  Note `auto` registers no more than `default` despite the name, so it is deliberately unused — it
  would be a mode that reads permissive and acts read-only. `acceptEdits` maps to `auto-edit`, not
  `yolo`: mapping it to `yolo` hands shell access to a session whose settings panel says "Accept
  edits". `--approval-mode` is **undocumented in `qwen --help`**; its choices surface only by passing
  an invalid value.
- **`claude` gates by denying calls, never by withholding tools** — its registry is identical under
  all four permission modes, so `init.tools` says nothing about what a mode will actually permit.
  The structural opposite of qwen.

## Adding a fourth CLI

1. Confirm it can do the three things the model depends on: **headless prompt**, **streaming
   structured output**, and **session resume by id**. Without resume there is no conversation, only
   a sequence of unrelated turns.
2. Write the adapter. Start from [`qwen.ts`](../server/src/adapters/qwen.ts) if its envelope is
   Anthropic-shaped, [`kimi.ts`](../server/src/adapters/kimi.ts) if it is OpenAI-shaped.
3. Add its id to `AGENT_IDS` in [`shared/protocol.ts`](../shared/protocol.ts) and register it in
   [`adapters/index.ts`](../server/src/adapters/index.ts). The UI picks it up from `/api/agents`;
   there is no frontend list to update.
4. Optionally add a usage provider in `server/src/usage/`. It must never throw and never fabricate —
   return empty windows with a `caveat` instead. `USAGE_PROVIDERS` gates it automatically.
5. Capture real CLI output and unit-test `mapLine` against it. Do not trust an agent's own account
   of its capabilities — probe the binary and read the frames.

**Verify behavior, don't infer it.** A headless permission denial arrives as an ordinary tool result
with `isError: true` and reads, from inside the session, as a *missing capability* — agents will
tell you the harness gave them no shell tool when in fact the tool was offered and the call denied.
The only reliable evidence is running the exact argv against a scratch directory and checking the
filesystem afterwards.
