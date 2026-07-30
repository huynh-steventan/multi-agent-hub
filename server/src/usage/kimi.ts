import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, arch, platform } from 'node:os';
import { join } from 'node:path';
import { DAY_MS, spanIfAnchored } from '../../../shared/pace.ts';
import type { UsageSnapshot, UsageWindow } from '../../../shared/protocol.ts';
import { asRecord, parseTime, severityOf } from './claude.ts';

const SEVEN_DAYS_MS = 7 * DAY_MS;

const KIMI_DIR = join(homedir(), '.kimi-code');
const CREDENTIALS_PATH = join(KIMI_DIR, 'credentials', 'kimi-code.json');
const DEVICE_ID_PATH = join(KIMI_DIR, 'device_id');
const USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
const TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
/** Refresh this far ahead of expiry, matching the Kimi CLI's own threshold. */
const REFRESH_THRESHOLD_SEC = 300;
/** Identifies as a Kimi coding agent; a generic UA gets access_terminated_error. */
const USER_AGENT = 'KimiCLI/1.6';

interface KimiCreds {
  accessToken: string;
  refreshToken: string;
  expiresAtSec: number;
}

/**
 * The newest credentials this process knows about.
 *
 * **Kimi rotates refresh tokens**: every successful refresh issues a new
 * refresh token and invalidates the one that was spent. An earlier version of
 * this module kept refreshed tokens in memory only, on the reasoning that the
 * CLI owns its credentials file and writing there would race it. That reasoning
 * held for concurrent writes but not for rotation — discarding the rotated
 * token left the CLI's file holding a spent one, so auth worked for exactly one
 * refresh cycle after a login and then failed `invalid_grant` forever, taking
 * the CLI's own ability to run turns down with it.
 *
 * So the rotated pair is now persisted back (see `persistCreds`). The residual
 * race is a read-modify-write against a file the CLI may also rewrite; the
 * window is milliseconds against a 10-minute poll, and the write is atomic.
 */
let cachedToken: { token: string; expiresAtSec: number; refreshToken: string } | null = null;

/**
 * Kimi exposes quota over an authenticated endpoint rather than on disk.
 *
 * Three non-obvious requirements, learned from the `kayuii.kimi-usage`
 * VS Code extension:
 *   1. The bearer token is the Kimi CLI's own OAuth access token, read from its
 *      credentials file — no separate login for the hub.
 *   2. The User-Agent MUST identify as a Kimi coding agent, or the API returns
 *      `access_terminated_error` rather than a normal auth failure.
 *   3. **Access tokens expire.** Reading the file alone works only until then;
 *      after expiry the endpoint 401s until the CLI happens to run and refresh.
 *      This module therefore refreshes proactively (before expiry) and
 *      reactively (retrying once on a 401), so the hub stays live even when
 *      Kimi itself has been idle for hours.
 *
 * Tokens are never logged and never leave this module.
 */
export async function readKimiUsage(): Promise<UsageSnapshot> {
  const now = Date.now();

  let token: string | null;
  try {
    token = await getAccessToken(false);
  } catch (err) {
    return { agent: 'kimi', windows: [], caveat: authCaveat(err), fetchedAt: now };
  }
  if (!token) {
    return { agent: 'kimi', windows: [], caveat: 'No Kimi credentials found — run `kimi login`.', fetchedAt: now };
  }

  let result = await fetchUsages(token);

  // A 401 despite a token we believed fresh means the stored credentials were
  // rotated or the expiry was wrong; force one refresh and retry before
  // reporting an auth failure the user would otherwise have to fix by hand.
  if (result.status === 401 || result.status === 403) {
    try {
      const refreshed = await getAccessToken(true);
      if (refreshed) result = await fetchUsages(refreshed);
    } catch (err) {
      return { agent: 'kimi', windows: [], caveat: authCaveat(err), fetchedAt: now };
    }
  }

  if (!result.ok) {
    const caveat =
      result.status === 401 || result.status === 403
        ? 'Kimi token rejected and refresh did not help — run `kimi login`.'
        : `Kimi usage unavailable: ${result.error ?? `HTTP ${result.status}`}`;
    return { agent: 'kimi', windows: [], caveat, fetchedAt: now };
  }

  const data = asRecord(result.data);

  // Order matters: shorter window first, then weekly — matching the Claude and
  // Qwen cards so the three read the same way down the dashboard.
  const windows: UsageWindow[] = [];

  // `limits[0].detail` carries the shorter rolling window.
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const detail = asRecord(asRecord(limits[0])?.detail);
  if (detail) {
    const limit = toInt(detail.limit);
    const used = toInt(detail.used);
    const remaining = toInt(detail.remaining);
    const percent = limit && limit > 0 && used !== null ? Math.round((used / limit) * 100) : null;
    windows.push({
      label: 'Current window',
      percent,
      detail: remaining !== null ? `${fmt(remaining)} remaining` : null,
      resetsAt: parseTime(detail.resetTime),
      // The API gives this window's reset but never its span, so there is no
      // start time to measure a burn rate against. Left null rather than
      // assumed — a guessed duration would produce a confident wrong pace.
      windowMs: null,
      severity: severityOf(percent),
    });
  }

  const usage = asRecord(data?.usage);
  if (usage) {
    const limit = toInt(usage.limit);
    const used = toInt(usage.used);
    const percent = limit && limit > 0 && used !== null ? Math.round((used / limit) * 100) : null;
    const resetsAt = parseTime(usage.resetTime);
    windows.push({
      label: 'Weekly',
      percent,
      detail: limit && used !== null ? `${fmt(used)} / ${fmt(limit)}` : null,
      resetsAt,
      windowMs: spanIfAnchored(SEVEN_DAYS_MS, resetsAt),
      severity: severityOf(percent),
    });
  }

  return {
    agent: 'kimi',
    windows,
    caveat: windows.length === 0 ? 'Kimi usage API returned no recognizable quota fields.' : null,
    fetchedAt: now,
  };
}

