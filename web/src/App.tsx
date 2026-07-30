import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentId, RepoEntry, SessionRecord, UsageSnapshot } from '../../shared/protocol.ts';
import { api, HubSocket, type AgentInfo } from './api.ts';
import {
  closeSession as closeInLayout,
  emptyLayout,
  focusSession,
  moveSession,
  normalize,
  openIds,
  openSession,
  type Layout,
} from './layout.ts';
import { load, save } from './persist.ts';
import { NewSessionSheet, clearNewSessionDraft, type NewSessionInput } from './components/NewSessionSheet.tsx';
import { SessionList } from './components/SessionList.tsx';
import { SessionView } from './components/SessionView.tsx';
import { UsageStrip } from './components/UsageStrip.tsx';
import { Workspace } from './components/Workspace.tsx';

/**
 * Below this width the workspace collapses to one session at a time.
 *
 * Three columns want roughly 340px each to stay usable, which is what this
 * leaves once the sidebar is accounted for.
 */
const DESKTOP_MIN_WIDTH = 1100;

const LAYOUT_KEY = 'layout';
const ACTIVE_KEY = 'active-session';

export function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [defaults, setDefaults] = useState<{ lastRepo: string | null; lastAgent: AgentId | null }>({
    lastRepo: null,
    lastAgent: null,
  });
  const [usage, setUsage] = useState<UsageSnapshot[]>([]);
  /** Transcripts, keyed by session — several stream at once on desktop. */
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const desktop = useIsDesktop();
  const [layout, setLayout] = useState<Layout>(emptyLayout);
  const [activeId, setActiveId] = useState<string | null>(() => load<string | null>(ACTIVE_KEY, null));

  const socket = useRef<HubSocket | null>(null);

  useEffect(() => {
    const s = new HubSocket();
    s.connect();
    socket.current = s;

    const off = s.on((frame) => {
      if (frame.type === 'usage') setUsage(frame.usage);
      if (frame.type === 'history') {
        setEvents((prev) => ({ ...prev, [frame.sessionId]: frame.events }));
      }
      if (frame.type === 'event') {
        const id = frame.event.sessionId;
        setEvents((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), frame.event] }));
      }
      if (frame.type === 'session') {
        setSessions((prev) => prev.map((x) => (x.id === frame.session.id ? frame.session : x)));
      }
    });

    return () => {
      off();
      s.close();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [agentList, sessionData, usageData] = await Promise.all([api.agents(), api.sessions(), api.usage()]);
      setAgents(agentList);
      setSessions(sessionData.sessions);
      setDefaults(sessionData.defaults);
      setUsage(usageData);

      // The stored layout is only trustworthy once the real session list is in
      // hand — sessions may have been deleted since it was written.
      const known = new Set(sessionData.sessions.map((s) => s.id));
      const repaired = normalize(load<unknown>(LAYOUT_KEY, null), known);
      save(LAYOUT_KEY, repaired);
      setLayout(repaired);
      setActiveId((current) => (current && known.has(current) ? current : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Repos are scanned from disk and can be slow, so they load independently
    // of the critical path rather than blocking the first paint.
    api.repos().then(setRepos).catch(() => undefined);
  }, [refresh]);

  const updateLayout = useCallback((next: Layout | ((prev: Layout) => Layout)) => {
    setLayout((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      save(LAYOUT_KEY, value);
      return value;
    });
  }, []);

  const selectSession = useCallback(
    (id: string | null) => {
      setActiveId(id);
      save(ACTIVE_KEY, id);
    },
    [],
  );

  /** Everything that should be streaming right now, whichever layout is in use. */
  const visibleIds = useMemo(
    () => (desktop ? openIds(layout) : activeId ? [activeId] : []),
    [desktop, layout, activeId],
  );

  // One subscription per visible session; dropping one stops the server sending
  // events nothing is rendering.
  useEffect(() => {
    socket.current?.syncSubscriptions(visibleIds);
  }, [visibleIds]);

  const openInView = useCallback(
    (id: string) => {
      if (desktop) updateLayout((prev) => openSession(prev, id));
      else selectSession(id);
    },
    [desktop, updateLayout, selectSession],
  );

  const closeInView = useCallback(
    (id: string) => {
      if (desktop) updateLayout((prev) => closeInLayout(prev, id));
      else selectSession(null);
    },
    [desktop, updateLayout, selectSession],
  );

  const createSession = useCallback(
    async (input: NewSessionInput) => {
      try {
        const session = await api.createSession(input);
        setSessions((prev) => [session, ...prev]);
        setDefaults({ lastRepo: session.repo, lastAgent: session.agent });
        clearNewSessionDraft();
        setComposing(false);
        openInView(session.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [openInView],
  );

  const patchSession = useCallback(async (id: string, patch: Partial<SessionRecord>) => {
    try {
      const updated = await api.updateSession(id, patch);
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const removeSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id).catch(() => undefined);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setEvents((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      updateLayout((prev) => closeInLayout(prev, id));
      setActiveId((current) => (current === id ? null : current));
    },
    [updateLayout],
  );

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);

  const list = (
    <SessionList
      sessions={sessions}
      openIds={desktop ? openIds(layout) : []}
      variant={desktop ? 'sidebar' : 'page'}
      onOpen={openInView}
      onNew={() => setComposing(true)}
      onDelete={(id) => void removeSession(id)}
    />
  );

  return (
    <div className={desktop ? 'app desktop' : 'app'}>
      <UsageStrip usage={usage} />

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="dismiss">tap to dismiss</span>
        </div>
      )}

      {desktop ? (
        <div className="desktop-body">
          {list}
          <Workspace
            layout={layout}
            sessions={sessions}
            events={events}
            agents={agents}
            onFocus={(id) => updateLayout((prev) => focusSession(prev, id))}
            onClose={closeInView}
            onMove={(id, column) => updateLayout((prev) => moveSession(prev, id, column))}
            onPrompt={(id, text, attachments) => socket.current?.prompt(id, text, attachments)}
            onInterrupt={(id) => socket.current?.interrupt(id)}
            onPatch={(id, patch) => void patchSession(id, patch)}
          />
        </div>
      ) : active ? (
        <SessionView
          session={active}
          events={events[active.id] ?? []}
          agentInfo={agents.find((a) => a.id === active.agent) ?? null}
          onClose={() => selectSession(null)}
          closeLabel="‹"
          onPrompt={(text, attachments) => socket.current?.prompt(active.id, text, attachments)}
          onInterrupt={() => socket.current?.interrupt(active.id)}
          onPatch={(patch) => void patchSession(active.id, patch)}
        />
      ) : (
        list
      )}

      {composing && (
        <NewSessionSheet
          agents={agents}
          repos={repos}
          defaults={defaults}
          variant={desktop ? 'modal' : 'sheet'}
          onCancel={() => setComposing(false)}
          onCreate={(input) => void createSession(input)}
        />
      )}
    </div>
  );
}

/** Tracks the workspace breakpoint, so a resize switches layouts live. */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const update = () => setDesktop(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return desktop;
}
