/**
 * Burn-rate math for a quota window.
 *
 * A raw percentage answers "how much is gone" but not the question that
 * actually drives a decision: *am I spending faster than this window can
 * afford?* 60% used is comfortable on day five of a week and alarming on day
 * one. Everything here compares consumption against the straight line that
 * lands exactly on 100% at reset.
 *
 * Pure and dependency-free so both the server and the browser can use it, and
 * so `now` can be injected in tests instead of read from the clock.
 */

export const DAY_MS = 86_400_000;

/**
 * Percentage points by which actual may exceed the pace line before the window
 * is called anything but on-pace.
 *
 * Without it the ratio test is unusable early in a window: two hours into a
 * week the pace line sits at 1.2%, so a single 4% turn reads as "230% over
 * pace" and paints the bar red while the week is, in truth, wide open. Three
 * points of slack absorbs that noise without hiding a real overspend, which by
 * definition keeps growing.
 */
export const PACE_GRACE_POINTS = 3;

/** Above this multiple of the pace line, the burn is called excessive. */
export const PACE_OVER_RATIO = 1.2;

export type PaceStatus =
  /** On or under the line that lands on 100% exactly at reset. */
  | 'ok'
  /** Ahead of the line, but by no more than ~20%. */
  | 'warn'
  /** More than ~20% ahead — this window runs out early if nothing changes. */
  | 'over';

export interface Pace {
  /** 0-100: what a perfectly even burn would have consumed by now. */
  expectedPercent: number;
  /** actual − expected, in percentage points. Negative means under pace. */
  aheadByPoints: number;
  status: PaceStatus;
  /**
   * When a straight-line projection of the burn so far hits 100%, or null when
   * that lands at or after the reset (i.e. the window comfortably survives) or
   * when there is not yet enough consumption to project from.
   */
  exhaustsAt: number | null;
  /** When the window opened. */
  startedAt: number;
  /**
   * Positions (0-100 along the bar) of each whole-day boundary in the window,
   * i.e. how much an even burn should have consumed by that day. Empty for
   * windows too short for a day mark to mean anything.
   */
  dayMarks: number[];
}

export interface PaceInput {
  percent: number | null;
  resetsAt: number | null;
  windowMs: number | null;
}

/**
 * A span is only meaningful with the reset it is measured back from.
 *
 * Providers call this rather than setting `windowMs` directly, so a window that
 * knows its length but not when it ends reports no span at all instead of one
 * nothing can be computed from.
 */
export function spanIfAnchored(windowMs: number, resetsAt: number | null): number | null {
  return resetsAt === null ? null : windowMs;
}

/**
 * Compare a window's consumption against an even burn.
 *
 * Returns null when the window is not measurable — an unknown percentage, an
 * unknown reset, or an unknown duration. Callers fall back to absolute severity
 * there; guessing a start time would produce a confident pace reading built on
 * a number nobody knows.
 */
export function computePace(input: PaceInput, now: number): Pace | null {
  const { percent, resetsAt, windowMs } = input;
  if (percent === null || resetsAt === null || windowMs === null || windowMs <= 0) return null;

  const startedAt = resetsAt - windowMs;
  const elapsed = clamp(now - startedAt, 0, windowMs);
  const expectedPercent = (elapsed / windowMs) * 100;
  const aheadByPoints = percent - expectedPercent;

  return {
    expectedPercent,
    aheadByPoints,
    status: statusFor(percent, expectedPercent),
    exhaustsAt: projectExhaustion(percent, startedAt, elapsed, resetsAt),
    startedAt,
    dayMarks: dayMarksFor(windowMs),
  };
}

function statusFor(percent: number, expectedPercent: number): PaceStatus {
  const aheadBy = percent - expectedPercent;
  // Tolerance, not slack: exactly on pace should read as on pace, and both
  // sides of this comparison are the result of floating-point division.
  if (aheadBy <= 1e-9) return 'ok';
  // The grace band keeps a near-empty window from reading as a crisis; see
  // PACE_GRACE_POINTS. Past it, the ratio decides.
  if (aheadBy <= PACE_GRACE_POINTS) return 'warn';
  return percent <= expectedPercent * PACE_OVER_RATIO ? 'warn' : 'over';
}

/**
 * Extrapolate the burn so far to 100%.
 *
 * Reported only when exhaustion lands strictly before the reset — that is the
 * case worth acting on. A projection past the reset is the normal, healthy
 * state and does not need saying. An already-spent window returns null too:
 * "will run out at" is the wrong tense once the percentage reads 100.
 */
function projectExhaustion(percent: number, startedAt: number, elapsed: number, resetsAt: number): number | null {
  if (percent <= 0 || percent >= 100 || elapsed <= 0) return null;
  const at = startedAt + (elapsed * 100) / percent;
  return at < resetsAt ? at : null;
}

/**
 * Day boundaries as 0-100 positions along the window.
 *
 * Only for windows spanning at least two days: on a 5-hour window every mark
 * would sit past the end, and a single mark on a two-day window is still a
 * useful "half way" reference.
 */
function dayMarksFor(windowMs: number): number[] {
  if (windowMs < 2 * DAY_MS) return [];
  const marks: number[] = [];
  for (let day = 1; day * DAY_MS < windowMs; day += 1) {
    marks.push(((day * DAY_MS) / windowMs) * 100);
  }
  return marks;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
