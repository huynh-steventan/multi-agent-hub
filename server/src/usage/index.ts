import type { AgentId, UsageSnapshot } from '../../../shared/protocol.ts';
import { config } from '../config.ts';
import { readClaudeUsage } from './claude.ts';
import { readKimiUsage } from './kimi.ts';
import { readQwenUsage } from './qwen.ts';

const READERS: Record<AgentId, () => Promise<UsageSnapshot>> = {
  claude: readClaudeUsage,
  kimi: readKimiUsage,
  qwen: readQwenUsage,
};

/**
 * Collect the enabled agents' standings.
 *
 * Providers never throw and never fabricate: an agent that cannot be read comes
 * back with empty windows and a caveat explaining why. A blank slot in the UI is
 * honest; a zero would read as "plenty of quota left" and is not.
 *
 * A provider disabled via `USAGE_PROVIDERS` still returns a snapshot, with a
 * caveat saying so. Omitting it entirely would make a card silently vanish,
 * which reads as "this agent has no quota" rather than "you turned this off" —
 * the same class of lie the never-fabricate rule exists to prevent.
 */
export async function collectUsage(): Promise<UsageSnapshot[]> {
  const agents = Object.keys(READERS) as AgentId[];

  const results = await Promise.allSettled(
    agents.map((agent) =>
      config.usageProviders.includes(agent)
        ? READERS[agent]()
        : Promise.resolve<UsageSnapshot>({
            agent,
            windows: [],
            caveat: `Usage collection is disabled for ${agent} (USAGE_PROVIDERS).`,
            fetchedAt: Date.now(),
          }),
    ),
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    const agent = agents[i]!;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { agent, windows: [], caveat: `Usage provider failed: ${reason}`, fetchedAt: Date.now() };
  });
}
