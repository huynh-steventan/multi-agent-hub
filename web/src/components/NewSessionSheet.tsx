import { useMemo, useRef, useState, type TouchEvent } from 'react';
import type { AgentId, PermissionMode, RepoEntry } from '../../../shared/protocol.ts';
import type { AgentInfo } from '../api.ts';
import { load, save } from '../persist.ts';
import { modeAfterAgentSwitch, resolveMode } from '../permissionMode.ts';
import { effectiveRepo, visibleRepos } from '../repoPicker.ts';

const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  plan: 'Plan only',
  acceptEdits: 'Accept edits',
  bypass: 'Bypass all',
};

const DRAFT_KEY = 'new-session-draft';

/** Drag this far down before a swipe counts as a dismissal. */
const DISMISS_PX = 110;

export interface NewSessionInput {
  agent: AgentId;
  repo: string;
  title: string;
  model: string | null;
  permissionMode: PermissionMode;
  notifyDiscord: boolean;
}

interface Draft {
  agent: AgentId | null;
  repo: string | null;
  title: string;
  model: string;
  /** null means "not chosen" — the agent's own default applies. */
  mode: PermissionMode | null;
  notify: boolean;
  filter: string;
}

const EMPTY_DRAFT: Draft = {
  agent: null,
  repo: null,
  title: '',
  model: '',
  mode: null,
  notify: false,
  filter: '',
};

/**
 * Clear the saved draft.
 *
 * Called once a session is actually created: the settings carry forward through
 * `defaults`, and keeping the old title would misname the next session.
 */
export function clearNewSessionDraft(): void {
  save(DRAFT_KEY, EMPTY_DRAFT);
}

/**
 * New-session form.
 *
 * Agent and repo both default to the last ones used, since consecutive sessions
 * are usually in the same project. Only modes the chosen agent can actually
 * honor are offered — Kimi's headless mode rejects permission flags entirely,
 * so showing them would promise behavior that silently does not apply.
 *
 * Every keystroke is written to a draft, so dismissing the form — by accident
 * on a phone, or deliberately to go look something up — never costs the work of
 * filling it in again.
 *
 * Presentation differs by pointer: a bottom sheet that can be swiped away on a
 * phone, a centered modal on a desktop where a slide-up panel is just a large
 * dialog that arrived oddly.
 */
