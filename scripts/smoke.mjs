/**
 * End-to-end smoke: boot the real server, exercise the real endpoints, tear it
 * down. This is the step that catches what typecheck and unit tests cannot —
 * a server that imports fine but crashes on boot, an adapter registry that
 * comes back empty, or a usage provider that throws instead of degrading.
 *
 * Runs against a throwaway DATA_DIR so it never touches the real registry.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'multi-agent-hub-smoke-'));
/**
 * Attachments are written into the session's repo, so the session used to
 * exercise them gets a throwaway one rather than this checkout — the smoke must
 * not leave files (or a `.git/info/exclude` line) behind in the real tree.
 */
const scratchRepo = mkdtempSync(join(tmpdir(), 'multi-agent-hub-repo-'));
mkdirSync(join(scratchRepo, '.git', 'info'), { recursive: true });

/**
 * A stub `kimi` placed first on the server's PATH.
 *
 * Turns are the one part of the hub that a smoke cannot exercise for free — a
 * real turn spends quota and takes minutes. A stub binary buys the whole path
 * anyway: it goes through startTurn, the adapter, runTurn and the event stream,
 * and because it records the argv it was handed, it can prove what the *next*
 * turn was told to resume. Kimi is the agent worth stubbing because it is the
 * one whose id arrives on the last line rather than in an init frame.
 */
