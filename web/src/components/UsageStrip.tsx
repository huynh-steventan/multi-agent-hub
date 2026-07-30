import { useEffect, useState } from 'react';
import { computePace, type Pace } from '../../../shared/pace.ts';
import type { UsageSnapshot, UsageWindow } from '../../../shared/protocol.ts';
import { usePersistentState } from '../persist.ts';

const LABELS: Record<string, string> = { claude: 'Claude', kimi: 'Kimi', qwen: 'Qwen' };

/** How often the pace lines are recomputed against the wall clock. */
const TICK_MS = 30_000;

/**
 * The three agents' plan standings.
 *
 * Collapsed by default: the number that matters at a glance is "how much of the
 * week is gone", and three full cards of bars pushed the actual session list
 * below the fold on a phone. Expanding reveals the rest.
 *
 * A window whose percentage is genuinely unknown renders as a dash rather than
 * an empty bar — an empty bar reads as "0% used", which is the opposite of
 * "we could not determine this".
 */
export function UsageStrip({ usage }: { usage: UsageSnapshot[] }) {
  const [expanded, setExpanded] = usePersistentState('usage-expanded', false);
  const now = useNow(expanded);

  return (
    <div className={expanded ? 'usage-strip expanded' : 'usage-strip'}>
      <button
        className="usage-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse usage' : 'Expand usage'}
      >
        <span className="usage-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="usage-toggle-label">Usage</span>

        {!expanded && (
          <span className="usage-summary">
            {usage.map((snapshot) => {
              const weekly = weeklyWindow(snapshot);
              const pace = weekly ? computePace(weekly, now) : null;
              const percent = weekly?.percent ?? null;
              return (
                <span className="usage-chip" key={snapshot.agent} title={snapshot.caveat ?? weekly?.label ?? ''}>
                  <span className="usage-chip-name">{LABELS[snapshot.agent] ?? snapshot.agent}</span>
                  <span className={`usage-chip-value pace-${pace?.status ?? 'none'}`}>
                    {percent === null ? '—' : `${Math.round(percent)}%`}
                  </span>
                </span>
              );
            })}
          </span>
        )}
      </button>

      {expanded && (
        <div className="usage-cards">
          {usage.map((snapshot) => (
            <div className="usage-card" key={snapshot.agent}>
              <div className="usage-agent">{LABELS[snapshot.agent] ?? snapshot.agent}</div>

              {snapshot.windows.length === 0 ? (
                <div className="usage-unknown" title={snapshot.caveat ?? ''}>
                  —
                </div>
              ) : (
                snapshot.windows.slice(0, 2).map((w) => <WindowRow key={w.label} window={w} now={now} />)
              )}

              {snapshot.caveat && <div className="usage-caveat">{snapshot.caveat}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One quota window.
 *
 * The bar is colored by *pace* rather than by absolute consumption wherever the
 * window's span is known: 60% used means nothing without knowing how much of
 * the window is gone. Windows with no known span (Kimi's rolling one) keep the
 * provider's absolute severity, because there is no pace to report.
 */
function WindowRow({ window: w, now }: { window: UsageWindow; now: number }) {
  const pace = computePace(w, now);
  const fillClass = pace ? `pace-${pace.status}` : `sev-${w.severity}`;

  return (
    <div className="usage-window">
      <div className="usage-row">
        <span className="usage-label">{w.label}</span>
        <span className="usage-value">{w.percent === null ? '—' : `${Math.round(w.percent)}%`}</span>
      </div>

      <div className="usage-bar">
        <div
          className={`usage-fill ${fillClass}`}
          style={{ width: w.percent === null ? '0%' : `${Math.min(w.percent, 100)}%` }}
        />
        {/* Day boundaries: how much an even burn should have spent by each day.
            Rendered over the fill so the bar reads as "am I past today's mark". */}
        {pace?.dayMarks.map((position, i) => (
          <span className="usage-daymark" key={i} style={{ left: `${position}%` }} title={`day ${i + 1}`} />
        ))}
      </div>

      {pace && <PaceNote pace={pace} />}
      {w.detail && <div className="usage-detail">{w.detail}</div>}
      {w.resetsAt && <div className="usage-detail">resets {formatReset(w.resetsAt, now)}</div>}
    </div>
  );
}

/**
 * The one-line pace readout under a bar.
 *
 * When the current burn runs the window dry before it resets, that time is the
 * only thing worth saying. Otherwise the gap to the pace line is, which is
 * reassuring rather than actionable and so stays understated.
 */
function PaceNote({ pace }: { pace: Pace }) {
  if (pace.exhaustsAt !== null) {
    return <div className={`usage-pace pace-${pace.status}`}>expected usage reached by {formatWhen(pace.exhaustsAt)}</div>;
  }
  const gap = Math.round(Math.abs(pace.aheadByPoints));
  return (
    <div className={`usage-pace pace-${pace.status}`}>
      {gap}% {pace.aheadByPoints > 0 ? 'ahead of' : 'under'} pace
    </div>
  );
}

/**
 * A clock that only ticks while the strip is expanded.
 *
 * Pace is a function of elapsed time, so a card left open all afternoon would
 * otherwise keep drawing the line where it was when the page loaded. Collapsed,
 * nothing on screen depends on it, so the timer is not worth running.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The window a collapsed card summarizes.
 *
 * Prefers an explicitly weekly window; Qwen's ledger fallback labels its own
 * "Last 7 days", which is the same idea by another name. Failing both, the last
 * window is used — providers order theirs shortest-first, so it is the longest.
 */
function weeklyWindow(snapshot: UsageSnapshot): UsageWindow | null {
  if (snapshot.windows.length === 0) return null;
  return snapshot.windows.find((w) => /week|7 day/i.test(w.label)) ?? snapshot.windows[snapshot.windows.length - 1]!;
}

function formatReset(ts: number, now: number): string {
  const ms = ts - now;
  if (ms <= 0) return 'now';
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `in ${Math.round(hours)}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** An absolute wall-clock time — the question is "when", not "how long from now". */
function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
