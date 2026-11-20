import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStatus, NoteSummary, QueueItem, SearchHit, StarredPerson } from '../../shared/types';
import { api, subscribe } from './api';
import { Icon } from './icons';
import { Reader } from './Reader';
import { QueueView } from './QueueView';
import { GraphView } from './GraphView';
import { TagsView } from './TagsView';
import { SettingsView } from './SettingsView';
import { UsageView } from './UsageView';
import { PanelToggles, PanelsContext, useHiddenPanels } from './layout';
import { MyTagsContext, useMyTags } from './myTags';
import { StarredPeopleContext, matchesStarred, type StarredPeople } from './starredPeople';
import { cx, fmtDate, fmtDuration, fmtReadTime, fmtTime, fmtUsd, go, href, tagStyle, useRoute, type Route } from './util';

// ---------- toasts ----------
type Toast = { id: number; text: string; kind?: 'error' };
let pushToast: (t: string, kind?: 'error') => void = () => {};
export const toast = (t: string, kind?: 'error') => pushToast(t, kind);

export default function App() {
  const route = useRoute();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tick, setTick] = useState(0); // bumps when the vault changes
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [starredList, setStarredList] = useState<StarredPerson[]>([]);

  pushToast = (text, kind) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  };

  const loadNotes = useCallback(() => api.notes().then(setNotes).catch(() => {}), []);
  const loadQueue = useCallback(() => {
    api.queue().then(setQueue).catch(() => {});
    api.status().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    loadNotes();
    loadQueue();
    let timer: number | undefined;
    const unsub = subscribe({
      vault: () => {
        // Coalesce bursts of file events.
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          loadNotes();
          setTick((t) => t + 1);
        }, 150);
      },
      queue: loadQueue,
    });
    const iv = setInterval(loadQueue, 30_000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, [loadNotes, loadQueue]);

  // Starred people: reloaded with the vault, since their note lists follow the notes.
  useEffect(() => {
    api.starredPeople().then(setStarredList).catch(() => {});
  }, [tick]);
  // Your tags: ones you've added by hand that the model doesn't also use. These are listed first and
  // drawn as your own everywhere. (Adding one of the model's tags, such as "christianity", by hand makes
  // it yours on that note only; otherwise one hand-added tag would turn a hundred notes yellow.)
  const myTags = useMemo(() => {
    const mine = new Set<string>();
    const theirs = new Set<string>();
    for (const n of notes || []) {
      const own = n.myTags || [];
      for (const t of own) mine.add(t);
      for (const t of n.tags) if (!own.includes(t)) theirs.add(t);
    }
    for (const t of theirs) mine.delete(t);
    return mine;
  }, [notes]);
  const starredPeople = useMemo<StarredPeople>(
    () => ({
      list: starredList,
      isStarred: (name) => matchesStarred(starredList, name),
      toggle: (name) => {
        const on = !matchesStarred(starredList, name);
        api
          .starPerson(name, on)
          .then((l) => {
            setStarredList(l);
            toast(on ? `Starred ${name}` : `Unstarred ${name}`);
          })
          .catch((e) => toast((e as Error).message, 'error'));
      },
    }),
    [starredList],
  );

  const panels = useHiddenPanels();
  const { hidden } = panels;

  const active = queue.filter((q) => q.status === 'queued' || q.status === 'processing').length;
  const errors = queue.filter((q) => q.status === 'error').length;

  return (
    <MyTagsContext.Provider value={myTags}>
    <StarredPeopleContext.Provider value={starredPeople}>
    <PanelsContext.Provider value={panels}>
    <div className="shell">
    {/* House style: one buttercup band across the top. Slim here (22/28 title on one line) so the app
        keeps its information density; see styles.css. */}
    <header className="band">
      <a className="band-title" href="#/">Exo-mind</a>
      <span className="band-sub">Notes on what you watch and read, and how they connect</span>
      <span className="band-version">v{__APP_VERSION__}</span>
    </header>
    <div className={cx('app', route.view === 'library' && hidden.nav && 'hide-nav', hidden.list && 'hide-list', hidden.links && 'hide-links')}>
      <Sidebar route={route} notes={notes || []} people={starredList} status={status} active={active} errors={errors} />
      <main className="main">
        {route.view === 'library' && <Library route={route} notes={notes} people={starredList} tick={tick} />}
        {route.view === 'queue' && <QueueView queue={queue} status={status} reload={loadQueue} />}
        {route.view === 'graph' && <GraphView tick={tick} />}
        {route.view === 'tags' && <TagsView notes={notes || []} />}
        {route.view === 'settings' && <SettingsView status={status} onSaved={loadQueue} />}
        {route.view === 'usage' && <UsageView tick={tick} status={status} />}
      </main>
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', t.kind === 'error' && 'toast-error')}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
    </div>
    </PanelsContext.Provider>
    </StarredPeopleContext.Provider>
    </MyTagsContext.Provider>
  );
}