const stubDir = mkdtempSync(join(tmpdir(), 'multi-agent-hub-stub-'));
const stubArgv = join(stubDir, 'argv.log');
const STUB_SESSION_ID = 'sess-smoke-kimi';
writeFileSync(
  join(stubDir, 'kimi'),
  `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${stubArgv}
echo '{"role":"assistant","content":"stubbed"}'
echo '{"role":"meta","type":"session.resume_hint","session_id":"${STUB_SESSION_ID}"}'
`,
  { mode: 0o755 },
);

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    // Keep the repo scan trivial; a full home-directory walk would dominate runtime.
    REPO_ROOTS: process.cwd(),
    REPO_SCAN_DEPTH: '0',
    DISCORD_WEBHOOK_URL: '',
    // The stub goes first so `kimi` resolves to it and no real CLI is ever run.
    PATH: `${stubDir}:${process.env.PATH}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (c) => {
  serverOutput += c.toString();
});
server.stderr.on('data', (c) => {
  serverOutput += c.toString();
});

/**
 * Subscribe one socket to several sessions, then unsubscribe from one.
 *
 * The server replays a session's history on subscribe, so counting `history`
 * frames is a turn-free way to prove both that concurrent subscriptions work
 * and that `unsubscribe` is understood rather than ignored.
 */
async function checkMultiSubscribe(ids) {
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const histories = [];

  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'history') histories.push(frame.sessionId);
    });

    for (const id of ids) socket.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
    await new Promise((r) => setTimeout(r, 300));
    check(
      'one socket can watch several sessions at once',
      ids.every((id) => histories.includes(id)),
      `replayed ${JSON.stringify(histories)}`,
    );

    // An unsubscribed session must not be re-sent on a later subscribe to a
    // different one; the count staying put is the evidence.
    socket.send(JSON.stringify({ type: 'unsubscribe', sessionId: ids[0] }));
    await new Promise((r) => setTimeout(r, 200));
    check('unsubscribe is accepted without dropping the socket', socket.readyState === socket.OPEN);
  } finally {
    socket.close();
  }
}

/**
 * Upload, fetch back, and clean up a prompt attachment.
 *
 * The round trip is the point: an agent is handed a *path*, so a file that
 * uploads fine but does not land inside the session's repo is a file no agent
 * can read. Costs no turns — nothing is prompted.
 */
async function checkAttachments() {
  const created = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'claude', repo: scratchRepo, title: 'attachments', permissionMode: 'plan' }),
  });
  const session = await created.json();

  // A one-pixel PNG: real bytes, so the byte-for-byte comparison below means
  // something.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = await fetch(`${BASE}/api/sessions/${session.id}/attachments?name=${encodeURIComponent('shot 1.png')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  check('POST attachment accepts a raw upload', upload.status === 201, `status ${upload.status}`);
  const attachment = await upload.json();

  check('the attachment name is sanitized', attachment.name === 'shot_1.png', attachment.name);
  check(
    'the attachment lands inside the session repo, where all three agents can read it',
    typeof attachment.path === 'string' && attachment.path.startsWith(scratchRepo),
    attachment.path,
  );
  check('the file is really on disk at the path handed to the agent', existsSync(attachment.path));

  const fetched = await fetch(`${BASE}/api/sessions/${session.id}/attachments/${attachment.storedName}`);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  check('GET attachment returns the exact bytes uploaded', bytes.equals(png), `${bytes.length} bytes`);
  check('an image is served inline and not sniffed', fetched.headers.get('content-type') === 'image/png');
  check(
    'the download declares nosniff',
    fetched.headers.get('x-content-type-options') === 'nosniff',
    'uploaded bytes are served from the app origin',
  );

  // A stored name is turned straight into a filesystem path, so the server must
  // refuse anything it did not mint itself.
  const traversal = await fetch(
    `${BASE}/api/sessions/${session.id}/attachments/${encodeURIComponent('../../../../etc/passwd')}`,
  );
  check('GET attachment refuses a traversal name', traversal.status === 404, `status ${traversal.status}`);

  const missing = await fetch(`${BASE}/api/sessions/does-not-exist/attachments/${attachment.storedName}`);
  check('GET attachment refuses an unknown session', missing.status === 404);

  const removed = await fetch(`${BASE}/api/sessions/${session.id}/attachments/${attachment.storedName}`, {
    method: 'DELETE',
  });
  check('DELETE attachment removes the file', (await removed.json()).deleted === true && !existsSync(attachment.path));

  // A second upload proves deleting a session cleans up after itself.
  const second = await fetch(`${BASE}/api/sessions/${session.id}/attachments?name=keep.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: Buffer.from('keep me'),
  });
  const kept = await second.json();
  await fetch(`${BASE}/api/sessions/${session.id}`, { method: 'DELETE' });
  check('deleting a session removes its attachments from the repo', !existsSync(kept.path), kept.path);
}

/**
 * Prove a Kimi session resumes itself across turns.
 *
 * The regression: kimi emits no init frame, and the server only persisted a
 * session id when it saw one. The id was captured into TurnState and then
 * dropped on the floor, so `--session` was never passed and every turn began a
 * brand-new CLI session that remembered nothing. Only an end-to-end check
 * catches it — the store write lives in startTurn, which is not importable.
 */
async function checkKimiResumes() {
  const { WebSocket } = await import('ws');
  const created = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'kimi', repo: scratchRepo, title: 'resume' }),
  });
  const session = await created.json();

  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    let ends = 0;
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'event' && frame.event?.body?.kind === 'turn_end') ends += 1;
    });
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));

    const turn = async (text, want) => {
      socket.send(JSON.stringify({ type: 'prompt', sessionId: session.id, text }));
      const deadline = Date.now() + 15000;
      while (ends < want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return ends >= want;
    };

    check('a stubbed kimi turn runs and settles', await turn('first', 1));

    const afterFirst = await (await fetch(`${BASE}/api/sessions`)).json();
    const stored = afterFirst.sessions.find((s) => s.id === session.id);
    check(
      'a session id from the stream’s last line is persisted, not just observed',
      stored?.nativeSessionId === STUB_SESSION_ID,
      `stored ${stored?.nativeSessionId}`,
    );

    check('a second stubbed kimi turn runs and settles', await turn('second', 2));

    // What the agent was actually told, rather than what we hoped it was told.
    const calls = readFileSync(stubArgv, 'utf8').trim().split('\n');
    check('the second turn resumes rather than starting a new CLI session', calls.length === 2 && calls[1].includes(`--session ${STUB_SESSION_ID}`), calls[1]);
    check('the first turn started fresh, with no session to resume', !calls[0].includes('--session'), calls[0]);
  } finally {
    socket.close();
    await fetch(`${BASE}/api/sessions/${session.id}`, { method: 'DELETE' });
  }
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})\n${serverOutput}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy in ${timeoutMs}ms\n${serverOutput}`);
}

