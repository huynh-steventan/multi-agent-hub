import type { AgentId } from '../../../shared/protocol.ts';
import type { AgentAdapter } from './base.ts';
import { claudeAdapter } from './claude.ts';
import { kimiAdapter } from './kimi.ts';
import { qwenAdapter } from './qwen.ts';

const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  kimi: kimiAdapter,
  qwen: qwenAdapter,
};

export function getAdapter(id: AgentId): AgentAdapter {
  return ADAPTERS[id];
}

export function allAdapters(): AgentAdapter[] {
  return Object.values(ADAPTERS);
}

export { type AgentAdapter, type TurnRequest, type RunHandle, runTurn } from './base.ts';
