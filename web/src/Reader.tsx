import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import type { NoteFull, NoteSummary, TranscriptSegment } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import { Markdown } from './Markdown';
import { toast } from './App';
import { PersonStar } from './starredPeople';
import { useMyTags } from './myTags';
import { NotePeopleGraph } from './NotePeopleGraph';
import { inlineMarkdown, peopleForGraph, Transcript } from './noteBits';
import { SharePanel } from './SharePanel';
import { parsePersonEntry, peopleList, personKey, withoutInitials } from '../../shared/names';
import { cx, fmtDate, fmtDuration, fmtReadTime, fmtRelative, fmtTime, fmtTokens, fmtUsd, go, href, tagStyle, textFragmentLink, timeLink } from './util';

export function Reader({ slug, tick, notes, highlight }: { slug: string; tick: number; notes: NoteSummary[]; highlight?: string }) {
  const [note, setNote] = useState<NoteFull | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<'notes' | 'transcript'>('notes');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [menu, setMenu] = useState(false);
  const dirty = editing && note && (draft !== note.body || draftTitle !== note.meta.title);

  useEffect(() => {
    api
      .note(slug)
      .then((n) => {
        setNote(n);
        setMissing(false);
      })
      .catch(() => setMissing(true));
  }, [slug, tick]);

  // Where in the markdown to put the cursor when editing starts from a double-click.
  const startAt = useRef<number | null>(null);

  function startEdit() {
    if (!note) return;
    setDraft(note.body);
    setDraftTitle(note.meta.title);
    setEditing(true);
    setTab('notes');
  }

  /** Double-clicking the note opens the editor with the cursor at the word that was clicked. */
  function editFromDoubleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('a, button, input, textarea')) return;
    startAt.current = note ? sourceOffset(note.body, window.getSelection()) : null;
    window.getSelection()?.removeAllRanges();
    startEdit();
  }

  async function save() {
    if (!note) return;
    try {
      const n = await api.updateNote(slug, { body: draft, title: draftTitle });
      setNote(n);
      setEditing(false);
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function patch(p: Parameters<typeof api.updateNote>[1]) {
    try {
      setNote(await api.updateNote(slug, p));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      // ⌘S or ⌘↵ saves. Caught before the editor sees it, so ⌘↵ doesn't also insert a line.
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) {
        e.preventDefault();
        e.stopPropagation();
        save();
      }
      if (e.key === 'Escape' && !dirty) setEditing(false);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });

  const notePeople = useMemo(
    () => (note ? peopleForGraph(note.meta.people, note.speakers?.length ? note.speakers : note.meta.type === 'article' && note.meta.author ? [note.meta.author] : []) : []),
    [note],
  );

  if (missing)
    return (
      <div className="empty-reader">
        <h2>Note not found</h2>
        <p className="muted">It may have been renamed or deleted.</p>
        <a className="btn" href="#/">
          Back to library
        </a>
      </div>
    );
  if (!note) return <div className="reader-loading" />;

  const m = note.meta;
  const isArticle = m.type === 'article';
  const displayBody = note.body.replace(/^# .*\n+/, ''); // title is shown in the header

  return (
    <div className="reader">
      <div className="reader-scroll">
        <article className="article">
          <a className="back-link" href="#/">
            <Icon name="arrowLeft" size={14} /> Library
          </a>
          <header className="note-head">
            {m.thumbnail && !editing && (
              <a className={cx('hero', isArticle && 'hero-article')} href={m.url} target="_blank" rel="noreferrer" title={isArticle ? 'Read the original' : 'Watch on YouTube'}>
                <img src={m.thumbnail.replace('hqdefault', 'maxresdefault')} onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    if (img.src !== m.thumbnail) img.src = m.thumbnail!;
                    else (img.closest('.hero') as HTMLElement).classList.add('hero-broken');
                  }} alt="" />
                {!isArticle && (
                  <span className="hero-play">
                    <Icon name="play" size={18} fill />
                  </span>
                )}
                {m.duration ? <span className="hero-dur">{fmtTime(m.duration)}</span> : null}
              </a>
            )}
            {editing ? (
              <input className="title-input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} aria-label="Title" />
            ) : (
              <h1 className="note-title">
                {m.url ? (
                  <a href={m.url} target="_blank" rel="noreferrer" title={isArticle ? 'Read the original' : 'Watch on YouTube'}>
                    {m.title}
                  </a>
                ) : (
                  m.title
                )}
              </h1>
            )}
            <div className="note-meta">
              {isArticle && <SpeakersField names={note.speakers?.length ? note.speakers : m.author ? [m.author] : []} empty="Add author" onSave={(speakers) => patch({ speakers })} />}
              {m.channel &&
                (m.channel_url ? (
                  <a href={m.channel_url} target="_blank" rel="noreferrer">
                    {m.channel}
                  </a>
                ) : (
                  <span>{m.channel}</span>
                ))}
              {m.published && <span>{fmtDate(m.published)}</span>}
              {m.duration ? <span>{fmtDuration(m.duration)}</span> : null}
              {isArticle && m.words ? <span>{fmtReadTime(m.words)}</span> : null}
              <span title={new Date(m.added).toLocaleString()}>added {fmtRelative(m.added)}</span>
            </div>
            {!isArticle && m.transcript && (
              <div className="note-speakers">
                <span className="note-speakers-label">Speaking</span>
                <SpeakersField names={note.speakers || []} empty="Add speakers" onSave={(speakers) => patch({ speakers })} />
              </div>
            )}
            <TagEditor tags={m.tags} myTags={m.my_tags || []} onChange={(p) => patch(p)} />
            <div className="note-actions">
              {editing ? (
                <>
                  <button className="btn btn-primary" onClick={save}>
                    <Icon name="check" size={14} /> Save <kbd>⌘S</kbd>
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (!dirty || confirm('Discard your changes?')) setEditing(false);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={startEdit}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <button className={cx('btn', m.starred && 'btn-starred')} onClick={() => patch({ starred: !m.starred })} aria-pressed={!!m.starred}>
                    <Icon name="star" size={14} fill={!!m.starred} /> {m.starred ? 'Starred' : 'Star'}
                  </button>
                  {m.url && (
                    <a className="btn" href={m.url} target="_blank" rel="noreferrer">
                      <Icon name="external" size={14} /> {isArticle ? 'Read original' : 'Watch'}
                    </a>
                  )}
                  <SharePanel slug={slug} meta={m} />
                  <div className="menu-wrap">
                    <button className="btn btn-icon" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
                      <Icon name="more" size={16} />
                    </button>
                    {menu && (
                      <div className="menu" onMouseLeave={() => setMenu(false)}>
                        <button
                          onClick={async () => {
                            setMenu(false);
                            await api.reconnect(slug);
                            toast('Looking for connections…');
                          }}
                        >
                          <Icon name="link" size={14} /> Find connections again
                        </button>
                        {m.transcript && (
                          <button
                            onClick={async () => {
                              setMenu(false);
                              if (!confirm(isArticle ? 'Regenerate the summary from the saved article text? Your "My notes" section is kept; the rest of the body is replaced.' : 'Regenerate the summary from the transcript? Your "My notes" section is kept; the rest of the body is replaced.')) return;
                              await api.resummarise(slug);
                              toast('Re-summarising…');
                            }}
                          >
                            <Icon name="sparkle" size={14} /> Re-summarise
                          </button>
                        )}
                        <button
                          className="danger"
                          onClick={async () => {
                            setMenu(false);
                            if (!confirm(`Move “${m.title}” to the vault's .trash folder?`)) return;
                            await api.deleteNote(slug);
                            go({});
                          }}
                        >
                          <Icon name="trash" size={14} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </header>

          {!editing && m.transcript && (
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'notes'} className={cx('tab', tab === 'notes' && 'active')} onClick={() => setTab('notes')}>
                Notes
              </button>
              <button role="tab" aria-selected={tab === 'transcript'} className={cx('tab', tab === 'transcript' && 'active')} onClick={() => setTab('transcript')}>
                {isArticle ? 'Article text' : 'Transcript'}
                {m.transcript_source === 'auto' && <span className="tab-note">auto-captions</span>}
                {m.transcript_source === 'none' && <span className="tab-note">none found</span>}
                {m.pasted && <span className="tab-note">pasted</span>}
                {m.archived && <span className="tab-note" title={m.archived}>from archive{m.archived_date ? ` (${m.archived_date})` : ''}</span>}
              </button>
            </div>
          )}

          {editing ? (
            <div className="editor">
              <CodeMirror
                value={draft}
                onChange={setDraft}
                autoFocus
                onCreateEditor={(view) => {
                  const at = startAt.current;
                  startAt.current = null;
                  if (at == null) return;
                  view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) }, scrollIntoView: true });
                  // Keep the spot that was double-clicked roughly where it was on screen.
                  requestAnimationFrame(() => view.dispatch({ effects: EditorView.scrollIntoView(Math.min(at, view.state.doc.length), { y: 'center' }) }));
                }}
                basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
                extensions={[markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping]}
                theme="none"
              />
              <p className="editor-hint">
                Markdown. Link to other notes with <code>[[note-slug]]</code>. Connections are managed in the panel, not here. <kbd>⌘</kbd><kbd>↵</kbd> saves, <kbd>Esc</kbd> leaves if nothing changed.
              </p>
            </div>
          ) : tab === 'notes' ? (
            <div className="note-body" onDoubleClick={(e) => editFromDoubleClick(e)}>
              <Markdown source={displayBody} />
            </div>
          ) : (
            <Transcript slug={slug} url={m.url} highlight={highlight} article={isArticle} />
          )}
        </article>

        <aside className="links-panel">
          {notePeople.length && !editing ? (
            <div className="panel-block">
              <h3 className="panel-h">People</h3>
              <NotePeopleGraph slug={slug} people={notePeople} />
            </div>
          ) : null}
          <Connections note={note} notes={notes} onChange={(connections) => patch({ connections })} reload={() => api.note(slug).then(setNote)} />
          {m.works?.length && !editing ? (
            <div className="panel-block">
              <h3 className="panel-h">Works</h3>
              <ul className="works">
                {m.works.map((w) => (
                  <li key={w}>
                    <span>{inlineMarkdown(w)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="panel-block file-info">
            <span>notes/{slug}.md</span>
            {m.model && <span>summarised by {m.model}</span>}
            {note.cost && (
              <span title={`${note.cost.calls} model call${note.cost.calls === 1 ? '' : 's'}`}>
                cost {fmtUsd(note.cost.cost)} · {fmtTokens(note.cost.input)} in / {fmtTokens(note.cost.output)} out
              </span>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------- tags ----------

/**
 * The note's tags. Yours (added by hand) come first, drawn as the house's highlighted tag; the model's
 * follow. Adding a tag always adds one of yours, and offers the ones you've used before.
 */
function TagEditor({ tags, myTags, onChange }: { tags: string[]; myTags: string[]; onChange: (p: { tags?: string[]; myTags?: string[] }) => void }) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const everMine = useMyTags();
  const suggestions = [...everMine].filter((t) => !myTags.includes(t)).sort();
  const auto = tags.filter((t) => !myTags.includes(t));
  function commit() {
    const t = val.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    // The server moves a tag the model had already given the note into your list.
    if (t && !myTags.includes(t)) onChange({ myTags: [...myTags, t] });
    setVal('');
    setAdding(false);
  }
  return (
    <div className="tags">
      {myTags.map((t) => (
        <span key={t} className="tag tag-mine" style={tagStyle(t, true)} title="Your tag">
          <a href={href({ tag: t })}>{t}</a>
          <button className="tag-x" onClick={() => onChange({ myTags: myTags.filter((x) => x !== t) })} aria-label={`Remove your tag ${t}`}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      {auto.map((t) => (
        <span key={t} className="tag" style={tagStyle(t, everMine.has(t))}>
          <a href={href({ tag: t })}>{t}</a>
          <button className="tag-x" onClick={() => onChange({ tags: tags.filter((x) => x !== t) })} aria-label={`Remove tag ${t}`}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            className="tag-input"
            autoFocus
            list="my-tag-suggestions"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder="your tag"
          />
          <datalist id="my-tag-suggestions">
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </>
      ) : (
        <button className="tag tag-add" onClick={() => setAdding(true)} title="Add a tag of your own">
          <Icon name="plus" size={11} /> tag
        </button>
      )}
    </div>
  );
}

// ---------- connections ----------

function Strength({ n = 2 }: { n?: number }) {
  return (
    <span className="strength" title={['', 'Suggestive', 'Clearly related', 'In direct dialogue'][n] || ''}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

function Connections({
  note,
  notes,
  onChange,
  reload,
}: {
  note: NoteFull;
  notes: NoteSummary[];
  onChange: (c: NoteFull['meta']['connections']) => void;
  reload: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const outgoing = note.connections;
  // Backlinks that aren't already shown as outgoing links.
  const incoming = note.backlinks.filter((b) => !outgoing.some((o) => o.target === b.slug));

  async function unlinkIncoming(from: string) {
    const src = await api.note(from);
    await api.updateNote(from, { connections: src.meta.connections.filter((c) => c.target !== note.slug) });
    reload();
  }

  return (
    <div className="panel-block">
      <div className="panel-h-row">
        <h3 className="panel-h">Connections</h3>
        <button className="icon-btn" onClick={() => setPicking(!picking)} title="Link to another note" aria-label="Add connection">
          <Icon name="plus" size={14} />
        </button>
      </div>
      {picking && (
        <LinkPicker
          notes={notes.filter((n) => n.slug !== note.slug && !outgoing.some((o) => o.target === n.slug))}
          onPick={(target, reason) => {
            onChange([...note.meta.connections, { target, reason, strength: 2, manual: true }]);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}
      {outgoing.length === 0 && incoming.length === 0 && !picking && (
        <p className="panel-empty">No connections yet. They're found automatically as your library grows, or add one with +.</p>
      )}
      <ul className="conn-list">
        {outgoing.map((c) => (
          <li key={c.target} className={cx('conn', !c.exists && 'conn-missing')}>
            <div className="conn-top">
              <a href={href({ slug: c.target })} className="conn-title">
                {c.title}
              </a>
              <button
                className="icon-btn conn-x"
                onClick={() => onChange(note.meta.connections.filter((x) => x.target !== c.target))}
                aria-label={`Remove connection to ${c.title}`}
                title="Remove"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
            {c.reason && <p className="conn-reason">{c.reason}</p>}
            <div className="conn-foot">
              <Strength n={c.strength} />
              {c.manual && <span className="conn-kind">added by you</span>}
            </div>
          </li>
        ))}
        {incoming.map((b) => (
          <li key={b.slug} className="conn conn-in">
            <div className="conn-top">
              <a href={href({ slug: b.slug })} className="conn-title">
                {b.title}
              </a>
              <button className="icon-btn conn-x" onClick={() => unlinkIncoming(b.slug)} aria-label={`Remove connection from ${b.title}`} title="Remove">
                <Icon name="x" size={12} />
              </button>
            </div>
            {b.reason && <p className="conn-reason">{b.reason}</p>}
            <div className="conn-foot">
              <Strength n={b.strength} />
              <span className="conn-kind">links here</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LinkPicker({ notes, onPick, onCancel }: { notes: NoteSummary[]; onPick: (slug: string, reason: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<NoteSummary | null>(null);
  const [reason, setReason] = useState('');
  const matches = useMemo(() => {
    const t = q.toLowerCase();
    return notes.filter((n) => !t || n.title.toLowerCase().includes(t) || n.tags.some((x) => x.includes(t))).slice(0, 8);
  }, [q, notes]);
  if (chosen)
    return (
      <form
        className="picker"
        onSubmit={(e) => {
          e.preventDefault();
          onPick(chosen.slug, reason.trim());
        }}
      >
        <div className="picker-chosen">→ {chosen.title}</div>
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why do these connect? (optional)" />
        <div className="picker-actions">
          <button className="btn btn-primary btn-sm" type="submit">
            Link
          </button>
          <button className="btn btn-sm" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    );
  return (
    <div className="picker">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a note to link…" onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <ul>
        {matches.map((n) => (
          <li key={n.slug}>
            <button onClick={() => setChosen(n)}>{n.title}</button>
          </li>
        ))}
        {matches.length === 0 && <li className="muted small">No matching notes</li>}
      </ul>
    </div>
  );
}

// ---------- speakers ----------

/** Who speaks in the source (an article's authors), editable in place. Saving also updates the people graph. */
function SpeakersField({ names, empty, onSave }: { names: string[]; empty: string; onSave: (names: string) => Promise<void> | void }) {
  const shown = names.join(', ');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(shown);
  useEffect(() => setValue(shown), [shown]);

  if (!editing) {
    const edit = (
      <button className={cx('author-btn', !shown && 'author-empty')} onClick={() => setEditing(true)} title="Edit names (separate several with commas)">
        {shown ? null : empty}
        <Icon name="edit" size={11} />
      </button>
    );
    if (!names.length) return edit;
    // Each name has its own star; clicking a name edits the list.
    return (
      <span className="speaker-names">
        {names.map((n, i) => (
          <span key={n} className="speaker-name">
            <PersonStar name={n} />
            <button className="author-btn" onClick={() => setEditing(true)} title="Edit names (separate several with commas)">
              {n}
              {i < names.length - 1 ? ',' : <Icon name="edit" size={11} />}
            </button>
          </span>
        ))}
      </span>
    );
  }

  const done = async (save: boolean) => {
    setEditing(false);
    if (save && value.trim() !== shown) await onSave(value.trim());
    else setValue(shown);
  };
  return (
    <input
      className="author-input"
      autoFocus
      value={value}
      placeholder="Names, separated by commas"
      aria-label="Names"
      size={Math.max(18, value.length + 2)}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(shown);
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * Find a rendered selection in the markdown source: the clicked word with some text either side,
 * searched for verbatim, then with less context (formatting marks can split the rendered text).
 */
function sourceOffset(md: string, sel: Selection | null): number | null {
  const node = sel?.anchorNode;
  if (!sel || !node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent || '';
  const at = Math.min(sel.anchorOffset, sel.focusOffset);
  for (const span of [40, 20, 8, 0]) {
    const before = text.slice(Math.max(0, at - span), at);
    const word = text.slice(at, Math.max(at, sel.anchorOffset, sel.focusOffset)) || text.slice(at, at + 1);
    const probe = before + word;
    if (!probe.trim()) continue;
    const i = md.indexOf(probe);
    if (i >= 0 && (span > 0 || md.indexOf(probe, i + 1) < 0)) return i + before.length;
  }
  return null;
}
