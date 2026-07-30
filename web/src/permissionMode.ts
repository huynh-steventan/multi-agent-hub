import type { PermissionMode } from '../../shared/protocol.ts';

/**
 * The new-session form's permission-mode selection model, kept out of the
 * component so it can be tested without a DOM.
 *
 * The subtlety is that "the mode this form will submit" has three inputs, not
 * one: what the operator picked, what the chosen agent can honor, and what that
 * agent defaults to. The defaults differ per agent — `claude` and `qwen` open
 * fully permissive, `kimi` has exactly one mode — so a single hardcoded
 * fallback in the component is wrong for at least one agent at all times.
 *
 * Hence the draft stores `null` for "not chosen", distinct from an explicit
 * pick that happens to equal a default. Collapsing the two loses the only
 * signal that says whether switching agents should carry the mode across.
 */

/**
 * The mode the form will actually submit.
 *
 * An explicit pick wins, but only while the chosen agent can honor it; anything
 * else yields that agent's own default. The result is always a member of
 * `supported`, so the highlighted segment and the submitted mode cannot
 * disagree — the same invariant `effectiveRepo` maintains for the repo picker.
 */
export function resolveMode(
  chosen: PermissionMode | null,
  supported: readonly PermissionMode[],
  agentDefault: PermissionMode,
): PermissionMode {
  if (chosen && supported.includes(chosen)) return chosen;
  return supported.includes(agentDefault) ? agentDefault : (supported[0] ?? 'default');
}

/**
 * What the draft should remember after the operator switches agents.
 *
 * An unchosen mode stays unchosen, so the newly selected agent contributes its
 * own default rather than silently inheriting the previous agent's. A pick the
 * new agent cannot honor is dropped for the same reason — carrying it would
 * show a mode the adapter is about to override anyway.
 */
export function modeAfterAgentSwitch(
  chosen: PermissionMode | null,
  nextSupported: readonly PermissionMode[],
): PermissionMode | null {
  return chosen && nextSupported.includes(chosen) ? chosen : null;
}
