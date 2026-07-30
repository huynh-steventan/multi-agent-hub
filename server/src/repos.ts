import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoEntry } from '../../shared/protocol.ts';
import { config } from './config.ts';

const exec = promisify(execFile);

/**
 * Discover git repos under the configured roots.
 *
 * Scans breadth-first to a shallow depth rather than walking the whole tree —
 * a full traversal of a home directory is slow and would surface vendored repos
 * inside node_modules. A directory containing `.git` is a repo and is not
 * descended into, so nested worktrees do not multiply into noise.
 */
export async function listRepos(): Promise<RepoEntry[]> {
  const found = new Map<string, RepoEntry>();

  for (const root of config.repoRoots) {
    await scan(root, config.repoScanDepth, found);
  }

  const entries = [...found.values()];
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function scan(dir: string, depth: number, found: Map<string, RepoEntry>): Promise<void> {
  if (depth < 0) return;

  if (await isDir(join(dir, '.git'))) {
    if (!found.has(dir)) {
      found.set(dir, { path: dir, name: basename(dir), branch: null, dirty: false });
    }
    return; // Do not descend into a repo.
  }

  let children: string[];
  try {
    children = await readdir(dir);
  } catch {
    return; // Unreadable (permissions, broken symlink) — skip quietly.
  }

  for (const child of children) {
    if (child.startsWith('.') || SKIP.has(child)) continue;
    const full = join(dir, child);
    if (await isDir(full)) await scan(full, depth - 1, found);
  }
}

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public']);

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Branch and dirty state for one repo. Kept separate from `listRepos` because
 * shelling out to git for every candidate makes the picker noticeably slow;
 * the UI requests this only for the selected repo.
 */
export async function repoStatus(path: string): Promise<{ branch: string | null; dirty: boolean }> {
  try {
    const [branch, status] = await Promise.all([
      exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path }),
      exec('git', ['status', '--porcelain'], { cwd: path }),
    ]);
    return { branch: branch.stdout.trim() || null, dirty: status.stdout.trim().length > 0 };
  } catch {
    return { branch: null, dirty: false };
  }
}
