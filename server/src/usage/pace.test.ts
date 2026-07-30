import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computePace, DAY_MS } from '../../../shared/pace.ts';

const WEEK = 7 * DAY_MS;
/** A fixed reset instant, so no test depends on the wall clock. */
const RESET = 1_800_000_000_000;

/** `days` into a 7-day window that resets at RESET. */
function at(days: number): number {
  return RESET - WEEK + days * DAY_MS;
}

function weekly(percent: number | null) {
  return { percent, resetsAt: RESET, windowMs: WEEK };
}

test('an unmeasurable window yields no pace rather than a guess', () => {
  assert.equal(computePace({ percent: null, resetsAt: RESET, windowMs: WEEK }, at(1)), null);
  assert.equal(computePace({ percent: 50, resetsAt: null, windowMs: WEEK }, at(1)), null);
  assert.equal(computePace({ percent: 50, resetsAt: RESET, windowMs: null }, at(1)), null);
  assert.equal(computePace({ percent: 50, resetsAt: RESET, windowMs: 0 }, at(1)), null);
});

test('expected consumption tracks elapsed fraction of the window', () => {
  const pace = computePace(weekly(20), at(3.5));
  assert.ok(pace);
  assert.equal(Math.round(pace.expectedPercent), 50);
  assert.equal(Math.round(pace.aheadByPoints), -30);
  assert.equal(pace.startedAt, RESET - WEEK);
});

test('under and exactly on pace both read as ok', () => {
  assert.equal(computePace(weekly(20), at(3.5))?.status, 'ok');
  // Day 2 of 7 is 28.57% expected.
  const exact = computePace(weekly(200 / 7), at(2));
  assert.equal(exact?.status, 'ok');
});

test('up to ~20% over pace is a warning, beyond it is over', () => {
  // Day 4 of 7 → 57.14% expected. +15% of that is still within the ratio.
  assert.equal(computePace(weekly(65), at(4))?.status, 'warn');
  // +20% exactly is the boundary and stays a warning.
  assert.equal(computePace(weekly((400 / 7) * 1.2), at(4))?.status, 'warn');
  // Comfortably past it.
  assert.equal(computePace(weekly(80), at(4))?.status, 'over');
});

test('a barely-started window is not called a crisis over a few points', () => {
  // Two hours into a week: 1.19% expected. 4% is >200% of pace by ratio, but
  // only ~2.8 points ahead, which the grace band absorbs.
  const pace = computePace(weekly(4), at(2 / 24));
  assert.equal(pace?.status, 'warn');
  // Once the gap is real in absolute terms, the ratio is allowed to bite.
  assert.equal(computePace(weekly(25), at(2 / 24))?.status, 'over');
});

test('exhaustion is projected only when it lands before the reset', () => {
  // Half the quota gone in a quarter of the week → full at the halfway point.
  const early = computePace(weekly(50), at(1.75));
  assert.ok(early?.exhaustsAt);
  assert.equal(Math.round((early.exhaustsAt - early.startedAt) / DAY_MS), 4);
  assert.ok(early.exhaustsAt < RESET);

  // On pace lands exactly at the reset, which is not worth reporting.
  assert.equal(computePace(weekly(50), at(3.5))?.exhaustsAt, null);
  // Under pace projects past the reset.
  assert.equal(computePace(weekly(10), at(3.5))?.exhaustsAt, null);
  // Nothing spent yet: nothing to extrapolate from.
  assert.equal(computePace(weekly(0), at(1))?.exhaustsAt, null);
  // Already spent: "will run out at" is the wrong tense.
  assert.equal(computePace(weekly(100), at(1))?.exhaustsAt, null);
});

test('day marks sit on whole-day boundaries within the window', () => {
  const marks = computePace(weekly(10), at(1))?.dayMarks ?? [];
  assert.equal(marks.length, 6, 'a 7-day window has six interior day boundaries');
  assert.equal(Math.round(marks[0]!), 14);
  assert.equal(Math.round(marks[5]!), 86);

  // Windows shorter than two days get no marks — every one would be off the end.
  assert.deepEqual(computePace({ percent: 10, resetsAt: RESET, windowMs: 5 * 3_600_000 }, RESET - 3_600_000)?.dayMarks, []);
});

test('elapsed time is clamped to the window', () => {
  // A stale reset timestamp must not push expected consumption past 100%.
  const stale = computePace(weekly(50), RESET + DAY_MS);
  assert.equal(stale?.expectedPercent, 100);
  assert.equal(stale?.status, 'ok');
});
