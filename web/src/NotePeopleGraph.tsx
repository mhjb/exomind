import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { PeopleDates, PeopleGraph, PersonDates } from '../../shared/types';
import { personKey, withoutInitials } from '../../shared/names';
import { api } from './api';
import { PersonStar, useStarredPeople } from './starredPeople';
import { cx, go, href } from './util';
import { ERA_TICKS, eraY, lifeLabel, yearLabel } from './era';

export type NotePerson = { name: string; speaks: boolean };

type Other = { slug: string; title: string };
type N = SimulationNodeDatum & { id: string; name: string; speaks: boolean; hub?: boolean; others: Other[]; w: number; r: number; libId?: string; year?: number | null };
type L = SimulationLinkDatum<N> & { kind: 'with' | 'about' | 'shared'; shared?: Other[] };

// Labels are much wider than they are tall, so the layout runs with y stretched by this factor:
// round collision circles in that space are flat ellipses on screen, which is the shape a label takes up.
const SQUASH = 2.6;
const LABEL_PX = 6.2; // rough width of one character of an 11px label

// By era, how much each person's height follows the clock rather than their order in time. At 1 a
// note with Esau and C. S. Lewis is mostly empty centuries; at 0 everyone is evenly spaced and the
// year lines bunch up wherever nobody lived. In between, time still reads top to bottom, but the
// empty stretches shrink and the year lines there sit closer together.
const TIME_WEIGHT = 0.35;

// Fitting the graph to the window: from this window width up, the graph is no taller than the window
// less FIT_ALLOW (what sits above and below it), and never shorter than FIT_MIN.
const FIT_FROM = 900;
const FIT_ALLOW = 300;
const FIT_MIN = 360;

/** A shared page's own copy of the library data: no fetching, nothing editable, no links into the app. */
export type PeopleSnapshot = { library: PeopleGraph; dates: Record<string, PersonDates>; otherNotes: boolean };

/**
 * The people named in one note, drawn as a small graph: who speaks in the middle, who they talk about
 * around them, and a fainter line between two people when they also come up together in other notes.
 */
