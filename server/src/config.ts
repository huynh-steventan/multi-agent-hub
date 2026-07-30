import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_IDS, type AgentId } from '../../shared/protocol.ts';

/** Minimal .env loader — avoids a dependency for a handful of keys. */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env is fine — every value below has a usable default.
  }
}

loadDotEnv();

export const config = {
  port: Number(process.env.PORT ?? 4319),
  repoRoots: (process.env.REPO_ROOTS ?? homedir()).split(':').filter(Boolean),
  repoScanDepth: Number(process.env.REPO_SCAN_DEPTH ?? 2),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
  dataDir: resolve(process.cwd(), process.env.DATA_DIR ?? './.data'),
  // Quota moves slowly and two of the three providers are network calls against
  // someone else's API, so this doubles as the REST cache TTL — /api/usage
  // serves the poller's snapshot rather than re-collecting per page load.
  //
  // 30 minutes rather than something tighter because of what a poll costs on the
  // Kimi side: its access token lives only 900s, so any poll spaced further apart
  // than that forces a token refresh, and Kimi *rotates* refresh tokens — one
  // rotation, and one write to the CLI's credentials file, per poll. The windows
  // being measured are 5 hours and a week, so a half-hour of staleness is
  // invisible while the churn against someone else's auth server is not.
  usagePollMs: Number(process.env.USAGE_POLL_MS ?? 1_800_000),
  // Ceiling on a single prompt attachment. Generous, because the common case is
  // a phone screenshot or a photo and being told "too large" mid-thought is
  // worse than the disk cost of keeping it.
  attachmentMaxBytes: Number(process.env.ATTACHMENT_MAX_BYTES ?? 25_000_000),
  // Which agents' quota is collected. All three by default; narrow it to opt out
  // of a provider whose cost you would rather not pay. That cost is not uniform:
  // reading Claude's is a local file read, but Kimi's refreshes an OAuth token
  // and REWRITES THE KIMI CLI'S OWN CREDENTIALS FILE (its refresh tokens rotate,
  // so keeping the new one is mandatory, not bookkeeping), and Qwen's posts a
  // browser session cookie to a console endpoint. Anyone uneasy about either
  // should be able to decline it without editing code.
  usageProviders: parseAgentList(process.env.USAGE_PROVIDERS),
} as const;

/**
 * Parse a comma-separated agent list, ignoring unknown names.
 *
 * Unset means all agents — the common case, and the one that matches what the
 * dashboard is for. An explicit empty value means none, which is how usage
 * collection is turned off entirely.
 */
function parseAgentList(raw: string | undefined): readonly AgentId[] {
  if (raw === undefined) return AGENT_IDS;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AgentId => (AGENT_IDS as readonly string[]).includes(s));
}

export const sessionsFile = join(config.dataDir, 'sessions.json');
export const settingsFile = join(config.dataDir, 'settings.json');
/** One JSON file of recent events per session, so a restart keeps the transcript. */
export const eventsDir = join(config.dataDir, 'events');
