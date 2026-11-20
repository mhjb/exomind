import { useMemo, useState } from 'react';
import type { NoteSummary } from '../../shared/types';
import { href, tagStyle } from './util';
import { useMyTags } from './myTags';

export function TagsView({ notes }: { notes: NoteSummary[] }) {
  const [sort, setSort] = useState<'count' | 'alpha'>('count');
  const mine = useMyTags();
  const tags = useMemo(() => {
    const m = new Map<string, NoteSummary[]>();
    for (const n of notes) for (const t of n.tags) m.set(t, [...(m.get(t) || []), n]);
    const list = [...m.entries()].map(([tag, ns]) => ({ tag, notes: ns }));
    return sort === 'count' ? list.sort((a, b) => b.notes.length - a.notes.length || a.tag.localeCompare(b.tag)) : list.sort((a, b) => a.tag.localeCompare(b.tag));
  }, [notes, sort]);
  const max = Math.max(1, ...tags.map((t) => t.notes.length));
  const groups = [
    { label: 'My tags', list: tags.filter((t) => mine.has(t.tag)) },
    { label: mine.size ? 'Tags from summaries' : '', list: tags.filter((t) => !mine.has(t.tag)) },
  ].filter((g) => g.list.length);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Tags</h1>
          <p className="muted">
            {tags.length} tags across {notes.length} notes.
          </p>
        </div>
        <div className="page-actions">
          <select value={sort} onChange={(e) => setSort(e.target.value as 'count' | 'alpha')} aria-label="Sort tags">
            <option value="count">Most used</option>
            <option value="alpha">A–Z</option>
          </select>
        </div>
      </header>
      {groups.map((g) => (
        <section key={g.label} className="tag-group">
          {g.label && <h2 className="section-h">{g.label}</h2>}
          <div className="tag-grid">
            {g.list.map(({ tag, notes: ns }) => (
              <a key={tag} className="tag-card" href={href({ tag })} style={tagStyle(tag, mine.has(tag))}>
                <div className="tag-card-head">
                  <span className="tag-card-name">{tag}</span>
                  <span className="tag-card-count">{ns.length}</span>
                </div>
                <div className="tag-bar">
                  <i style={{ width: `${(ns.length / max) * 100}%` }} />
                </div>
                <ul>
                  {ns.slice(0, 3).map((n) => (
                    <li key={n.slug}>{n.title}</li>
                  ))}
                  {ns.length > 3 && <li className="muted">+{ns.length - 3} more</li>}
                </ul>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