// ---------- sidebar ----------

function Sidebar({ route, notes, people, status, active, errors }: { route: Route; notes: NoteSummary[]; people: StarredPerson[]; status: AppStatus | null; active: number; errors: number }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = useMyTags();
  // Your own tags get their own list at the top, all of them; the model's most frequent follow.
  const [myTagList, topTags] = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) c.set(t, (c.get(t) || 0) + 1);
    const all = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [all.filter(([t]) => mine.has(t)), all.filter(([t]) => !mine.has(t)).slice(0, 10)];
  }, [notes, mine]);
  const starredCount = notes.filter((n) => n.starred).length;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.addUrl(url.trim());
      if (r.exists) {
        toast('Already in your library');
        go({ slug: r.exists });
      } else toast('Added to the queue');
      setUrl('');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const healthy = status && status.ytdlp.ok && status.apiKey && status.playlistUrl;
  const libActive = route.view === 'library' && !route.tags.length && !route.starred && !route.person;

  return (
    <nav className="sidebar">
      <form className="addlink" onSubmit={add}>
        <Icon name="plus" size={14} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a video or article link…" disabled={busy} aria-label="Add a link" />
      </form>

      <div className="nav">
        <a className={cx('nav-item', libActive && 'active')} href="#/">
          <Icon name="library" /> Library <span className="count">{notes.length || ''}</span>
        </a>
        <a className={cx('nav-item', route.starred && 'active')} href={href({ starred: true })}>
          <Icon name="star" /> Starred <span className="count">{starredCount || ''}</span>
        </a>
        <a className={cx('nav-item', route.view === 'queue' && 'active')} href="#/queue">
          <Icon name="queue" /> Queue
          {errors > 0 ? <span className="badge badge-error">{errors}</span> : active > 0 ? <span className="badge">{active}</span> : null}
        </a>
        <a className={cx('nav-item', route.view === 'graph' && 'active')} href="#/graph">
          <Icon name="graph" /> Graph
        </a>
        <a className={cx('nav-item', route.view === 'tags' && 'active')} href="#/tags">
          <Icon name="tag" /> Tags
        </a>
        <a className={cx('nav-item', route.view === 'usage' && 'active')} href="#/usage">
          <Icon name="coin" /> Usage
          {status && <span className={cx('count', status.overBudget && 'count-warn')}>{fmtUsd(status.monthSpend, 2)}</span>}
        </a>
      </div>

      {people.length > 0 && (
        <div className="nav-section">
          <div className="nav-heading">Starred people</div>
          {people.map((p) => (
            <a
              key={p.key}
              className={cx('nav-tag', route.person === p.key && 'active')}
              href={href({ person: route.person === p.key ? undefined : p.key, tags: route.tags, starred: route.starred })}
              title={[p.appears.length && `speaks in ${p.appears.length}`, p.mentioned.length && `mentioned in ${p.mentioned.length}`].filter(Boolean).join(', ') || 'Not in any notes yet'}
            >
              <Icon name="star" size={11} fill className="nav-star" />
              {p.name}
              <span className="count">{p.appears.length + p.mentioned.length || ''}</span>
            </a>
          ))}
        </div>
      )}

      {myTagList.length > 0 && (
        <div className="nav-section">
          <div className="nav-heading">My tags</div>
          {myTagList.map(([t, n]) => (
            <a
              key={t}
              className={cx('nav-tag', route.tags.includes(t) && 'active')}
              href={href({ tags: toggleTag(route.tags, t), starred: route.starred, person: route.person })}
              title={route.tags.includes(t) ? `Remove #${t} from the filter` : route.tags.length ? `Also require #${t}` : `Show notes tagged #${t}`}
            >
              <span className="dot dot-mine" />
              {t}
              <span className="count">{n}</span>
            </a>
          ))}
        </div>
      )}

      {topTags.length > 0 && (
        <div className="nav-section">
          <div className="nav-heading">Frequent tags</div>
          {topTags.map(([t, n]) => (
            <a
              key={t}
              className={cx('nav-tag', route.tags.includes(t) && 'active')}
              href={href({ tags: toggleTag(route.tags, t), starred: route.starred, person: route.person })}
              title={route.tags.includes(t) ? `Remove #${t} from the filter` : route.tags.length ? `Also require #${t}` : `Show notes tagged #${t}`}
            >
              <span className="dot" style={tagStyle(t)} />
              {t}
              <span className="count">{n}</span>
            </a>
          ))}
        </div>
      )}

      <div className="sidebar-foot">
        <a className={cx('nav-item', route.view === 'settings' && 'active')} href="#/settings">
          <Icon name="settings" /> Settings
        </a>
        <a className="status-line" href={healthy ? '#/queue' : '#/settings'}>
          <span className={cx('status-dot', !status ? '' : status.overBudget ? 'warn' : status.working ? 'busy' : healthy ? (status.paused ? 'paused' : 'ok') : 'warn')} />
          {!status
            ? 'Connecting…'
            : status.overBudget
              ? 'Monthly budget reached'
              : status.working
              ? 'Working…'
              : !healthy
                ? 'Setup needed'
                : status.paused
                  ? 'Paused'
                  : status.lastPollError
                    ? 'Playlist check failed'
                    : 'Watching playlist'}
        </a>
      </div>
    </nav>
  );
}

