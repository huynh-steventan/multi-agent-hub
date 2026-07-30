import { useState, type DragEvent } from 'react';
import type { AgentEvent, SessionRecord } from '../../../shared/protocol.ts';
import type { AgentInfo } from '../api.ts';
import { COLUMN_COUNT, type Layout } from '../layout.ts';
import { SessionView } from './SessionView.tsx';

/** The drag payload is just a session id; this names the flavor carrying it. */
export const DRAG_TYPE = 'application/x-multi-agent-hub-session';

/**
 * The desktop workspace: several sessions visible at once.
 *
 * A phone can only ever show one session, but a desktop has room to watch three
 * agents work in parallel — which is the whole reason this hub exists rather
 * than three terminals. Columns are fixed rather than free-floating windows:
 * with only three of them, a tiling layout needs no management, and a session
 * moves between columns by being dragged there.
 */
export function Workspace({
  layout,
  sessions,
  events,
  agents,
  onFocus,
  onClose,
  onMove,
  onPrompt,
  onInterrupt,
  onPatch,
}: {
  layout: Layout;
  sessions: SessionRecord[];
  events: Record<string, AgentEvent[]>;
  agents: AgentInfo[];
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, column: number) => void;
  onPrompt: (id: string, text: string, attachments: string[]) => void;
  onInterrupt: (id: string) => void;
  onPatch: (id: string, patch: Partial<SessionRecord>) => void;
}) {
  const [dragOver, setDragOver] = useState<number | null>(null);

  const handleDrop = (e: DragEvent, column: number) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain');
    if (id) onMove(id, column);
  };

  return (
    <div className="workspace">
      {Array.from({ length: COLUMN_COUNT }, (_, column) => {
        const ids = layout.columns[column] ?? [];
        const activeId = layout.active[column] ?? ids[0] ?? null;
        const session = sessions.find((s) => s.id === activeId) ?? null;

        return (
          <section
            key={column}
            className={`workspace-column${dragOver === column ? ' drag-over' : ''}`}
            onDragOver={(e) => {
              // Without preventDefault the browser refuses the drop outright.
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOver(column);
            }}
            onDragLeave={(e) => {
              // Ignore the leave events fired while crossing child elements.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragOver((c) => (c === column ? null : c));
            }}
            onDrop={(e) => handleDrop(e, column)}
          >
            {/* Tabs only earn their vertical space once a column holds more than
                one session; a single session is dragged by its own header. */}
            {ids.length > 1 && (
              <div className="tab-bar" role="tablist">
                {ids.map((id) => {
                  const tab = sessions.find((s) => s.id === id);
                  if (!tab) return null;
                  return (
                    <div
                      key={id}
                      role="tab"
                      aria-selected={id === activeId}
                      className={id === activeId ? 'tab active' : 'tab'}
                      draggable
                      onDragStart={(e) => startDrag(e, id)}
                      onClick={() => onFocus(id)}
                    >
                      <span className={`badge agent-${tab.agent}`}>{tab.agent}</span>
                      <span className="tab-title">{tab.title}</span>
                      {tab.status === 'running' && <span className="dot-running" />}
                      <button
                        className="tab-close"
                        aria-label={`Close ${tab.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {session ? (
              <SessionView
                key={session.id}
                session={session}
                events={events[session.id] ?? []}
                agentInfo={agents.find((a) => a.id === session.agent) ?? null}
                onClose={() => onClose(session.id)}
                closeLabel="×"
                onPrompt={(text, attachments) => onPrompt(session.id, text, attachments)}
                onInterrupt={() => onInterrupt(session.id)}
                onPatch={(patch) => onPatch(session.id, patch)}
                draggable
                onDragStart={(e) => startDrag(e, session.id)}
              />
            ) : (
              <div className="workspace-empty">
                <p>Empty</p>
                <small>Open a session here, or drag one across.</small>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Start dragging a session.
 *
 * The id goes on a custom type so a column can tell a session drag from a file
 * or a text selection, and on `text/plain` as well because some browsers will
 * not begin a drag at all without it.
 */
export function startDrag(e: DragEvent, sessionId: string): void {
  e.dataTransfer.setData(DRAG_TYPE, sessionId);
  e.dataTransfer.setData('text/plain', sessionId);
  e.dataTransfer.effectAllowed = 'move';
}
