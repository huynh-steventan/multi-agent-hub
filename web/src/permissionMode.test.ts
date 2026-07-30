import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PermissionMode } from '../../shared/protocol.ts';
import { modeAfterAgentSwitch, resolveMode } from './permissionMode.ts';

// Mirrors the real adapters: the many-mode agents and the one-mode outlier.
const FULL: readonly PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypass'];
const KIMI: readonly PermissionMode[] = ['default'];

test('an unchosen mode yields the agent own default, not a global one', () => {
  assert.equal(resolveMode(null, FULL, 'bypass'), 'bypass');
  assert.equal(resolveMode(null, KIMI, 'default'), 'default');
});

test('an explicit pick wins over the default', () => {
  assert.equal(resolveMode('plan', FULL, 'bypass'), 'plan');
});

test('a pick the agent cannot honor falls back to that agent default', () => {
  // The case that matters: picking bypass for claude, then switching to kimi
  // without the switch handler having run.
  assert.equal(resolveMode('bypass', KIMI, 'default'), 'default');
});

test('the resolved mode is always one the agent advertises', () => {
  for (const supported of [FULL, KIMI]) {
    for (const chosen of [null, ...FULL] as (PermissionMode | null)[]) {
      const resolved = resolveMode(chosen, supported, 'bypass');
      assert.ok(
        supported.includes(resolved),
        `resolved ${resolved} for chosen=${chosen}, which the agent does not advertise`,
      );
    }
  }
});

test('switching agents keeps an unchosen mode unchosen', () => {
  // Otherwise the next agent inherits the previous agent default as though the
  // operator had picked it, and never gets its own.
  assert.equal(modeAfterAgentSwitch(null, FULL), null);
});

test('switching agents keeps a pick the new agent can honor', () => {
  assert.equal(modeAfterAgentSwitch('plan', FULL), 'plan');
});

test('switching agents drops a pick the new agent cannot honor', () => {
  assert.equal(modeAfterAgentSwitch('bypass', KIMI), null);
});
