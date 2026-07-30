import type { DragEvent } from 'react';
import type { SessionRecord } from '../../../shared/protocol.ts';
import { startDrag } from './Workspace.tsx';

/**
 * The list of sessions.
 *
 * On a phone this is the whole screen and tapping a session replaces it. On a
 * desktop the same list is a sidebar next to the workspace, where a row can
 * also be dragged straight into a chosen column and rows already on screen are
 * marked so the list doubles as a map of what is open.
 */
export function SessionList({
  sessions,
  openIds,
  variant = 'page',
  onOpen,
  onNew,
  onDelete,
}: {
  sessions: SessionRecord[];
  /** Sessions currently visible in the workspace. Empty on mobile. */
  openIds?: string[];
  variant?: 'page' | 'sidebar';
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const open = new Set(openIds ?? []);
  const draggable = variant === 'sidebar';

  return (
    <div className={variant === 'sidebar' ? 'pane sidebar' : 'pane'}>
      <header className="pane-header">
        <h1>Sessions</h1>
        <button className="primary" onClick={onNew}>
          + New
        </button>
      </header>

      {sessions.length === 0 && <p className="empty">No sessions yet. Start one with “+ New”.</p>}

      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.id} className={open.has(s.id) ? 'session-item is-open' : 'session-item'}>
            <button
              className="session-open"
              onClick={() => onOpen(s.id)}
              draggable={draggable}
              onDragStart={draggable ? (e: DragEvent) => startDrag(e, s.id) : undefined}
            >
              <div className="session-top">
                <span className={`badge agent-${s.agent}`}>{s.agent}</span>
                <span className="session-title">{s.title}</span>
                {s.status === 'running' && <span className="dot-running" aria-label="running" />}
              </div>
              <div className="session-meta">
                <span>{repoName(s.repo)}</span>
                {s.model && <span>· {shortModel(s.model)}</span>}
                {s.notifyDiscord && <span title="Discord notifications on">· 🔔</span>}
                <span>· {relative(s.lastActiveAt)}</span>
              </div>
            </button>
            <button className="session-delete" onClick={() => onDelete(s.id)} aria-label="Delete session">
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function repoName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function shortModel(model: string): string {
  return model.replace(/^kimi-code\//, '').replace(/-\d{8}$/, '');
}

function relative(ts: number): string {
  const ms = Date.now() - ts;
  const min = ms / 60_000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  const hours = min / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