export function NotePeopleGraph({ slug, people, snapshot }: { slug: string; people: NotePerson[]; snapshot?: PeopleSnapshot }) {
  const { isStarred } = useStarredPeople();
  const [library, setLibrary] = useState<PeopleGraph | null | undefined>(snapshot ? snapshot.library : undefined);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(280);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  // Arrange by era: the present at the top, further back lower down. Remembered per browser.
  const [byEra, setByEra] = useState(() => {
    try {
      return localStorage.getItem('exo.npg.byEra') === '1';
    } catch {
      return false;
    }
  });
  const [dates, setDates] = useState<PeopleDates | null>(snapshot ? { dates: snapshot.dates, job: { running: false, done: 0, total: 0 }, missing: 0 } : null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!snapshot) api.peopleGraph().then(setLibrary, () => setLibrary(null));
  }, [slug, snapshot]);

  useEffect(() => {
    try {
      localStorage.setItem('exo.npg.byEra', byEra ? '1' : '0');
    } catch {
      /* not remembered */
    }
  }, [byEra]);

  // Dates for the card, and for arranging by era. Anyone not yet dated is dated in the background.
  useEffect(() => {
    if (snapshot) return;
    let stop = false;
    let timer = 0;
    const poll = (d: PeopleDates) => {
      if (stop) return;
      setDates(d);
      if (d.job.running) timer = window.setTimeout(() => api.peopleDates().then(poll, () => {}), 2500);
    };
    api
      .peopleDates()
      .then((d) => (byEra && d.missing > 0 && !d.job.running ? api.fillPeopleDates() : d))
      .then(poll, () => {});
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [slug, byEra, snapshot]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const graph = useMemo(() => {
    if (library === undefined) return null;
    // Each person's other notes, matched the same way as the people graph ("Jordan B. Peterson" = "Jordan Peterson").
    const titles = new Map((library?.notes || []).map((n) => [n.id, n.title]));
    const byKey = new Map<string, PeopleGraph['people'][number]>();
    for (const p of library?.people || []) {
      byKey.set(p.id, p);
      if (!byKey.has(withoutInitials(p.id))) byKey.set(withoutInitials(p.id), p);
    }
    const othersOf = (name: string): Other[] => {
      const k = personKey(name);
      const p = byKey.get(k) || byKey.get(withoutInitials(k));
      if (!p) return [];
      return [...p.appears, ...p.mentioned].filter((s) => s !== slug && titles.has(s)).map((s) => ({ slug: s, title: titles.get(s)! }));
    };

    // Names merged by hand count as the person they were merged into ("Jesus" → "Jesus Christ").
    const merged = new Map<string, NotePerson>();
    for (const p of people) {
      const k = personKey(p.name);
      const id = library?.aliasOf?.[k] ?? library?.aliasOf?.[withoutInitials(k)];
      const name = (id && byKey.get(id)?.name) || p.name;
      const mk = personKey(name);
      const prev = merged.get(mk);
      merged.set(mk, { name, speaks: p.speaks || !!prev?.speaks });
    }
    const nodes: N[] = [...merged.values()].map((p) => {
      const others = othersOf(p.name);
      const k = personKey(p.name);
      const libId = (byKey.get(k) || byKey.get(withoutInitials(k)))?.id;
      return { id: k, libId, name: p.name, speaks: p.speaks, others, w: p.name.length * LABEL_PX * (p.speaks ? 1.08 : 1), r: p.speaks ? 7 : 3.5 + Math.min(4, Math.sqrt(others.length) * 1.4) };
    });
    const speakers = nodes.filter((n) => n.speaks);
    const mentioned = nodes.filter((n) => !n.speaks);
    const links: L[] = [];
    // With no known speaker, everyone hangs off the note itself.
    let hubs = speakers;
    if (!speakers.length) {
      const hub: N = { id: '·note', name: 'This note', speaks: false, hub: true, others: [], w: 0, r: 4 };
      nodes.unshift(hub);
      hubs = [hub];
    }
    for (let i = 0; i < speakers.length; i++) for (let j = i + 1; j < speakers.length; j++) links.push({ source: speakers[i].id, target: speakers[j].id, kind: 'with' });
    // Lines from every speaker to every mention would be a tangle in a panel discussion, so only for one or two speakers.
    if (hubs.length <= 2) for (const h of hubs) for (const m of mentioned) links.push({ source: h.id, target: m.id, kind: 'about' });
    const people_ = nodes.filter((n) => !n.hub);
    for (let i = 0; i < people_.length; i++)
      for (let j = i + 1; j < people_.length; j++) {
        const theirs = new Set(people_[j].others.map((o) => o.slug));
        const shared = people_[i].others.filter((o) => theirs.has(o.slug));
        if (shared.length) links.push({ source: people_[i].id, target: people_[j].id, kind: 'shared', shared });
      }

    // By era: each person's place in time, on the same square-root scale as the people graph,
    // fitted to this note's own span (Moses to Banksy, or just the last century).
    const known = dates?.dates || {};
    for (const d of nodes) {
      const pd = d.libId ? known[d.libId] : undefined;
      d.year = pd && pd.confidence !== 'none' ? (pd.active ?? null) : null;
    }
    const dated = nodes.filter((d) => d.year != null);
    let span: { lo: number; hi: number } | null = null;
    // The warp: each distinct date in the note, at a height that blends where it falls in time with
    // where it falls in order. Anything between two of them (a year line) is placed in proportion.
    const warp: { e: number; c: number }[] = [];
    if (byEra && dated.length >= 2) {
      const es = [...new Set(dated.map((d) => eraY(d.year!)))].sort((a, b) => a - b);
      const lo = es[0];
      const hi = es[es.length - 1];
      if (hi - lo > 1) {
        es.forEach((e, i) => warp.push({ e, c: TIME_WEIGHT * ((e - lo) / (hi - lo)) + (1 - TIME_WEIGHT) * (i / (es.length - 1)) }));
        span = { lo: 0, hi: 1 };
      }
    }
    /** Era-scale position to 0–1 down the panel, or null outside the note's span. */
    const warped = (e: number) => {
      for (let i = 0; i < warp.length - 1; i++) {
        const a = warp[i];
        const b = warp[i + 1];
        if (e >= a.e - 0.5 && e <= b.e + 0.5) return a.c + (b.c - a.c) * Math.min(1, Math.max(0, (e - a.e) / (b.e - a.e)));
      }
      return null;
    };

    // Lay out once, synchronously: a panel graph shouldn't wobble.
    const n = nodes.length;
    // Busy notes get a taller canvas rather than a tangle; an era layout needs more height still.
    // On a desktop-sized window the whole graph fits on screen beside the note, however many people
    // it has (the panel starts about 230px down and the legend takes 70px below it). On a phone the
    // panel sits under the note and scrolls with it, so it can be as tall as it needs.
    const fitTo = viewport.w >= FIT_FROM ? Math.max(FIT_MIN, viewport.h - FIT_ALLOW) : Infinity;
    const H = Math.min(fitTo, span ? Math.min(1200, 170 + n * 30) : Math.min(900, 130 + n * 24)) * SQUASH;
    const W = width;
    const GUTTER = span ? 46 : 0; // a strip on the right for the year labels, kept clear of people
    const top = -H / 2 + 30 * SQUASH;
    const toC = (c: number) => top + c * (H - 60 * SQUASH);
    const toY = (year: number) => toC(warped(eraY(year)) ?? 0);
    if (hubs.length === 1) {
      hubs[0].fx = 0;
      hubs[0].fy = span && hubs[0].hub ? top : 0; // "this note" sits at the present
    }
    const sim = forceSimulation<N>(nodes)
      .force(
        'link',
        forceLink<N, L>(links)
          .id((d) => d.id)
          .distance((l) => (l.kind === 'shared' ? 90 : l.kind === 'with' ? 70 : 110))
          // By era, time decides the height: links between contemporaries only nudge, and links
          // across eras (a speaker discussing Moses) don't pull at all.
          .strength((l) => {
            const base = l.kind === 'shared' ? 0.25 : l.kind === 'about' ? 0.35 : 0.6;
            if (!span) return base;
            const a = (l.source as N).year;
            const b = (l.target as N).year;
            return a != null && b != null && Math.abs(toY(a) - toY(b)) > 40 * SQUASH ? 0 : base * 0.25;
          }),
      )
      .force('charge', forceManyBody<N>().strength(-260))
      .force('collide', forceCollide<N>((d) => (d.hub ? 10 : Math.max(d.r + 6, d.w / 2 + 8))).strength(1).iterations(4))
      .force('x', forceX<N>(0).strength((d) => (span ? (d.speaks ? 0.1 : 0.04) : d.speaks ? 0.25 : 0.06)))
      .force(
        'y',
        span
          ? forceY<N>((d) => (d.year != null ? toY(d.year) : 0)).strength((d) => (d.year != null ? 0.9 : 0.03))
          : forceY<N>(0).strength((d) => (d.speaks ? 0.25 : 0.04)),
      )
      .force('box', () => {
        for (const d of nodes) {
          const hw = d.w / 2 + 4;
          d.x = Math.max(-W / 2 + hw, Math.min(W / 2 - GUTTER - hw, d.x!));
          d.y = Math.max(-H / 2 + 20, Math.min(H / 2 - 20, d.y!));
        }
      })
      .stop();
    for (let i = 0; i < 400; i++) sim.tick();
    for (const d of nodes) d.y = d.y! / SQUASH;

    // Fit the drawing to what's actually there (labels sit below their dots).
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const d of nodes) {
      x0 = Math.min(x0, d.x! - d.w / 2 - 2);
      x1 = Math.max(x1, d.x! + d.w / 2 + 2);
      y0 = Math.min(y0, d.y! - d.r - 4);
      y1 = Math.max(y1, d.y! + d.r + 17);
    }
    const pad = 4;
    // By era the drawing spans the full width, so the year labels sit at the right edge, in their strip.
    if (span) {
      x0 = Math.min(x0, -W / 2);
      x1 = Math.max(x1, W / 2);
    }
    const box = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };

    // Year lines across the panel, thinned so their labels never crowd.
    const ticks: { year: number; y: number }[] = [];
    if (span) {
      let last = -Infinity;
      for (const year of ERA_TICKS) {
        const c = warped(eraY(year));
        if (c == null) continue; // outside the note's span
        const y = toC(c) / SQUASH;
        if (y - last < 26) continue;
        last = y;
        ticks.push({ year, y });
      }
    }
    return { nodes, links: links as (L & { source: N; target: N })[], box, ticks };
  }, [library, people, slug, width, byEra, dates, viewport]);

  const focus = hover || selected;
  const near = useMemo(() => {
    if (!graph || !focus) return null;
    const s = new Set([focus]);
    for (const l of graph.links) {
      if (l.source.id === focus) s.add(l.target.id);
      if (l.target.id === focus) s.add(l.source.id);
    }
    return s;
  }, [graph, focus]);
  const sel = graph?.nodes.find((d) => d.id === selected && !d.hub);
  const hasShared = !!graph?.links.some((l) => l.kind === 'shared');

  return (
    <div className="npg" ref={wrap}>
      {graph ? (
        <svg
          className="npg-svg"
          viewBox={`${graph.box.x} ${graph.box.y} ${graph.box.w} ${graph.box.h}`}
          style={{ aspectRatio: `${graph.box.w} / ${graph.box.h}` }}
          role="img"
          aria-label={`People in this note: ${people.map((p) => p.name).join(', ')}`}
          onClick={() => setSelected(null)}
        >
          {graph.ticks.map((t) => (
            <g key={t.year} className="npg-era">
              <line x1={graph.box.x} x2={graph.box.x + graph.box.w} y1={t.y} y2={t.y} />
              <text x={graph.box.x + graph.box.w} y={t.y - 3} textAnchor="end">
                {yearLabel(t.year)}
              </text>
            </g>
          ))}
          {graph.links.map((l, i) => {
            const lit = !!focus && (l.source.id === focus || l.target.id === focus);
            const faded = !!focus && !lit;
            const cls = cx('npg-link', l.kind, lit && 'lit', faded && 'faded');
            if (l.kind !== 'shared') return <line key={i} className={cls} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} />;
            return (
              <line key={i} className={cls} style={{ strokeWidth: 0.8 + Math.min(3, l.shared!.length) * 0.45 }} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y}>
                <title>{`${l.source.name} and ${l.target.name} also come up together in ${l.shared!.length} other note${l.shared!.length === 1 ? '' : 's'}`}</title>
              </line>
            );
          })}
          {graph.nodes.map((d) => {
            const faded = !!near && !near.has(d.id);
            if (d.hub)
              return <rect key={d.id} className={cx('npg-hub', faded && 'faded')} x={d.x! - 4} y={d.y! - 4} width={8} height={8} rx={2}><title>This note</title></rect>;
            return (
              <g
                key={d.id}
                className={cx('npg-node', d.speaks && 'speaks', d.others.length > 0 && 'elsewhere', isStarred(d.name) && 'starred', selected === d.id && 'selected', faded && 'faded')}
                transform={`translate(${d.x},${d.y})`}
                tabIndex={0}
                role="button"
                aria-label={`${d.name}, ${d.speaks ? 'speaking' : 'mentioned'}${d.others.length ? `, in ${d.others.length} other note${d.others.length === 1 ? '' : 's'}` : ''}`}
                aria-pressed={selected === d.id}
                onMouseEnter={() => setHover(d.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(d.id)}
                onBlur={() => setHover(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(selected === d.id ? null : d.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(selected === d.id ? null : d.id);
                  }
                }}
              >
                <rect className="npg-hit" x={-d.w / 2 - 2} y={-d.r - 3} width={d.w + 4} height={d.r + 20} />
                {selected === d.id && <circle className="npg-sel" r={d.r + 3} />}
                <circle r={d.r} />
                <text y={d.r + 12} textAnchor="middle">
                  {d.name}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="npg-loading" />
      )}

      {graph && (
        <div className="npg-legend">
          <span><i className="npg-key speaks" /> speaking</span>
          <span><i className="npg-key" /> mentioned</span>
          {graph.nodes.some((d) => !d.hub && isStarred(d.name)) && <span><i className="npg-key starred" /> starred</span>}
          {hasShared && <span><i className="npg-key-arc" /> together elsewhere</span>}
          <button
            type="button"
            className={cx('npg-era-toggle', byEra && 'on')}
            aria-pressed={byEra}
            title="Arrange by when people lived: the present at the top, further back lower down"
            onClick={() => setByEra(!byEra)}
          >
            By era
          </button>
        </div>
      )}

      {sel && (
        <div className="npg-card">
          <div className="npg-card-head">
            {!snapshot && <PersonStar name={sel.name} size={13} />}
            <strong>{sel.name}</strong>
            <span className="muted">{sel.speaks ? 'speaks here' : 'mentioned here'}</span>
          </div>
          {sel.libId && dates?.dates[sel.libId] && dates.dates[sel.libId].confidence !== 'none' && (
            <div className="npg-card-dates">
              {lifeLabel(dates.dates[sel.libId])}
              {dates.dates[sel.libId].confidence === 'low' && <span className="muted"> · a guess</span>}
            </div>
          )}
          {snapshot && !snapshot.otherNotes ? null : sel.others.length ? (
            <>
              <div className="npg-card-sub">Also in {sel.others.length} other note{sel.others.length === 1 ? '' : 's'}</div>
              <ul>
                {sel.others.slice(0, 8).map((o) => (
                  <li key={o.slug}>{snapshot ? o.title : <a href={href({ slug: o.slug })}>{o.title}</a>}</li>
                ))}
                {snapshot && sel.others.length > 8 && <li className="muted">and {sel.others.length - 8} more</li>}
              </ul>
            </>
          ) : (
            <div className="npg-card-sub">Not in any other note yet</div>
          )}
          {!snapshot && <a
            className="npg-search"
            href={href({ q: sel.name })}
            onClick={(e) => {
              e.preventDefault();
              go({ q: `"${sel.name}"` });
            }}
          >
            Search for “{sel.name}”{sel.others.length > 8 ? ` (all ${sel.others.length})` : ''}
          </a>}
        </div>
      )}
    </div>
  );
}
