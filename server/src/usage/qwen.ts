import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, spanIfAnchored } from '../../../shared/pace.ts';
import type { UsageSnapshot, UsageWindow } from '../../../shared/protocol.ts';
import { asRecord, severityOf } from './claude.ts';

const USAGE_DIR = join(homedir(), '.qwen', 'usage');

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

const CONSOLE_URL =
  'https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway' +
  '&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage';

/** The console's own request envelope. Only `params` is required alongside the cookie. */
const CONSOLE_BODY =
  'product=sfm_bailian&action=IntlBroadScopeAspnGateway&region=ap-southeast-1&params=' +
  encodeURIComponent(
    JSON.stringify({
      Api: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage',
      Data: {
        cornerstoneParam: {
          domain: 'home.qwencloud.com',
          consoleSite: 'QWENCLOUD',
          console: 'ONE_CONSOLE',
          xsp_lang: 'en-US',
          protocol: 'V2',
          productCode: 'p_efm',
        },
      },
      V: '1.0',
    }),
  );

/**
 * Qwen usage.
 *
 * Two sources, in order of quality:
 *
 * 1. **The Qwen Cloud console endpoint** — returns the exact quota the billing
 *    dashboard shows: fraction consumed of the 5-hour and 7-day credit windows,
 *    plus their reset timestamps. This is the only source that knows about
 *    "token credits" at all; the CLI has no quota concept and the inference API
 *    key cannot query billing.
 *
 *    Authentication is a browser session cookie (`login_qwencloud_ticket`), not
 *    an OAuth token — there is **no refresh token and no programmatic renewal**.
 *    When it expires the only remedy is re-copying the cookie from a logged-in
 *    browser, so expiry is reported plainly rather than silently degraded.
 *    Probing established that this single cookie is sufficient: `sec_token`,
 *    `origin`, `referer` and the tracking cookies are all unnecessary.
 *
 * 2. **The local per-call token ledger** — always available, no auth, but counts
 *    raw tokens, which are not the unit the plan is denominated in. Used as a
 *    fallback so the card still says something true when the ticket dies.
 */
export async function readQwenUsage(): Promise<UsageSnapshot> {
  const ticket = process.env.QWEN_CONSOLE_TICKET?.trim();

  if (ticket) {
    const consoleResult = await fetchConsoleUsage(ticket);
    if (consoleResult.kind === 'ok') return consoleResult.snapshot;

    const ledger = await readLedger();
    return {
      ...ledger,
      caveat:
        consoleResult.kind === 'unauthenticated'
          ? 'Qwen console session expired — re-copy the login_qwencloud_ticket cookie into QWEN_CONSOLE_TICKET. Showing local token counts meanwhile.'
          : `Qwen console unreachable (${consoleResult.error}). Showing local token counts meanwhile.`,
    };
  }

  const ledger = await readLedger();
  return {
    ...ledger,
    caveat: 'Set QWEN_CONSOLE_TICKET for exact credit quota; these are raw token counts.',
  };
}

type ConsoleResult =
  | { kind: 'ok'; snapshot: UsageSnapshot }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; error: string };

