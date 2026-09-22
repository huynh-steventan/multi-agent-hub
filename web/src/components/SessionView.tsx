import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { formatBytes, formatTokens } from '../../../shared/format.ts';
import type { AgentEvent, Attachment, PermissionMode, SessionRecord } from '../../../shared/protocol.ts';
import { api, attachmentUrl, type AgentInfo } from '../api.ts';
import { usePersistentState } from '../persist.ts';
import { Markdown } from './Markdown.tsx';

/**
 * How close to the end still counts as "following along".
 *
 * Not zero: a rounded scrollHeight, a half-rendered image, or the momentum of a
 * flick all leave a pixel or two of slack, and treating that as "scrolled up"
 * would strand the transcript for someone who never left the bottom.
 */
const NEAR_BOTTOM_PX = 48;

/**
 * One session: its transcript, its composer, its settings.
 *
 * The composer draft is persisted per session. A half-written prompt is real
 * work, and this app is redeployed under the user mid-thought often enough that
 * losing it on reload was the single most annoying thing about using it. The
 * same reasoning covers attachments: they are already on the server by the time
 * they show as chips, so the pending list survives a reload too.
 */
export function SessionView({
  session,
  events,
  agentInfo,
  onClose,
  closeLabel,
  onPrompt,
  onInterrupt,
  onPatch,
  draggable = false,
  onDragStart,
}: {
  session: SessionRecord;
  events: AgentEvent[];
  agentInfo: AgentInfo | null;
  onClose: () => void;
  /** '‹' when closing means "back to the list", '×' when it means "close this pane". */
  closeLabel: string;
  onPrompt: (text: string, attachments: string[]) => void;
  onInterrupt: () => void;
  onPatch: (patch: Partial<SessionRecord>) => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
}) {
  const [draft, setDraft] = usePersistentState(`draft:${session.id}`, '');
  const [pending, setPending] = usePersistentState<Attachment[]>(`attach:${session.id}`, []);
  const [uploading, setUploading] = useState<{ key: number; name: string }[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.title);
  /** Whether the transcript is following the end of the stream. */
  const [pinned, setPinned] = useState(true);
  const stream = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** Distinguishes two in-flight uploads of identically named files. */
  const uploadKey = useRef(0);

  /**
   * Jump to the end, never animate to it.
   *
   * A scroll event cannot say who caused it, and a smooth scroll emits one at
   * every position on the way — all of them far from the bottom, all of them
   * indistinguishable from the reader having scrolled up. Animating therefore
   * unpinned the view and flashed the jump button during its own descent.
   * Jumping produces exactly one event, at the destination.
   */
  const scrollToEnd = useCallback(() => {
    const el = stream.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  /**
   * Follow the stream only while the reader is already at the end.
   *
   * Yanking someone back down mid-read is the worst thing a transcript can do,
   * and a running turn emits constantly — scrolling up to reread a tool result
   * was impossible. `pinned` is a dependency on purpose: the jump button just
   * sets it, and this is what carries out the scroll.
   */
  useEffect(() => {
    if (pinned) scrollToEnd();
  }, [events.length, pinned, scrollToEnd]);

  // A different session is a different conversation: start at its end.
  useLayoutEffect(() => {
    setPinned(true);
    scrollToEnd();
  }, [session.id, scrollToEnd]);

  /**
   * Size the composer to whatever has been typed into it.
   *
   * Height is cleared before measuring because `scrollHeight` never reports less
   * than the height already set — without the reset the box could only ever grow,
   * and deleting a paragraph would leave the empty space behind. The border is
   * added back on since `box-sizing: border-box` counts it inside `height` while
   * `scrollHeight` does not; skip it and every line sits 2px short, which shows up
   * as a permanent scrollbar. The ceiling is CSS's — past `max-height` the
   * textarea scrolls rather than pushing the transcript off screen.
   */
  const fitComposer = useCallback(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, []);

  // Layout, not effect: resizing after paint makes the box visibly jump on the
  // first character typed. `session.id` is in here because two sessions can hold
  // identical drafts, and switching between them still has to re-measure.
  useLayoutEffect(fitComposer, [fitComposer, draft, pending.length, session.id]);

  useEffect(() => {
    const el = composer.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Only width is worth reacting to: dragging a session between desktop
    // columns re-wraps the draft and changes how many lines it needs. Height
    // changes are our own writes, and following those would loop.
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fitComposer();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitComposer]);

  /**
   * Upload straight away rather than at send time.
   *
   * A phone photo is several megabytes over a tailnet; doing it while the user
   * is still typing means Send is instant, and a failure surfaces next to the
   * chip that caused it instead of blocking the whole prompt.
   */
  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setAttachError(null);
      const tickets = files.map((file) => ({ key: uploadKey.current++, file }));
      setUploading((prev) => [...prev, ...tickets.map((t) => ({ key: t.key, name: t.file.name }))]);

      await Promise.all(
        tickets.map(async ({ key, file }) => {
          try {
            const saved = await api.uploadAttachment(session.id, file);
            setPending((prev) => [...prev, saved]);
          } catch (err) {
            setAttachError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setUploading((prev) => prev.filter((u) => u.key !== key));
          }
        }),
      );
    },
    [session.id, setPending],
  );

  const removeAttachment = (attachment: Attachment) => {
    setPending((prev) => prev.filter((p) => p.storedName !== attachment.storedName));
    // Best-effort: the chip is gone either way, and a file the server failed to
    // delete is scratch space, not state anything else depends on.
    void api.deleteAttachment(session.id, attachment.storedName).catch(() => undefined);
  };

  /**
   * Rename the session.
   *
   * Display-only: the title is the hub's own label, not anything the CLI knows
   * about, so this is a plain PATCH with nothing to reconcile agent-side. Blank
   * is refused rather than accepted — an untitled row in the list is unusable on
   * a phone, and the old title is the better answer than none.
   */
  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== session.title) onPatch({ title: next });
    setEditingTitle(false);
  };

  const send = () => {
    const text = draft.trim();
    // An attachment with no words is a complete prompt — "look at this".
    if ((!text && pending.length === 0) || session.status === 'running') return;
    onPrompt(text, pending.map((a) => a.storedName));
    setDraft('');
    setPending([]);
    setAttachError(null);
  };

  // Null rather than 0 when no turn has reported usage yet (a fresh session,
  // or an agent — kimi — that never sends token counts at all): a 0 would read
  // as "this session used nothing" instead of "nothing to report".
  const tokenTotal = useMemo(() => sessionTokenTotal(events), [events]);

  return (
    <div className="pane session-pane">
      {/* The header doubles as the drag handle on desktop, so a lone session in
          a column can be moved without needing a tab bar to grab. */}
      {/* Dragging is suspended while renaming: on desktop the header is the drag
          handle, and a draggable ancestor swallows the click-and-drag that
          selecting text inside the input depends on. */}
      <header className="pane-header" draggable={draggable && !editingTitle} onDragStart={onDragStart}>
        <button className="back" onClick={onClose} aria-label="Close session">
          {closeLabel}
        </button>
        <div className="session-head">
          {editingTitle ? (
            <input
              className="session-title-input"
              value={titleDraft}
              autoFocus
              draggable={false}
              aria-label="Session title"
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                }
                // Escape abandons the edit; blur would otherwise commit it.
                if (e.key === 'Escape') {
                  setTitleDraft(session.title);
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <button
              className="session-title"
              title="Rename session"
              onClick={() => {
                setTitleDraft(session.title);
                setEditingTitle(true);
              }}
            >
              {session.title}
            </button>
          )}
          <div className="session-meta">
            <span className={`badge agent-${session.agent}`}>{session.agent}</span>
            <span>{repoName(session.repo)}</span>
            {session.status === 'running' && <span className="dot-running" />}
          </div>
        </div>
        <button className="gear" onClick={() => setShowSettings((v) => !v)} aria-label="Session settings">
          ⚙
        </button>
      </header>

      {showSettings && (
        <div className="settings-panel">
          <label className="field">
            <span>Model</span>
            <select value={session.model ?? ''} onChange={(e) => onPatch({ model: e.target.value || null })}>
              <option value="">Agent default</option>
              {(agentInfo?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Permission mode</span>
            <div className="segmented">
              {(agentInfo?.supportedModes ?? ['default']).map((m: PermissionMode) => (
                <button
                  key={m}
                  className={m === session.permissionMode ? 'seg active' : 'seg'}
                  onClick={() => onPatch({ permissionMode: m })}
                >
                  {m}
                </button>
              ))}
            </div>
          </label>

          <label className="field row">
            <input
              type="checkbox"
              checked={session.notifyDiscord}
              onChange={(e) => onPatch({ notifyDiscord: e.target.checked })}
            />
            <span>Notify Discord on turn end</span>
          </label>

          <small className="hint">Resumes as {session.nativeSessionId ?? 'a new CLI session'}</small>
        </div>
      )}

      <div className="stream-wrap">
        <div
          className="stream"
          ref={stream}
          // The scroll position is the whole signal: there is no event that says
          // a person did the scrolling, least of all under momentum on a phone.
          onScroll={(e) => {
            const el = e.currentTarget;
            setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX);
          }}
        >
          {events.map((e) => (
            <EventRow key={e.seq} event={e} sessionId={session.id} />
          ))}
        </div>
        {!pinned && (
          <button className="jump-bottom" onClick={() => setPinned(true)} aria-label="Scroll to latest">
            ↓
          </button>
        )}
      </div>

      <div
        className={dropping ? 'composer dropping' : 'composer'}
        // A file drag and a session drag both land here; only the former is
        // ours to take. Not calling preventDefault on a session drag lets it
        // bubble to the workspace column that actually handles it.
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropping(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropping(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {(pending.length > 0 || uploading.length > 0 || attachError) && (
          <div className="attachments">
            {pending.map((a) => (
              <AttachmentChip
                key={a.storedName}
                attachment={a}
                sessionId={session.id}
                onRemove={() => removeAttachment(a)}
              />
            ))}
            {uploading.map((u) => (
              <span key={u.key} className="chip uploading">
                <span className="chip-name">{u.name}</span>
                <span className="chip-meta">uploading…</span>
              </span>
            ))}
            {attachError && <span className="chip failed">{attachError}</span>}
          </div>
        )}

        {tokenTotal !== null && <div className="token-usage">{formatTokens(tokenTotal)} tokens this session</div>}

        <div className="composer-row">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              // Reset so re-picking the same file fires change again.
              e.target.value = '';
            }}
          />
          <button className="attach" onClick={() => fileInput.current?.click()} aria-label="Attach files">
            📎
          </button>
          <textarea
            ref={composer}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length === 0) return;
              // Without this some browsers also drop a filename into the text.
              e.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
            placeholder={session.status === 'running' ? 'Running…' : 'Message the agent'}
            rows={2}
          />
          {session.status === 'running' ? (
            <button className="danger" onClick={onInterrupt}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={!draft.trim() && pending.length === 0}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One attached file.
 *
 * Images show themselves — the whole point of pasting a screenshot is that you
 * can see you pasted the right one — and anything else falls back to a name and
 * a size.
 */
function AttachmentChip({
  attachment,
  sessionId,
  onRemove,
}: {
  attachment: Attachment;
  sessionId: string;
  onRemove?: () => void;
}) {
  const url = attachmentUrl(sessionId, attachment.storedName);
  const isImage = attachment.mimeType.startsWith('image/');

  return (
    <span className={isImage ? 'chip image' : 'chip'}>
      {isImage ? (
        <a href={url} target="_blank" rel="noreferrer" className="chip-thumb">
          <img src={url} alt={attachment.name} />
        </a>
      ) : null}
      <a href={url} target="_blank" rel="noreferrer" className="chip-name">
        {attachment.name}
      </a>
      <span className="chip-meta">{formatBytes(attachment.size)}</span>
      {onRemove && (
        <button className="chip-remove" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

function EventRow({ event, sessionId }: { event: AgentEvent; sessionId: string }) {
  const b = event.body;

  if (b.kind === 'text') {
    // Transcripts written before the `from` field marked the operator's echo
    // with a "> " prefix; those are still on disk, so keep reading them.
    const legacy = b.from === undefined && b.text.startsWith('> ');
    // The operator's own words are shown exactly as typed — reformatting what
    // someone just wrote reads as the app having garbled it.
    if (b.from === 'operator' || legacy)
      return <div className="row text operator">{legacy ? b.text.slice(2) : b.text}</div>;
    return (
      <div className="row text">
        <Markdown source={b.text} />
      </div>
    );
  }

  if (b.kind === 'attachments')
    return (
      <div className="row attachments">
        {b.items.map((a) => (
          <AttachmentChip key={a.storedName} attachment={a} sessionId={sessionId} />
        ))}
      </div>
    );

  if (b.kind === 'thinking')
    return (
      <details className="row thinking">
        <summary>thinking</summary>
        <pre>{b.text}</pre>
      </details>
    );

  if (b.kind === 'tool_call')
    return (
      <details className="row tool">
        <summary>
          <span className="tool-name">{b.name}</span>
        </summary>
        <pre>{JSON.stringify(b.input, null, 2)}</pre>
      </details>
    );

  if (b.kind === 'tool_result')
    return (
      <details className={b.isError ? 'row tool-result error' : 'row tool-result'}>
        <summary>{b.isError ? 'tool error' : 'tool result'}</summary>
        <pre>{b.content}</pre>
      </details>
    );

  if (b.kind === 'turn_end')
    return <div className={`row turn-end reason-${b.reason}`}>— {b.reason.replace('_', ' ')} —</div>;

  if (b.kind === 'error') return <div className="row error-row">{b.message}</div>;

  if (b.kind === 'init')
    return <div className="row init">started · {b.model ?? 'default model'}</div>;

  return (
    <details className="row raw">
      <summary>raw</summary>
      <pre>{b.line}</pre>
    </details>
  );
}

/** True when a drag is carrying files rather than a session being moved. */
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

function repoName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Sum of every turn's *fresh* token usage reported so far, or null if none has
 * any.
 *
 * Deliberately excludes `cachedTokens`: claude re-reads nearly the entire
 * prior conversation through the prompt cache on every turn, so summing that
 * field across turns compounds toward context-size × turn-count rather than
 * toward anything the operator typed or the agent wrote — a two-turn session
 * against this repo's own (large) CLAUDE.md measured 1.3M that way, almost
 * all of it repeat cache reads of the same context. `totalTokens` is used
 * where an adapter fills it in directly (qwen, which bills token credits and
 * does not separate cache reads out); otherwise it is input+output (claude
 * never sets `totalTokens`). Kimi's adapter emits no usage at all, so a kimi
 * session correctly shows nothing rather than a fake 0.
 */
function sessionTokenTotal(events: AgentEvent[]): number | null {
  let total = 0;
  let any = false;
  for (const e of events) {
    if (e.body.kind !== 'turn_end' || !e.body.usage) continue;
    const { totalTokens, inputTokens, outputTokens } = e.body.usage;
    const parts = [inputTokens, outputTokens].filter((n): n is number => n !== null);
    const turnTotal = totalTokens ?? (parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null);
    if (turnTotal === null) continue;
    total += turnTotal;
    any = true;
  }
  return any ? total : null;
}
