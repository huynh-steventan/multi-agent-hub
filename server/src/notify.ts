import type { SessionRecord, TurnEndReason, TurnUsage } from '../../shared/protocol.ts';
import { config } from './config.ts';

const COLORS: Record<TurnEndReason, number> = {
  completed: 0x3ba55d,
  awaiting_input: 0xe8a33d,
  error: 0xed4245,
  interrupted: 0x747f8d,
};

const HEADLINES: Record<TurnEndReason, string> = {
  completed: 'Finished',
  awaiting_input: 'Needs you',
  error: 'Failed',
  interrupted: 'Interrupted',
};

/**
 * Fire the per-session Discord notification for one finished turn.
 *
 * Failures are logged and swallowed: a webhook outage must never take down a
 * turn that otherwise succeeded. `awaiting_input` is the case this exists for —
 * it means the agent stopped and is waiting on you.
 */
export async function notifyTurnEnd(
  session: SessionRecord,
  reason: TurnEndReason,
  summary: string,
  usage: TurnUsage | null,
): Promise<void> {
  if (!session.notifyDiscord) return;
  const url = config.discordWebhookUrl;
  if (!url) {
    console.warn('[notify] session has notifications on but DISCORD_WEBHOOK_URL is unset');
    return;
  }

  const fields = [
    { name: 'Agent', value: session.agent, inline: true },
    { name: 'Repo', value: basename(session.repo), inline: true },
  ];
  if (usage?.totalTokens ?? usage?.outputTokens) {
    const total = usage?.totalTokens ?? usage?.outputTokens ?? 0;
    fields.push({ name: 'Tokens', value: String(total), inline: true });
  }

  const payload = {
    embeds: [
      {
        title: `${HEADLINES[reason]} — ${session.title}`,
        description: summary.slice(0, 1800),
        color: COLORS[reason],
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[notify] Discord returned HTTP ${res.status}`);
  } catch (err) {
    console.warn('[notify] Discord webhook failed:', err instanceof Error ? err.message : err);
  }
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
