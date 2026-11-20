// Pieces of the note reader that the shared-page viewer uses too.
import { useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import type { NotePerson } from './NotePeopleGraph';
import { parsePersonEntry, peopleList, personKey, withoutInitials } from '../../shared/names';
import { cx, fmtTime, textFragmentLink, timeLink } from './util';

// ---------- transcript ----------

export function Transcript({ slug, url, highlight, article, segments }: { slug?: string; url?: string; highlight?: string; article?: boolean; segments?: TranscriptSegment[] }) {
  const [segs, setSegs] = useState<TranscriptSegment[] | null>(segments ?? null);
  const [find, setFind] = useState(highlight?.replace(/"/g, '') || '');
  const firstHit = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (segments) setSegs(segments);
    else if (slug) api.transcript(slug).then((r) => setSegs(r.segments));
  }, [slug, segments]);
  useEffect(() => {
    firstHit.current?.scrollIntoView({ block: 'center' });
  }, [segs]);

  if (!segs) return <div className="reader-loading" />;
  if (!segs.length && article) return <p className="muted">No article text was saved for this one.</p>;
  if (!segs.length) return <p className="muted">No transcript was available for this one — YouTube had no captions. The summary was written from the title and description.</p>;

  const terms = find
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const re = terms.length ? new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi') : null;
  let firstAssigned = false;

  return (
    <div className="transcript">
      <div className="search search-inline">
        <Icon name="search" size={14} />
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={article ? 'Find in article' : 'Find in transcript'} />
      </div>
      {segs.map((s, i) => {
        const hit = re ? re.test(s.text) : false;
        if (re) re.lastIndex = 0;
        const isFirst = hit && !firstAssigned;
        if (isFirst) firstAssigned = true;
        return (
          <p key={i} className={cx('tseg', re && !hit && 'dim')} ref={isFirst ? firstHit : undefined}>
            <a className="tstamp" href={article ? textFragmentLink(url, s.text) : timeLink(url, s.t)} target="_blank" rel="noreferrer">
              {article ? `¶${s.t}` : fmtTime(s.t)}
            </a>
            <span>{re ? s.text.split(re).map((part, j) => (j % 2 ? <mark key={j}>{part}</mark> : part)) : s.text}</span>
          </p>
        );
      })}
    </div>
  );
}

/** Emphasis in a short line such as a Works entry: *title* or _title_ in italics, **bold** in bold. */
export function inlineMarkdown(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|(?<![\p{L}\d])_[^_\s][^_]*_(?![\p{L}\d]))/u).map((part, i) => {
    if (/^\*\*.+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^(\*.+\*|_.+_)$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Everyone in the People list (and any speaker missing from it), marked as speaking or only mentioned. */
export function peopleForGraph(people: unknown, speakers: string[]): NotePerson[] {
  const said = new Set(speakers.flatMap((n) => [personKey(n), withoutInitials(personKey(n))]));
  const out = new Map<string, NotePerson>();
  const add = (name: string, speaks: boolean) => {
    const k = personKey(name);
    if (!k) return;
    const seen = [...out.keys()].find((o) => o === k || withoutInitials(o) === withoutInitials(k));
    if (seen) out.get(seen)!.speaks ||= speaks;
    else out.set(k, { name, speaks });
  };
  for (const entry of peopleList(people)) {
    const name = parsePersonEntry(entry).name;
    if (name) add(name, said.has(personKey(name)) || said.has(withoutInitials(personKey(name))));
  }
  for (const n of speakers) add(n, true);
  return [...out.values()];
}

