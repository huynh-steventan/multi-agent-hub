import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { SessionRecord } from '../../shared/protocol.ts';
import {
  attachmentsDir,
  composePrompt,
  deleteAttachment,
  deleteSessionAttachments,
  ensureGitIgnored,
  findAttachment,
  isInlineType,
  mimeForName,
  sanitizeName,
  saveAttachment,
} from './attachments.ts';

const root = mkdtempSync(join(tmpdir(), 'multi-agent-hub-attach-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function newRepo(): string {
  const repo = join(root, `repo-${n++}`);
  mkdirSync(repo, { recursive: true });
  return repo;
}

function newSession(repo: string): SessionRecord {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    agent: 'claude',
    repo,
    title: 'attachment test',
    nativeSessionId: null,
    model: null,
    permissionMode: 'default',
    notifyDiscord: false,
    createdAt: 0,
    lastActiveAt: 0,
    status: 'idle',
  };
}

test('a filename cannot carry a path out of the attachment directory', () => {
  assert.equal(sanitizeName('../../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('/etc/shadow'), 'shadow');
  assert.equal(sanitizeName('..'), 'attachment', 'a name of pure dots is not a name');
  assert.equal(sanitizeName('.bashrc'), 'bashrc', 'no attachment is written hidden');
  assert.equal(sanitizeName(''), 'attachment');
  assert.equal(sanitizeName('Screen Shot 2026-07-28 at 10.31.png'), 'Screen_Shot_2026-07-28_at_10.31.png');
});

test('a stored name that did not come from the server is refused', async () => {
  const repo = newRepo();
  const session = newSession(repo);
  const saved = await saveAttachment(session, 'notes.txt', 'text/plain', Buffer.from('hello'));

  assert.equal((await findAttachment(session, saved.storedName))?.name, 'notes.txt');

  // Traversal, absolute paths, and names lacking the server's own prefix all
  // resolve to nothing rather than to a file somewhere else on the disk.
  for (const bad of [
    '../../../../etc/passwd',
    '..%2F..%2Fetc%2Fpasswd',
    '/etc/passwd',
    'notes.txt',
    'deadbeef-../escape',
    '../11111111-2222-3333-4444-555555555555/notes.txt',
  ]) {
    assert.equal(await findAttachment(session, bad), null, `${bad} must not resolve`);
    assert.equal(await deleteAttachment(session, bad), false, `${bad} must not delete`);
  }
});

test('an attachment lands inside the repo, where every agent can read it', async () => {
  const repo = newRepo();
  const session = newSession(repo);
  const saved = await saveAttachment(session, 'diagram.png', 'image/png', Buffer.from([1, 2, 3]));

  assert.ok(saved.path.startsWith(repo), 'qwen has no --add-dir, so outside the repo is unreadable to it');
  assert.equal(saved.path, join(attachmentsDir(session), saved.storedName));
  assert.equal(saved.size, 3);
  assert.equal(saved.mimeType, 'image/png');
  assert.deepEqual([...readFileSync(saved.path)], [1, 2, 3]);

  assert.equal(await deleteAttachment(session, saved.storedName), true);
  assert.equal(await findAttachment(session, saved.storedName), null);
});

test('two pastes of the same name are two distinct files', async () => {
  const repo = newRepo();
  const session = newSession(repo);
  // Every clipboard screenshot arrives called `image.png`, so this is the
  // normal case rather than an edge one.
  const first = await saveAttachment(session, 'image.png', 'image/png', Buffer.from('a'));
  const second = await saveAttachment(session, 'image.png', 'image/png', Buffer.from('bb'));

  assert.notEqual(first.storedName, second.storedName);
  assert.equal(first.name, 'image.png');
  assert.equal(second.name, 'image.png');
  assert.equal((await findAttachment(session, first.storedName))?.size, 1);
  assert.equal((await findAttachment(session, second.storedName))?.size, 2);
});

test('deleting a session takes its attachments with it', async () => {
  const repo = newRepo();
  const session = newSession(repo);
  const saved = await saveAttachment(session, 'a.txt', 'text/plain', Buffer.from('x'));

  await deleteSessionAttachments(session);
  assert.equal(await findAttachment(session, saved.storedName), null);
});

test('the hub keeps its scratch directory out of the operator’s git status', async () => {
  const repo = newRepo();
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '# existing rules\n*.swp\n');

  const session = newSession(repo);
  await saveAttachment(session, 'a.txt', 'text/plain', Buffer.from('x'));

  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.multi-agent-hub\/$/m);
  assert.match(exclude, /\*\.swp/, 'rules already there are preserved');

  // Repeated saves must not keep appending the same rule.
  await ensureGitIgnored(repo);
  await ensureGitIgnored(repo);
  const after = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(after.split('\n').filter((l) => l.trim() === '.multi-agent-hub/').length, 1);
});

test('a repo with no .git is still a repo attachments work in', async () => {
  const repo = newRepo();
  await ensureGitIgnored(repo); // must not throw
  const session = newSession(repo);
  const saved = await saveAttachment(session, 'a.txt', 'text/plain', Buffer.from('x'));
  assert.ok(saved.path.startsWith(repo));
});

test('the prompt names every attachment by absolute path', () => {
  const items = [
    { storedName: 'aaaaaaaa-shot.png', name: 'shot.png', path: '/repo/.multi-agent-hub/a/shot.png', mimeType: 'image/png', size: 2048 },
    { storedName: 'bbbbbbbb-log.txt', name: 'log.txt', path: '/repo/.multi-agent-hub/a/log.txt', mimeType: 'text/plain', size: 10 },
  ];

  const composed = composePrompt('why is this broken?', items);
  assert.match(composed, /^why is this broken\?/, "the operator's words come first");
  for (const item of items) assert.ok(composed.includes(item.path), `${item.name} is named by path`);
  assert.match(composed, /2\.0 KB/);

  // An attachment with no words is a complete prompt; it must not be prefixed
  // by a blank line where the text would have been.
  const bare = composePrompt('   ', [items[0]!]);
  assert.ok(!bare.startsWith('\n'));
  assert.ok(bare.includes(items[0]!.path));

  assert.equal(composePrompt('just words', []), 'just words', 'no attachments, no block');
});

test('the download type is derived from the extension, never from the client', () => {
  assert.equal(mimeForName('a.png', 'text/html'), 'image/png', 'a declared type cannot override the extension');
  assert.equal(mimeForName('a.weirdext', 'text/html; charset=utf-8'), 'text/html');
  assert.equal(mimeForName('a.weirdext', 'nonsense"; x=1'), 'application/octet-stream');
  assert.equal(mimeForName('a.weirdext', null), 'application/octet-stream');

  // Only known images render in place; anything else downloads, so uploaded
  // markup cannot execute on the hub's own origin.
  assert.equal(isInlineType('image/png'), true);
  assert.equal(isInlineType('image/svg+xml'), false);
  assert.equal(isInlineType('text/html'), false);
});
