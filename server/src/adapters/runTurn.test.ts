import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentEventBody } from '../../../shared/protocol.ts';
import { runTurn, type AgentAdapter, type TurnRequest, type TurnState } from './base.ts';
import { kimiAdapter } from './kimi.ts';

/**
 * A stand-in for a CLI that is really a launcher.
 *
 * This is the shape that broke Stop in practice: `qwen`'s bin does not run the
 * agent, it spawns it, and the agent spawns more (`caffeinate`). Signalling only
 * the process we spawned left that tree alive holding the stdout pipe, so the
 * turn never settled. `script` runs under `bash -c`, which stands in for the
 * launcher; whatever it backgrounds stands in for the real agent.
 */
function fakeAdapter(script: string): AgentAdapter {
  return {
    id: 'claude',
    command: 'bash',
    models: [],
    supportedModes: ['default'],
    defaultMode: 'default',
    promptVia: 'stdin',
    buildArgs: () => ['-c', script],
    mapLine: () => [],
  };
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    repo: process.cwd(),
    prompt: '',
    nativeSessionId: null,
    model: null,
    permissionMode: 'default',
    ...over,
  };
}

/** Poll until `check` passes, so tests never race a process still starting. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never became true');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function grandchildPid(pidFile: string): Promise<number> {
  await until(async () => {
    const text = await readFile(pidFile, 'utf8').catch(() => '');
    return text.trim().length > 0;
  });
  return Number((await readFile(pidFile, 'utf8')).trim());
}

/**
 * Kimi's real mapping driven by a scripted stdout.
 *
 * Uses `kimiAdapter.mapLine` rather than a hand-written stand-in because the
 * point of these tests is the seam between a dialect that names its session late
 * and a caller that has to hear about it — a fake mapper would only prove the
 * fake works. `onMapped` fires after each line so a test can act mid-stream.
 */
function scriptedKimi(script: string, onMapped: (state: TurnState) => void = () => {}): AgentAdapter {
  return {
    ...kimiAdapter,
    command: 'bash',
    promptVia: 'stdin',
    buildArgs: () => ['-c', script],
    mapLine(line, state) {
      const out = kimiAdapter.mapLine(line, state);
      onMapped(state);
      return out;
    },
  };
}

/** Kimi's actual last line: no init frame ever preceded it. */
const RESUME_HINT = `{"role":"meta","type":"session.resume_hint","session_id":"sess-late"}`;

test('a session id disclosed on the stream’s last line still reaches the caller', async () => {
  // The regression this guards: the id used to live only in TurnState, which
  // runTurn never exposed, so the only way out was an init event — and kimi
  // emits none. Every kimi turn therefore resumed nothing and started a new CLI
  // session, losing the conversation each time.
  const handle = runTurn(scriptedKimi(`echo '${RESUME_HINT}'`), req(), () => {});
  const outcome = await handle.done;

  assert.equal(outcome.nativeSessionId, 'sess-late');
});

test('an interrupted turn still reports the session id it had learned', async () => {
  // Stop does not undo the CLI session the turn created; dropping its id here
  // would strand that session's context permanently.
  let learned = false;
  const handle = runTurn(
    scriptedKimi(`echo '${RESUME_HINT}'; sleep 30`, (state) => {
      if (state.nativeSessionId) learned = true;
    }),
    req(),
    () => {},
  );

  await until(async () => learned);
  handle.interrupt();
  const outcome = await handle.done;

  assert.equal(outcome.nativeSessionId, 'sess-late');
});

test('a turn that names no session reports null rather than inventing one', async () => {
  const outcome = await runTurn(scriptedKimi('echo hi'), req(), () => {}).done;

  assert.equal(outcome.nativeSessionId, null);
});

test('a resumed turn keeps its id even when the CLI does not repeat it', async () => {
  // Kimi only emits the hint when it feels like it; the id the turn was started
  // with must survive a stream that never mentions one, or the next turn would
  // fall back to a fresh session.
  const outcome = await runTurn(scriptedKimi('echo hi'), req({ nativeSessionId: 'sess-prior' }), () => {}).done;

  assert.equal(outcome.nativeSessionId, 'sess-prior');
});

test('interrupt kills the whole process tree, not just the process we spawned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-hub-turn-'));
  const pidFile = join(dir, 'pid');

  // The backgrounded node process is the "real agent": it outlives the launcher
  // and inherits stdout, exactly like the CLI behind a shim.
  const handle = runTurn(
    fakeAdapter(`node -e 'setInterval(() => {}, 1000)' & echo $! > ${pidFile}; sleep 30`),
    req(),
    () => {},
  );

  const pid = await grandchildPid(pidFile);
  assert.ok(alive(pid), 'the stand-in agent should be running before interrupt');

  handle.interrupt();
  await handle.done;

  await until(async () => !alive(pid));
  assert.ok(!alive(pid), 'interrupt left the real agent running');
});

test('interrupt settles the turn with exactly one interrupted turn_end', async () => {
  const events: AgentEventBody[] = [];
  const handle = runTurn(fakeAdapter('sleep 30'), req(), (b) => events.push(b));

  handle.interrupt();
  handle.interrupt(); // idempotent: pressing Stop twice must not double-settle
  await handle.done;

  const ends = events.filter((e) => e.kind === 'turn_end');
  assert.equal(ends.length, 1, 'a turn must emit exactly one terminal event');
  const end = ends[0];
  assert.ok(end?.kind === 'turn_end');
  assert.equal(end.reason, 'interrupted');
});

test('interrupt still settles when the turn ignores SIGTERM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-hub-turn-'));
  const pidFile = join(dir, 'pid');

  // Refuses to die politely, so settling depends on the SIGKILL escalation
  // rather than on the CLI cooperating. Without it, Stop wedges the session at
  // "running" and every later prompt is refused.
  const handle = runTurn(
    fakeAdapter(
      `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' & echo $! > ${pidFile}; sleep 30`,
    ),
    req(),
    () => {},
  );

  const pid = await grandchildPid(pidFile);
  handle.interrupt();
  await handle.done;

  await until(async () => !alive(pid));
  assert.ok(!alive(pid), 'a SIGTERM-ignoring turn survived interrupt');
});