interface UsagesResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

async function fetchUsages(token: string): Promise<UsagesResult> {
  try {
    const res = await fetch(USAGES_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Return a usable access token, refreshing when stale or when `force` is set. */
async function getAccessToken(force: boolean): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);

  if (!force && cachedToken && cachedToken.expiresAtSec - nowSec > REFRESH_THRESHOLD_SEC) {
    return cachedToken.token;
  }

  const creds = await readCreds();
  if (!creds) return null;

  const stillValid = creds.expiresAtSec === 0 || creds.expiresAtSec - nowSec > REFRESH_THRESHOLD_SEC;
  if (!force && stillValid) {
    cachedToken = { token: creds.accessToken, expiresAtSec: creds.expiresAtSec, refreshToken: creds.refreshToken };
    return creds.accessToken;
  }

  // Spend the newest refresh token we hold. Ours is normally the newest, since
  // we wrote it; but a `kimi login` or a CLI-side refresh puts a later-expiring
  // credential on disk, and under rotation that one supersedes ours.
  const refreshToken =
    !cachedToken || creds.expiresAtSec > cachedToken.expiresAtSec ? creds.refreshToken : cachedToken.refreshToken;

  if (!refreshToken) {
    // Nothing to refresh with; the stored token is all we have.
    return creds.accessToken || null;
  }

  const refreshed = await refreshAccessToken(refreshToken);
  cachedToken = refreshed;
  await persistCreds(refreshed);
  return refreshed.token;
}

interface RefreshedCreds {
  token: string;
  expiresAtSec: number;
  refreshToken: string;
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshedCreds> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'X-Msh-Device-Model': `${platform()} ${arch()}`,
      'X-Msh-Device-Id': await readDeviceId(),
    },
    body,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status})`);

  const wire = asRecord(await res.json());
  const token = typeof wire?.access_token === 'string' ? wire.access_token : '';
  if (!token) throw new Error('token refresh returned no access_token');

  const expiresIn = typeof wire?.expires_in === 'number' ? wire.expires_in : 0;

  // Falls back to the token we spent when the response carries no replacement,
  // so this is correct whether or not the server rotates on a given call.
  const rotated = typeof wire?.refresh_token === 'string' && wire.refresh_token ? wire.refresh_token : refreshToken;

  return {
    token,
    expiresAtSec: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0,
    refreshToken: rotated,
  };
}

/**
 * Write the refreshed pair back to the CLI's credentials file.
 *
 * Required for correctness, not just convenience: under refresh-token rotation
 * the token we just spent is dead, so leaving it on disk strands both the hub
 * and the CLI at the next refresh.
 *
 * Merges into the existing JSON rather than replacing it, so fields the CLI
 * owns (`scope`, `token_type`, anything added by a future version) survive.
 * Temp-file + rename keeps the file atomic: a concurrent reader sees either the
 * old contents or the new, never a partial write. Best-effort by design — the
 * in-memory cache carries the rotated token for this process either way, so a
 * failed write degrades to the old behaviour instead of breaking the poll.
 */
async function persistCreds(next: RefreshedCreds): Promise<void> {
  const tmp = `${CREDENTIALS_PATH}.hub-${process.pid}.tmp`;
  try {
    const parsed = asRecord(JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8')));
    if (!parsed) return;
    const merged = {
      ...parsed,
      access_token: next.token,
      refresh_token: next.refreshToken,
      expires_at: next.expiresAtSec,
    };
    // 0600: the file holds live credentials and the CLI creates it the same way.
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, CREDENTIALS_PATH);
  } catch {
    // Never surfaced: a write failure must not turn a working usage poll into
    // an auth error. Tokens are not logged, so there is nothing safe to report.
  }
}

async function readCreds(): Promise<KimiCreds | null> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8')));
    const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token : '';
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: typeof parsed?.refresh_token === 'string' ? parsed.refresh_token : '',
      expiresAtSec: normalizeExpiry(parsed?.expires_at),
    };
  } catch {
    return null;
  }
}

/** `expires_at` may be seconds or milliseconds since epoch; normalize to seconds. */
function normalizeExpiry(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

async function readDeviceId(): Promise<string> {
  try {
    return (await readFile(DEVICE_ID_PATH, 'utf8')).trim();
  } catch {
    return '';
  }
}

function authCaveat(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Kimi auth failed: ${message} — run \`kimi login\` if this persists.`;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
