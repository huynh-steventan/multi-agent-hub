import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// DATA_DIR is read when config.ts is first imported, so it has to be set before
// the store is pulled in. `config` only fills in values not already present, so
// this wins over the repo's .env.
const dataDir = mkdtempSync(join(tmpdir(), 'multi-agent-hub-store-'));
process.env.DATA_DIR = dataDir;

const { Store } = await import('./store.ts');

after(() => rmSync(dataDir, { recursive: true, force: true }));

function newSession(store: InstanceType<typeof Store>) {
  return store.createSession({
    agent: 'claude',
    repo: process.cwd(),
    title: 'restart test',
    model: null,
    permissionMode: 'default',
    notifyDiscord: false,
  });
}

test('a restart keeps each session and its transcript', async () => {
  const first = new Store();
  await first.load();
  const session = newSession(first);
  first.appendEvent(session.id, { kind: 'text', text: '> do the thing' });
  first.appendEvent(session.id, { kind: 'text', text: 'on it' });
  await first.flush();

  // A second instance over the same directory is what a redeploy looks like.
  const second = new Store();
  await second.load();

  assert.equal(second.get(session.id)?.title, 'restart test');
  const history = second.history(session.id);
  assert.equal(history.length, 2, 'the event log survives the restart');
  assert.deepEqual(
    history.map((e) => (e.body.kind === 'text' ? e.body.text : e.body.kind)),
    ['> do the thing', 'on it'],
  );

  // Sequence numbers continue rather than restarting and colliding.
  const next = second.appendEvent(session.id, { kind: 'text', text: 'done' });
  assert.equal(next.seq, 3);
  assert.equal(new Set(second.history(session.id).map((e) => e.seq)).size, 3, 'no duplicate sequence numbers');

  await second.flush();
});

test('deleting a session takes its transcript with it', async () => {
  const first = new Store();
  await first.load();
  const session = newSession(first);
  first.appendEvent(session.id, { kind: 'text', text: 'transient' });
  await first.flush();
  first.deleteSession(session.id);
  await first.flush();

  const second = new Store();
  await second.load();
  assert.equal(second.get(session.id), undefined);
  assert.deepEqual(second.history(session.id), []);
});

test('a running session comes back idle, not stuck mid-turn', async () => {
  const first = new Store();
  await first.load();
  const session = newSession(first);
  first.updateSession(session.id, { status: 'running' });
  await first.flush();

  const second = new Store();
  await second.load();
  assert.equal(second.get(session.id)?.status, 'idle');
});