export function NewSessionSheet({
  agents,
  repos,
  defaults,
  variant,
  onCancel,
  onCreate,
}: {
  agents: AgentInfo[];
  repos: RepoEntry[];
  defaults: { lastRepo: string | null; lastAgent: AgentId | null };
  variant: 'sheet' | 'modal';
  onCancel: () => void;
  onCreate: (input: NewSessionInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...EMPTY_DRAFT, ...load<Partial<Draft>>(DRAFT_KEY, {}) }));

  // A draft value wins when present; otherwise fall back to the last-used
  // choices, then to whatever exists.
  const agent = draft.agent ?? defaults.lastAgent ?? 'claude';

  const patch = (change: Partial<Draft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...change };
      save(DRAFT_KEY, next);
      return next;
    });
  };

  const info = useMemo(() => agents.find((a) => a.id === agent) ?? null, [agents, agent]);
  const modes = info?.supportedModes ?? ['default'];
  const mode = resolveMode(draft.mode, modes, info?.defaultMode ?? 'default');
  const visible = useMemo(() => visibleRepos(repos, draft.filter), [repos, draft.filter]);
  // Always one of the options on screen, so the highlighted row and the repo
  // the session is created in cannot disagree — a `<select>` whose value
  // matches no option displays the first one, and a Start pressed on that
  // display would otherwise submit the invisible remembered path.
  const repo = effectiveRepo(draft.repo ?? defaults.lastRepo ?? '', visible);

  const canCreate = repo.length > 0;
  const swipe = useSwipeToDismiss(variant === 'sheet', onCancel);

  return (
    // The variant modifier must not be interpolated raw: 'sheet' would collide
    // with the .sheet class on the panel itself and style the backdrop as one.
    <div className={variant === 'modal' ? 'sheet-backdrop as-modal' : 'sheet-backdrop'} onClick={onCancel}>
      <div
        className={variant === 'modal' ? 'sheet modal' : 'sheet'}
        onClick={(e) => e.stopPropagation()}
        style={swipe.style}
        {...swipe.handlers}
      >
        {variant === 'sheet' && <div className="sheet-grabber" aria-hidden="true" />}
        <h2>New session</h2>

        <label className="field">
          <span>Agent</span>
          <div className="segmented">
            {agents.map((a) => (
              <button
                key={a.id}
                className={a.id === agent ? 'seg active' : 'seg'}
                onClick={() =>
                  patch({
                    agent: a.id,
                    // Models are per-agent, and a mode this agent cannot honor
                    // must not survive the switch.
                    model: '',
                    mode: modeAfterAgentSwitch(draft.mode, a.supportedModes),
                  })
                }
              >
                {a.id}
              </button>
            ))}
          </div>
        </label>

        <label className="field">
          <span>Title</span>
          <input
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="What is this session for?"
          />
        </label>

        <label className="field">
          <span>Repo</span>
          <input value={draft.filter} onChange={(e) => patch({ filter: e.target.value })} placeholder="Filter repos…" />
          <select value={repo} onChange={(e) => patch({ repo: e.target.value })} size={6} className="repo-select">
            {visible.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
              </option>
            ))}
          </select>
          {/* The path, not just the name — two checkouts of the same project
              are indistinguishable by name, and this line is the only place the
              choice is unambiguous. */}
          <small className="hint">{repo || (visible.length === 0 ? 'No repo matches that filter' : 'No repo selected')}</small>
        </label>

        <label className="field">
          <span>Model</span>
          <select value={draft.model} onChange={(e) => patch({ model: e.target.value })}>
            <option value="">Agent default</option>
            {(info?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Permission mode</span>
          <div className="segmented">
            {modes.map((m) => (
              <button key={m} className={m === mode ? 'seg active' : 'seg'} onClick={() => patch({ mode: m })}>
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          {modes.length === 1 && <small className="hint">{agent} does not accept permission flags headlessly.</small>}
        </label>

        <label className="field row">
          <input type="checkbox" checked={draft.notify} onChange={(e) => patch({ notify: e.target.checked })} />
          <span>Notify Discord when a turn ends</span>
        </label>

        <div className="sheet-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!canCreate}
            onClick={() =>
              onCreate({
                agent,
                repo,
                title: draft.title.trim() || `${agent} · ${repoName(repo)}`,
                model: draft.model || null,
                permissionMode: mode,
                notifyDiscord: draft.notify,
              })
            }
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Swipe the bottom sheet down to dismiss it.
 *
 * The gesture is only armed when the sheet is scrolled to the top, because
 * otherwise a downward drag is the user scrolling the form and stealing it
 * would make the repo list unusable. Upward drags are ignored outright so the
 * sheet cannot be pulled above its resting position.
 */
function useSwipeToDismiss(enabled: boolean, onDismiss: () => void) {
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);
  /**
   * The live drag distance.
   *
   * Deliberately a ref and not the `offset` state: touchend can arrive in the
   * same task as the last touchmove, and React batches, so the state a
   * touchend handler closes over may still be the pre-drag value. Reading the
   * ref decides the gesture on what the finger actually did.
   */
  const distance = useRef(0);

  if (!enabled) return { style: undefined, handlers: {} };

  return {
    style: offset > 0 ? { transform: `translateY(${offset}px)`, transition: 'none' } : undefined,
    handlers: {
      onTouchStart: (e: TouchEvent<HTMLDivElement>) => {
        // Only arm the gesture at the top of the sheet; lower down, a downward
        // drag is the user scrolling the form and stealing it would make the
        // repo list unusable.
        const atTop = e.currentTarget.scrollTop <= 0;
        start.current = atTop ? (e.touches[0]?.clientY ?? null) : null;
        distance.current = 0;
      },
      onTouchMove: (e: TouchEvent<HTMLDivElement>) => {
        if (start.current === null) return;
        // Downward only — the sheet cannot be pulled above its resting position.
        const delta = Math.max(0, (e.touches[0]?.clientY ?? 0) - start.current);
        distance.current = delta;
        setOffset(delta);
      },
      onTouchEnd: () => {
        const dismissed = distance.current > DISMISS_PX;
        start.current = null;
        distance.current = 0;
        setOffset(0);
        if (dismissed) onDismiss();
      },
    },
  };
}

function repoName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