// ---------- library: list + reader ----------

function Library({ route, notes, people, tick }: { route: Route; notes: NoteSummary[] | null; people: StarredPerson[]; tick: number }) {
  const mine = useMyTags();
  const person = route.person ? people.find((p) => p.key === route.person) : undefined;
  const mentionedOnly = useMemo(() => new Set(person?.mentioned || []), [person]);
  const [q, setQ] = useState(route.q || '');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [sort, setSort] = useState<'added' | 'published' | 'links'>('added');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (route.q !== undefined) setQ(route.q);
  }, [route.q]);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => api.search(q).then(setHits).catch(() => setHits([])), 160);
    return () => clearTimeout(t);
  }, [q, tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => {
    let list = notes || [];
    if (route.tags.length) list = list.filter((n) => route.tags.every((t) => n.tags.includes(t)));
    if (route.starred) list = list.filter((n) => n.starred);
    if (route.person) {
      const theirs = new Set([...(person?.appears || []), ...(person?.mentioned || [])]);
      list = list.filter((n) => theirs.has(n.slug));
    }
    const sorted = [...list];
    if (sort === 'published') sorted.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    if (sort === 'links') sorted.sort((a, b) => b.links - a.links);
    return sorted;
  }, [notes, route.tags.join(','), route.starred, route.person, person, sort]);

  async function newNote() {
    const title = prompt('Title for the new note');
    if (!title) return;
    const { slug } = await api.createNote(title);
    go({ slug });
  }

  const filtering = route.tags.length > 0 || route.starred || !!route.person;
  const listTitle = person ? person.name : route.person ? 'No longer starred' : route.starred ? 'Starred' : 'Library';
  // Search results are narrowed by the same tag and star filters as the list.
  const allowed = filtering ? new Set(filtered.map((n) => n.slug)) : null;
  const shownHits = hits && allowed ? hits.filter((h) => allowed.has(h.slug)) : hits;
  // Tags that would narrow the current list further, most common first.
  const moreTags = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of filtered) for (const t of n.tags) if (!route.tags.includes(t)) c.set(t, (c.get(t) || 0) + 1);
    return [...c.entries()].sort((a, b) => Number(mine.has(b[0])) - Number(mine.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [filtered, route.tags.join(','), mine]);

  return (
    <div className={cx('library', route.slug && 'has-note')}>
      <section className="list-pane">
        <div className="list-head">
          <div className="search">
            <Icon name="search" size={15} />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes & transcripts" aria-label="Search" />
            {q ? (
              <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search">
                <Icon name="x" size={14} />
              </button>
            ) : (
              <kbd>⌘K</kbd>
            )}
          </div>
          <div className="list-meta">
            {shownHits ? (
              <span>
                {shownHits.length} result{shownHits.length === 1 ? '' : 's'}
                {allowed && hits!.length !== shownHits.length && <span className="faint"> · {hits!.length - shownHits.length} outside the filter</span>}
              </span>
            ) : (
              <>
                <span className="list-title">
                  {route.tags.length ? `${filtered.length} note${filtered.length === 1 ? '' : 's'}` : listTitle}
                  {(route.starred || route.person) && !route.tags.length && (
                    <a className="clear-filter" href="#/" aria-label="Clear filter">
                      <Icon name="x" size={12} />
                    </a>
                  )}
                </span>
                <span className="grow" />
                <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                  <option value="added">Recently added</option>
                  <option value="published">Published</option>
                  <option value="links">Most connected</option>
                </select>
                <button className="icon-btn" title="New note" onClick={newNote}>
                  <Icon name="note" size={15} />
                </button>
              </>
            )}
          </div>
          {route.tags.length > 0 && (
            <div className="filter-row">
              {route.person && (
                <a className="filter-chip" href={href({ tags: route.tags, starred: route.starred, q: route.q })} aria-label="Remove the person filter">
                  {person?.name || 'Person'} <Icon name="x" size={11} />
                </a>
              )}
              {route.starred && (
                <a className="filter-chip" href={href({ tags: route.tags, person: route.person, q: route.q })} aria-label="Remove the starred filter">
                  Starred <Icon name="x" size={11} />
                </a>
              )}
              {route.tags.map((t) => (
                <a
                  key={t}
                  className="filter-chip"
                  href={href({ tags: toggleTag(route.tags, t), starred: route.starred, person: route.person, q: route.q })}
                  style={tagStyle(t, mine.has(t))}
                  aria-label={`Remove #${t} from the filter`}
                >
                  {t} <Icon name="x" size={11} />
                </a>
              ))}
              {moreTags.length > 0 && (
                <select
                  className="filter-add"
                  value=""
                  onChange={(e) => e.target.value && go({ tags: [...route.tags, e.target.value], starred: route.starred, person: route.person, q: route.q })}
                  aria-label="Also require a tag"
                >
                  <option value="">+ tag</option>
                  {[true, false].map((own) => {
                    const group = moreTags.filter(([t]) => mine.has(t) === own);
                    return group.length ? (
                      <optgroup key={String(own)} label={own ? 'My tags' : 'Tags'}>
                        {group.map(([t, n]) => (
                          <option key={t} value={t}>
                            #{t} ({n})
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              )}
              <a className="filter-clear" href={href({ starred: route.starred, person: route.person, q: route.q })}>
                Clear
              </a>
            </div>
          )}
        </div>
        <div className="list-scroll">
          {shownHits
            ? shownHits.map((h) => (
                <a key={h.slug} className={cx('card', route.slug === h.slug && 'selected')} href={href({ slug: h.slug, q, tags: route.tags, starred: route.starred, person: route.person })}>
                  <div className="card-title">{h.title}</div>
                  <div className="card-sub">
                    {h.channel}
                    {h.where === 'transcript' && h.t !== undefined && <span className="pill">{h.article ? `article ¶${h.t}` : `transcript ${fmtTime(h.t)}`}</span>}
                  </div>
                  <div className="card-snippet"><Highlight text={h.snippet} q={q} /></div>
                </a>
              ))
            : filtered.map((n) => (
                <a key={n.slug} className={cx('card', route.slug === n.slug && 'selected')} href={href({ slug: n.slug, tags: route.tags, starred: route.starred, person: route.person })}>
                  <div className="card-row">
                    {n.thumbnail ? <img className="thumb" src={n.thumbnail} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : <div className="thumb thumb-empty"><Icon name="note" size={18} /></div>}
                    <div className="card-main">
                      <div className="card-title">
                        {n.starred && <Icon name="star" size={12} fill className="star-inline" />}
                        {n.title}
                      </div>
                      <div className="card-sub">
                        {(n.type === 'article'
                          ? [n.author, n.channel, n.published ? fmtDate(n.published) : null, fmtReadTime(n.words)]
                          : [n.channel, n.published ? fmtDate(n.published) : null, fmtDuration(n.duration)]
                        ).filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </div>
                  {n.gist && <div className="card-gist">{n.gist}</div>}
                  <div className="card-foot">
                    {[...n.tags].sort((x, y) => Number(route.tags.includes(y)) - Number(route.tags.includes(x))).slice(0, 3).map((t) => (
                      <span key={t} className="tag-mini" style={tagStyle(t, mine.has(t))}>
                        {t}
                      </span>
                    ))}
                    {mentionedOnly.has(n.slug) && <span className="pill" title={`${person!.name} is mentioned here but doesn't speak`}>mentioned</span>}
                    <span className="grow" />
                    {n.links > 0 && (
                      <span className="links-count" title={`${n.links} connections`}>
                        <Icon name="link" size={12} /> {n.links}
                      </span>
                    )}
                  </div>
                </a>
              ))}
          {notes && !hits && filtered.length === 0 && (
            <div className="empty-list">
              {notes.length === 0 ? (
                <>
                  <p>Nothing here yet.</p>
                  <p className="muted">
                    Add videos to your playlist, or paste a video or article link in the box at top left. Check <a href="#/settings">Settings</a> first.
                  </p>
                </>
              ) : (
                <p className="muted">No notes match this filter.</p>
              )}
            </div>
          )}
        </div>
      </section>
      <section className="reader-pane">
        <PanelToggles hasNote={!!route.slug} />
        {route.slug ? (
          <Reader key={route.slug} slug={route.slug} tick={tick} notes={notes || []} highlight={q} />
        ) : (
          <EmptyReader notes={notes || []} />
        )}
      </section>
    </div>
  );
}

function EmptyReader({ notes }: { notes: NoteSummary[] }) {
  const recent = notes.slice(0, 1)[0];
  const links = notes.reduce((a, n) => a + n.links, 0) / 2;
  return (
    <div className="empty-reader">
      <div className="empty-mark" aria-hidden>
        {/* A small network in the house manner: ink dots, Faint lines, one buttercup dot with an ink edge */}
        <svg viewBox="0 0 120 120" width="96" height="96">
          <g stroke="var(--faint-mark)" strokeWidth="1.25">
            <line x1="60" y1="60" x2="98" y2="54" />
            <line x1="60" y1="60" x2="30" y2="34" />
            <line x1="60" y1="60" x2="40" y2="96" />
            <line x1="30" y1="34" x2="74" y2="22" />
            <line x1="98" y1="54" x2="74" y2="22" />
          </g>
          <circle cx="98" cy="54" r="5" fill="var(--ink)" />
          <circle cx="30" cy="34" r="4" fill="var(--ink)" />
          <circle cx="40" cy="96" r="3.5" fill="var(--ink)" />
          <circle cx="74" cy="22" r="3" fill="var(--ink)" />
          <circle cx="60" cy="60" r="10" fill="var(--buttercup)" stroke="var(--ink)" strokeWidth="1.5" />
        </svg>
      </div>
      <h2>
        {notes.length} note{notes.length === 1 ? '' : 's'}, {Math.round(links)} connection{Math.round(links) === 1 ? '' : 's'}
      </h2>
      <p className="muted">Pick a note from the list, or search across everything you've captured.</p>
      {recent && (
        <a className="btn" href={href({ slug: recent.slug })}>
          Open the latest: {recent.title}
        </a>
      )}
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.toLowerCase().replace(/"/g, '').split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

/** The tag filter with `t` added, or removed if it was already there. */
function toggleTag(tags: string[], t: string) {
  return tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
}
