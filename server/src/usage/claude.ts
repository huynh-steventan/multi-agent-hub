import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, spanIfAnchored } from '../../../shared/pace.ts';
import type { UsageSnapshot, UsageWindow } from '../../../shared/protocol.ts';

const CACHE_PATH = join(homedir(), '.claude', 'usage-cache.json');

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

/**
 * Claude Code maintains its own limit cache and refreshes it while a session is
 * running. Reading that file is exact and free — no API call and no auth.
 *
 * The catch is staleness: nothing refreshes the cache when no Claude session has
 * run recently, so `fetchedAt` is reported honestly and a caveat is attached
 * once the data ages past the point of being trustworthy.
 */
export async function readClaudeUsage(): Promise<UsageSnapshot> {
  const now = Date.now();
  let raw: string;
  try {
    raw = await readFile(CACHE_PATH, 'utf8');
  } catch {
    return {
      agent: 'claude',
      windows: [],
      caveat: 'No usage cache yet — run a Claude session once to populate it.',
      fetchedAt: now,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { agent: 'claude', windows: [], caveat: 'Usage cache is not valid JSON.', fetchedAt: now };
  }

  const root = asRecord(parsed);
  const data = asRecord(root?.fetchedAt !== undefined ? root?.data : root);
  const fetchedAt = typeof root?.fetchedAt === 'number' ? root.fetchedAt : now;

  const windows: UsageWindow[] = [];
  const fiveHour = asRecord(data?.five_hour);
  if (fiveHour) windows.push(toWindow('Session (5h)', fiveHour, FIVE_HOURS_MS));
  const sevenDay = asRecord(data?.seven_day);
  if (sevenDay) windows.push(toWindow('Weekly', sevenDay, SEVEN_DAYS_MS));

  // Per-model weekly scopes (e.g. an Opus-specific cap) live in `limits`.
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  for (const entry of limits) {
    const rec = asRecord(entry);
    if (!rec || rec.kind !== 'weekly_scoped') continue;
    const scope = asRecord(rec.scope);
    const model = asRecord(scope?.model);
    const name = typeof model?.display_name === 'string' ? model.display_name : null;
    if (!name) continue;
    const resetsAt = parseTime(rec.resets_at);
    windows.push({
      label: `Weekly · ${name}`,
      percent: typeof rec.percent === 'number' ? rec.percent : null,
      detail: null,
      resetsAt,
      windowMs: spanIfAnchored(SEVEN_DAYS_MS, resetsAt),
      severity: severityOf(typeof rec.percent === 'number' ? rec.percent : null),
    });
  }

  const ageMin = (now - fetchedAt) / 60000;
  const caveat =
    ageMin > 30
      ? `Cache is ${Math.round(ageMin)} min old — Claude Code only refreshes it while a session runs.`
      : null;

  return { agent: 'claude', windows, caveat, fetchedAt };
}

function toWindow(label: string, rec: Record<string, unknown>, windowMs: number): UsageWindow {
  const percent = typeof rec.utilization === 'number' ? rec.utilization : null;
  const used = rec.used_dollars;
  const limit = rec.limit_dollars;
  const detail =
    typeof used === 'number' && typeof limit === 'number' ? `$${used.toFixed(2)} / $${limit.toFixed(2)}` : null;
  const resetsAt = parseTime(rec.resets_at);
  return { label, percent, detail, resetsAt, windowMs: spanIfAnchored(windowMs, resetsAt), severity: severityOf(percent) };
}

export function severityOf(percent: number | null): UsageWindow['severity'] {
  if (percent === null) return 'unknown';
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'normal';
}

export function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
