import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, spanIfAnchored } from '../../../shared/pace.ts';
import type { UsageSnapshot, UsageWindow } from '../../../shared/protocol.ts';

const CACHE_PATH = join(homedir(), '.claude.json');

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

/**
 * Claude Code used to maintain a dedicated `~/.claude/usage-cache.json`. As of
 * CLI 2.1.232 that file is no longer written at all — probed directly against
 * the installed binary, which now folds this into its general config file
 * under `cachedUsageUtilization`. The refresh mechanism is unchanged in spirit:
 * every session start fires a near-zero-cost `source: "quota_check"` API call
 * (not a real turn) that reads the rate-limit response headers, throttled by
 * an internal cooldown. Since every hub turn is itself a session start, this
 * stays fresh for free — there is nothing extra to trigger.
 *
 * The catch is still staleness: nothing refreshes it when no Claude session has
 * run recently, so `fetchedAtMs` is reported honestly and a caveat is attached
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

  const cached = asRecord(asRecord(parsed)?.cachedUsageUtilization);
  if (!cached) {
    return {
      agent: 'claude',
      windows: [],
      caveat: 'No usage cache yet — run a Claude session once to populate it.',
      fetchedAt: now,
    };
  }

  const data = asRecord(cached.utilization);
  const fetchedAt = typeof cached.fetchedAtMs === 'number' ? cached.fetchedAtMs : now;

  const windows: UsageWindow[] = [];
  const fiveHour = asRecord(data?.five_hour);
  if (fiveHour) windows.push(toWindow('Session (5h)', fiveHour, FIVE_HOURS_MS));
  const sevenDay = asRecord(data?.seven_day);
  if (sevenDay) windows.push(toWindow('Weekly', sevenDay, SEVEN_DAYS_MS));

  // Per-model weekly scopes (e.g. an Opus-specific cap) live in `limits`. Not
  // observed on a real account yet — the `weekly_scoped` kind and its
  // `scope.model.display_name` shape are carried over from the old cache
  // format and may not match; re-probe if a per-model cap is ever seen.
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
