import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { formatBytes } from '../../shared/format.ts';
import type { Attachment, SessionRecord } from '../../shared/protocol.ts';

/**
 * Prompt attachments: pasted screenshots and picked files.
 *
 * The mechanism is deliberately dumb, because it is the only one all three CLIs
 * share. None of them accept image or file data inline in a headless prompt, so
 * an attachment is written to disk and its absolute path is appended to the
 * prompt text; the agent then reads it with the file tool it already has.
 *
 * Files land **inside the session's repo** rather than in `DATA_DIR`. That is
 * not a preference — `qwen` confines its file tools to the workspace root and,
 * unlike `claude` and `kimi`, offers no `--add-dir` to widen it, so anything
 * outside the repo is unreadable to a third of the agents. The cost is real
 * files in the working tree, which `ensureGitIgnored` keeps out of `git status`.
 */

/** Directory name used inside every repo the hub touches. */
export const HUB_DIR = '.multi-agent-hub';

/** Everything that is not obviously safe in a filename becomes an underscore. */
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * A stored name is `<8 hex>-<sanitized name>` and nothing else.
 *
 * This is the load-bearing check: stored names arrive from the client on every
 * prompt and every download, and they are turned into filesystem paths. Because
 * the pattern admits no `/` and no `.` run long enough to traverse, a name that
 * matches cannot escape the session's own directory.
 */
const STORED_NAME = /^[0-9a-f]{8}-[A-Za-z0-9._-]{1,160}$/;

/** Types rendered inline in the browser; everything else downloads. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.zip': 'application/zip',
};

export function attachmentsDir(session: SessionRecord): string {
  return join(session.repo, HUB_DIR, 'attachments', session.id);
}

/**
 * Reduce a browser-supplied filename to something safe to write and safe to
 * show. The sanitized form is what the operator sees in the UI *and* what the
 * agent is told to read — keeping those identical means the path on screen is
 * always the real path, with no second name to reconcile.
 */
export function sanitizeName(raw: string): string {
  // basename() first so `../../etc/passwd` loses its directories rather than
  // having its separators quietly folded into the name.
  const base = basename(String(raw ?? '')).replace(UNSAFE, '_');
  // A leading dot would make the file hidden, and a name of pure dots is not a
  // name at all.
  const trimmed = base.replace(/^\.+/, '').slice(0, 160);
  return trimmed || 'attachment';
}

export function mimeForName(name: string, declared?: string | null): string {
  const byExt = MIME_BY_EXT[extname(name).toLowerCase()];
  if (byExt) return byExt;
  const clean = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  // Reject anything with characters that have meaning in a header value; this
  // string is echoed back in Content-Type on download.
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(clean)) return clean;
  return 'application/octet-stream';
}

export function isInlineType(mimeType: string): boolean {
  return INLINE_TYPES.has(mimeType);
}

/** Write one uploaded file into the session's attachment directory. */
export async function saveAttachment(
  session: SessionRecord,
  rawName: string,
  declaredType: string | null,
  bytes: Buffer,
): Promise<Attachment> {
  const dir = attachmentsDir(session);
  await mkdir(dir, { recursive: true });
  await ensureGitIgnored(session.repo);

  const name = sanitizeName(rawName);
  // Pasted screenshots are all called `image.png`, so a collision is the normal
  // case rather than the exception; the prefix makes every upload distinct
  // without having to probe the directory first.
  const storedName = `${randomBytes(4).toString('hex')}-${name}`;
  const path = join(dir, storedName);
  await writeFile(path, bytes);

  return { storedName, name, path, mimeType: mimeForName(name, declaredType), size: bytes.byteLength };
}

/**
 * Resolve a client-supplied stored name back to an attachment on disk.
 *
 * Returns null for anything that does not match the naming pattern or is not
 * actually present — the caller never gets a path it did not build itself.
 */
export async function findAttachment(session: SessionRecord, storedName: string): Promise<Attachment | null> {
  if (!STORED_NAME.test(storedName)) return null;
  const path = join(attachmentsDir(session), storedName);
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  const name = storedName.slice(9);
  return { storedName, name, path, mimeType: mimeForName(name), size };
}

export async function deleteAttachment(session: SessionRecord, storedName: string): Promise<boolean> {
  if (!STORED_NAME.test(storedName)) return false;
  const found = await findAttachment(session, storedName);
  if (!found) return false;
  await rm(found.path, { force: true });
  return true;
}

/** Drop a session's whole attachment directory, e.g. when the session is deleted. */
export async function deleteSessionAttachments(session: SessionRecord): Promise<void> {
  await rm(attachmentsDir(session), { recursive: true, force: true });
}

/**
 * Build the prompt actually handed to the CLI.
 *
 * The paths go in the prompt body because that is the only channel every agent
 * has. They are listed explicitly rather than merely mentioned so the agent has
 * no reason to guess at a filename, and the block is appended after the
 * operator's own words so a prompt that refers to "the screenshot" still reads
 * in the right order.
 */
export function composePrompt(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) => `- ${a.path} (${a.mimeType}, ${formatBytes(a.size)})`);
  const header =
    attachments.length === 1
      ? 'The user attached this file. Read it from disk before answering:'
      : 'The user attached these files. Read them from disk before answering:';
  const block = `${header}\n${lines.join('\n')}`;
  return text.trim() ? `${text}\n\n${block}` : block;
}

/**
 * Keep the hub's scratch directory out of the operator's `git status`.
 *
 * `.git/info/exclude` rather than `.gitignore`: it is local-only and untracked,
 * so the hub never edits a file the repo actually owns and never produces a
 * diff the operator has to explain in a commit. Best-effort throughout — a repo
 * we cannot write to is still a repo attachments work in.
 */
export async function ensureGitIgnored(repo: string): Promise<void> {
  const line = `${HUB_DIR}/`;
  const infoDir = join(repo, '.git', 'info');
  try {
    // A `.git` file rather than a directory means a worktree or submodule,
    // where this path does not exist; skip rather than create a bogus tree.
    const gitDir = await stat(join(repo, '.git'));
    if (!gitDir.isDirectory()) return;

    const excludeFile = join(infoDir, 'exclude');
    const current = await readFile(excludeFile, 'utf8').catch(() => '');
    if (current.split('\n').some((l) => l.trim() === line)) return;
    await mkdir(infoDir, { recursive: true });
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(excludeFile, `${prefix}# added by multi-agent-hub — prompt attachments\n${line}\n`);
  } catch {
    // Not a git repo, or not writable. Neither stops an attachment from working.
  }
}
