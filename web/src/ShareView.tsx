import { useMemo, useState } from 'react';
import type { ShareIndexEntry, ShareSnapshot } from '../../shared/types';
import { Icon } from './icons';
import { Markdown } from './Markdown';
import { NotePeopleGraph } from './NotePeopleGraph';
import { inlineMarkdown, peopleForGraph, Transcript } from './noteBits';
import { cx, fmtDate, fmtDuration, fmtReadTime, fmtTime, tagStyle } from './util';

// Whose notes these are, set when the viewer is built (VITE_SHARE_OWNER and VITE_SHARE_OWNER_URL
// in .env.local; see .env.example). Unset, the band just says "Shared notes".
const OWNER = (import.meta.env.VITE_SHARE_OWNER || '').trim();
const OWNER_URL = (import.meta.env.VITE_SHARE_OWNER_URL || '').trim();

/** The band at the top of every shared page (house style: one buttercup band per page). */
function ShareBand() {
  return (
    <header className="band">
      <a className="band-title" href="/">
        Exo-mind
      </a>
      <span className="band-sub">
        {OWNER ? (
          <>
            {OWNER_URL ? <a href={OWNER_URL}>{OWNER}</a> : OWNER}’s shared notes
          </>
        ) : (
          'Shared notes'
        )}
      </span>
    </header>
  );
}

/** The public, read-only page for one shared note. Shows only what the snapshot carries. */
export function ShareView({ snap }: { snap: ShareSnapshot | null }) {
  const [tab, setTab] = useState<'notes' | 'transcript'>('notes');
  const people = useMemo(() => (snap ? peopleForGraph(snap.meta.people, snap.speakers) : []), [snap]);
  const graphData = useMemo(
    () => (snap?.library ? { library: snap.library, dates: snap.dates || {}, otherNotes: snap.options.otherNotes } : undefined),
    [snap],
  );

  if (!snap)
    return (
      <div className="share-page">
      <ShareBand />
      <div className="share-missing">
        <h1>Nothing here</h1>
        <p className="muted">This link isn't shared any more, or it was mistyped.</p>
        <p>
          <a href="/">See everything that's shared</a>
        </p>
      </div>
      </div>
    );

  const m = snap.meta;
  const isArticle = m.type === 'article';
  const hasTranscript = !!snap.transcript?.length;
  document.title = m.title;

  return (
    <div className="share-page reader">
      <ShareBand />
      <div className="reader-scroll">
        <article className="article">
          <header className="note-head">
            {m.thumbnail && (
              <a className={cx('hero', isArticle && 'hero-article')} href={m.url} target="_blank" rel="noreferrer" title={isArticle ? 'Read the original' : 'Watch on YouTube'}>
                <img
                  src={m.thumbnail.replace('hqdefault', 'maxresdefault')}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    if (img.src !== m.thumbnail) img.src = m.thumbnail!;
                    else (img.closest('.hero') as HTMLElement).classList.add('hero-broken');
                  }}
                  alt=""
                />
                {!isArticle && (
                  <span className="hero-play">
                    <Icon name="play" size={18} fill />
                  </span>
                )}
                {m.duration ? <span className="hero-dur">{fmtTime(m.duration)}</span> : null}
              </a>
            )}
            <h1 className="note-title">
              {m.url ? (
                <a href={m.url} target="_blank" rel="noreferrer">
                  {m.title}
                </a>
              ) : (
                m.title
              )}
            </h1>
            <div className="note-meta">
              {isArticle && (snap.speakers.length ? snap.speakers.join(', ') : m.author) && <span>{snap.speakers.length ? snap.speakers.join(', ') : m.author}</span>}
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
            </div>
            {!isArticle && snap.speakers.length > 0 && (
              <div className="note-speakers">
                <span className="note-speakers-label">Speaking</span>
                <span className="speaker-names">{snap.speakers.join(', ')}</span>
              </div>
            )}
            {snap.tags?.length ? (
              <div className="tags">
                {snap.tags.map((t) => (
                  <span key={t} className="tag" style={tagStyle(t)}>
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
            {m.url && (
              <div className="note-actions">
                <a className="btn" href={m.url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={14} /> {isArticle ? 'Read original' : 'Watch'}
                </a>
              </div>
            )}
          </header>

          {hasTranscript && (
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'notes'} className={cx('tab', tab === 'notes' && 'active')} onClick={() => setTab('notes')}>
                Notes
              </button>
              <button role="tab" aria-selected={tab === 'transcript'} className={cx('tab', tab === 'transcript' && 'active')} onClick={() => setTab('transcript')}>
                {isArticle ? 'Article text' : 'Transcript'}
                {m.transcript_source === 'auto' && <span className="tab-note">auto-captions</span>}
              </button>
            </div>
          )}

          {tab === 'notes' || !hasTranscript ? (
            <div className="note-body">
              <Markdown source={snap.body} />
            </div>
          ) : (
            <Transcript segments={snap.transcript} url={m.url} article={isArticle} />
          )}
        </article>

        <aside className="links-panel">
          {graphData && people.length ? (
            <div className="panel-block">
              <h3 className="panel-h">People</h3>
              <NotePeopleGraph slug="this" people={people} snapshot={graphData} />
            </div>
          ) : null}
          {snap.connections?.length ? (
            <div className="panel-block">
              <h3 className="panel-h">Related notes</h3>
              <ul className="conn-list">
                {snap.connections.map((c) => (
                  <li key={c.title} className="conn">
                    <div className="conn-top">
                      <span className="conn-title">{c.title}</span>
                    </div>
                    {c.reason && <p className="conn-reason">{c.reason}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {snap.works?.length ? (
            <div className="panel-block">
              <h3 className="panel-h">Works</h3>
              <ul className="works">
                {snap.works.map((w) => (
                  <li key={w}>
                    <span>{inlineMarkdown(w)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        <footer className="share-foot">
          <span>
            Shared from Exo-mind · {fmtDate(snap.sharedAt.slice(0, 10))}
          </span>
          <a href="/">All shared notes</a>
        </footer>
      </div>
    </div>
  );
}

/** The site's front page: every shared note, most recently shared first. */
export function ShareIndex({ items }: { items: ShareIndexEntry[] }) {
  document.title = 'Shared notes';
  return (
    <div className="share-page">
      <ShareBand />
      <div className="share-index">
        <header className="page-head">
          <div>
            <h1>Shared notes</h1>
            <p className="muted">Summaries of talks, podcasts and articles, from Exo-mind.</p>
          </div>
        </header>
        {items.length === 0 ? (
          <p className="muted">Nothing shared yet.</p>
        ) : (
          <ul className="share-list">
            {items.map((it) => (
              <li key={it.id}>
                <a className="share-item" href={`/s/${it.id}`}>
                  {it.thumbnail ? (
                    <span className="share-thumb">
                      <img src={it.thumbnail} alt="" loading="lazy" />
                      {it.duration ? <span className="hero-dur">{fmtTime(it.duration)}</span> : null}
                    </span>
                  ) : (
                    <span className="share-thumb share-thumb-empty" />
                  )}
                  <span className="share-item-text">
                    <span className="share-item-title">{it.title}</span>
                    <span className="share-item-meta">
                      {[it.speakers.join(', '), it.channel, it.published && fmtDate(it.published)].filter(Boolean).join(' · ')}
                    </span>
                    {it.gist && <span className="share-item-gist">{it.gist}</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