async function fetchConsoleUsage(ticket: string): Promise<ConsoleResult> {
  let payload: unknown;
  try {
    const res = await fetch(CONSOLE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json, text/plain, */*',
        // The cookie value may or may not already carry the name.
        cookie: ticket.startsWith('login_qwencloud_ticket=') ? ticket : `login_qwencloud_ticket=${ticket}`,
      },
      body: CONSOLE_BODY,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { kind: 'error', error: `HTTP ${res.status}` };
    payload = await res.json();
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  // Envelope: data.DataV2.data.data.{per5HourPercentage, per1WeekPercentage, ...}
  const outer = asRecord(payload);
  const dataV2 = asRecord(asRecord(outer?.data)?.DataV2);
  const inner = asRecord(dataV2?.data);
  const quota = asRecord(inner?.data);

  const code = typeof inner?.code === 'string' ? inner.code : '';
  const msg = typeof inner?.msg === 'string' ? inner.msg : '';
  if (/NotLogined|NotLoggedIn|Login/i.test(code + msg)) return { kind: 'unauthenticated' };

  const fiveHour = num(quota?.per5HourPercentage);
  const weekly = num(quota?.per1WeekPercentage);
  if (fiveHour === null && weekly === null) {
    return { kind: 'error', error: msg || 'no quota fields in response' };
  }

  const sessionCredits = intEnv('QWEN_SESSION_CREDITS');
  const weeklyCredits = intEnv('QWEN_WEEKLY_CREDITS');

  const windows: UsageWindow[] = [];
  if (fiveHour !== null) {
    windows.push(
      creditWindow('Session (5h)', fiveHour, num(quota?.per5HourResetTime), sessionCredits, FIVE_HOURS_MS),
    );
  }
  if (weekly !== null) {
    windows.push(creditWindow('Weekly', weekly, num(quota?.per1WeekResetTime), weeklyCredits, SEVEN_DAYS_MS));
  }

  return { kind: 'ok', snapshot: { agent: 'qwen', windows, caveat: null, fetchedAt: Date.now() } };
}

/** The API reports the *fraction consumed*, matching the dashboard's "remaining" inverted. */
function creditWindow(
  label: string,
  fraction: number,
  resetMs: number | null,
  total: number | null,
  windowMs: number,
): UsageWindow {
  const percent = Math.round(fraction * 100);
  const resetsAt = resetMs && resetMs > 0 ? resetMs : null;
  return {
    label,
    percent,
    detail: total ? `${Math.round(fraction * total).toLocaleString()} / ${total.toLocaleString()} credits` : null,
    resetsAt,
    windowMs: spanIfAnchored(windowMs, resetsAt),
    severity: severityOf(percent),
  };
}

/**
 * Fallback: raw token consumption from `usage/token-usage-<YYYY-MM>.jsonl`.
 *
 * Note this is NOT the sibling `usage_record.jsonl`, which is written once per
 * session at session *end* — an in-progress session contributes nothing there,
 * so "today" reads as zero while work is actively running. The per-call ledger
 * updates live and carries `localDate`/`localMonth`, removing timezone math.
 * Each record is one billed call; `source` separates main from subagents, which
 * are distinct calls rather than duplicates, so all sources are summed.
 */
async function readLedger(): Promise<UsageSnapshot> {
  const now = Date.now();
  const today = localDateString(new Date(now));
  const month = today.slice(0, 7);
  const sevenDaysAgo = localDateString(new Date(now - 6 * 86_400_000));

  let todayTokens = 0;
  let weekTokens = 0;
  let monthTokens = 0;
  let parsed = 0;

  // A 7-day window can reach back into the previous month's file.
  for (const file of [monthFile(month), monthFile(previousMonth(month))]) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown> | null;
      try {
        rec = asRecord(JSON.parse(trimmed));
      } catch {
        continue; // A partially-written trailing line is expected.
      }
      if (!rec) continue;
      const date = typeof rec.localDate === 'string' ? rec.localDate : null;
      if (!date) continue;
      const tokens = typeof rec.totalTokens === 'number' ? rec.totalTokens : 0;
      parsed += 1;
      if (date === today) todayTokens += tokens;
      if (date >= sevenDaysAgo) weekTokens += tokens;
      if (rec.localMonth === month) monthTokens += tokens;
    }
  }

  if (parsed === 0) {
    return { agent: 'qwen', windows: [], caveat: 'No Qwen usage records yet.', fetchedAt: now };
  }

  return {
    agent: 'qwen',
    windows: [
      tokenWindow('Today', todayTokens),
      tokenWindow('Last 7 days', weekTokens),
      tokenWindow('Month to date', monthTokens),
    ],
    caveat: null,
    fetchedAt: now,
  };
}

function tokenWindow(label: string, tokens: number): UsageWindow {
  // Raw counts with no denominator and no reset: there is no percentage and so
  // nothing to pace against either.
  return { label, percent: null, detail: `${fmt(tokens)} tokens`, resetsAt: null, windowMs: null, severity: 'unknown' };
}

function monthFile(month: string): string {
  return join(USAGE_DIR, `token-usage-${month}.jsonl`);
}

/** `YYYY-MM` for the month before the given `YYYY-MM`. */
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

/** Local-time `YYYY-MM-DD`, matching how the Qwen CLI stamps `localDate`. */
function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function intEnv(key: string): number | null {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