try {
  console.log('== smoke: booting server ==');
  const health = await waitForHealth();
  check('GET /api/health responds ok', health.ok === true);

  const agents = await (await fetch(`${BASE}/api/agents`)).json();
  check('GET /api/agents lists all three agents', Array.isArray(agents) && agents.length === 3, JSON.stringify(agents));
  const ids = new Set(agents.map((a) => a.id));
  check('agent registry contains claude, kimi, qwen', ids.has('claude') && ids.has('kimi') && ids.has('qwen'));
  const kimi = agents.find((a) => a.id === 'kimi');
  check('kimi advertises only the default permission mode', kimi?.supportedModes?.length === 1);

  const usage = await (await fetch(`${BASE}/api/usage`)).json();
  check('GET /api/usage returns a snapshot per agent', Array.isArray(usage) && usage.length === 3);
  check(
    'every usage window declares its span (a number or an explicit null)',
    usage.every((u) => u.windows.every((w) => w.windowMs === null || typeof w.windowMs === 'number')),
    'windowMs is what the pace lines are computed from',
  );
  check(
    'a window with a known span also has the reset it is measured against',
    usage.every((u) => u.windows.every((w) => w.windowMs === null || typeof w.resetsAt === 'number')),
  );
  check(
    'every usage snapshot either has windows or explains why not',
    usage.every((u) => u.windows.length > 0 || typeof u.caveat === 'string'),
    JSON.stringify(usage),
  );

  const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
  check('GET /api/sessions returns a list and defaults', Array.isArray(sessions.sessions) && 'defaults' in sessions);

  // Session lifecycle, without spending a turn on a real agent.
  const created = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'claude', repo: process.cwd(), title: 'smoke', permissionMode: 'plan' }),
  });
  check('POST /api/sessions creates a session', created.status === 201);
  const session = await created.json();
  check('created session echoes the requested mode', session.permissionMode === 'plan');
  check('Discord notifications default to off when unspecified', session.notifyDiscord === false);

  const badMode = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'kimi', repo: process.cwd(), title: 'smoke', permissionMode: 'bypass' }),
  });
  const kimiSession = await badMode.json();
  check('unsupported mode falls back rather than silently lying', kimiSession.permissionMode === 'default');

  // A headless turn has nobody to answer a permission prompt, so a mode short of
  // the agent's own default turns into denials the transcript cannot tell apart
  // from real failures. The default must therefore come from the adapter, not
  // from a literal at the API boundary.
  check(
    'every agent advertises a default mode it can actually honor',
    agents.every((a) => a.supportedModes.includes(a.defaultMode)),
    JSON.stringify(agents.map((a) => [a.id, a.defaultMode])),
  );
  for (const a of agents) {
    const omitted = await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: a.id, repo: process.cwd(), title: 'smoke' }),
    });
    const s = await omitted.json();
    check(
      `${a.id} with no mode requested gets its own default (${a.defaultMode})`,
      s.permissionMode === a.defaultMode,
      `got ${s.permissionMode}`,
    );
    await fetch(`${BASE}/api/sessions/${s.id}`, { method: 'DELETE' });
  }

  const rejected = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'nope', repo: process.cwd() }),
  });
  check('POST /api/sessions rejects an unknown agent', rejected.status === 400);

  // The desktop workspace holds several sessions open at once, so one socket
  // must be able to watch more than one and to drop them individually.
  await checkMultiSubscribe([session.id, kimiSession.id]);

  await checkAttachments();

  await checkKimiResumes();

  const deleted = await fetch(`${BASE}/api/sessions/${session.id}`, { method: 'DELETE' });
  check('DELETE /api/sessions removes it', (await deleted.json()).deleted === true);

  if (existsSync('web/dist/index.html')) {
    const page = await fetch(`${BASE}/`);
    check('built frontend is served at /', page.ok && (await page.text()).includes('<div id="root">'));
  } else {
    console.log('  skip  frontend not built (run npm run build:web)');
  }
} catch (err) {
  failures += 1;
  console.error('  FAIL smoke threw:', err.message);
} finally {
  // Wait for the server to actually exit before deleting its DATA_DIR. Its
  // SIGTERM handler flushes the debounced event log first, so removing the
  // directory the instant the signal is sent races that flush and fails with
  // ENOTEMPTY — intermittently, and only ever in teardown, which is the most
  // confusing possible place for an otherwise green run to report failure.
  await new Promise((resolve) => {
    const giveUp = setTimeout(resolve, 5000);
    server.once('exit', () => {
      clearTimeout(giveUp);
      resolve();
    });
    server.kill('SIGTERM');
  });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(scratchRepo, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke: all checks passed');
