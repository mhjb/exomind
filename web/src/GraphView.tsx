import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type ForceLink, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { DuplicateSuggestion, GraphData, PeopleDates, PeopleGraph, PersonDates } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import { cx, go, href } from './util';
import { PersonStar, matchesStarred, useStarredPeople } from './starredPeople';
import { useMyTags } from './myTags';
import { ERA_TICKS, eraY, lifeLabel, yearLabel } from './era';

type Mode = 'notes' | 'people';
type Kind = 'note' | 'person';
/** How two people share an episode: both speak, one speaks about the other, or both are only mentioned. */
type LinkKind = 'with' | 'about' | 'together';
type Episode = { slug: string; kind: LinkKind; speaker?: string };
type N = SimulationNodeDatum & { id: string; title: string; kind: Kind; tags: string[]; degree: number; appears?: boolean; links?: number; r?: number; year?: number | null; conf?: PersonDates['confidence'] };
type L = SimulationLinkDatum<N> & { strength: number; kind?: LinkKind; episodes?: Episode[] };

const PERSON = 'person:'; // keeps person ids apart from note slugs
const RANK: Record<LinkKind, number> = { with: 3, about: 2, together: 1 };
const MIN_OPTIONS = [1, 2, 3, 5];

/** How firmly each person is pulled to their era: a nudge, not a rail, so links still shape the layout. */
const ERA_PULL: Record<PersonDates['confidence'], number> = { high: 0.7, medium: 0.5, low: 0.15, none: 0.01 };
// Link lengths and pulls by kind. When arranging by era, a link between people far apart in time
// (a podcaster talking about Aristotle) doesn't pull at all, so it can't drag them out of their eras.
const LINK_DIST: Record<LinkKind, number> = { with: 55, about: 95, together: 120 };
const LINK_PULL: Record<LinkKind, number> = { with: 0.6, about: 0.15, together: 0.1 };
const ERA_GAP = 120; // graph units apart (about a century in the modern era, more further back)

/**
 * A sideways-only push between people at nearly the same height, used when arranging by era: each
 * period spreads out across the page (leaving room for names) without anyone leaving their era.
 */
function eraSpread(band = 60, reach = 320, strength = 2.5) {
  let nodes: N[] = [];
  const force = (alpha: number) => {
    const order = nodes.filter((n) => n.x != null).sort((a, b) => a.y! - b.y!);
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        const dy = b.y! - a.y!;
        if (dy >= band) break;
        let dx = b.x! - a.x!;
        if (Math.abs(dx) >= reach) continue;
        if (dx === 0) dx = Math.random() - 0.5;
        const push = (strength * alpha * (reach - Math.abs(dx))) / reach * (1 - dy / band) * Math.sign(dx);
        a.vx! -= push;
        b.vx! += push;
      }
    }
  };
  force.initialize = (n: N[]) => (nodes = n);
  return force;
}

const asText = (n: number | null | undefined) => (n == null ? '' : n < 0 ? `${-n} BC` : String(n));

// Per-viewer conveniences only; the page works the same if storage is unavailable.
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function GraphView({ tick }: { tick: number }) {
  const { isStarred, list: starredList } = useStarredPeople();
  const mine = useMyTags();
  const starredKey = starredList.map((p) => p.key).join('|'); // changes only when the starred people do
  const [mode, setMode] = useState<Mode>(() => load('exo.graph.mode', 'notes'));
  const [show, setShow] = useState<Record<LinkKind, boolean>>(() => load('exo.graph.links', { with: true, about: true, together: false }));
  const [minNotes, setMinNotes] = useState(() => load('exo.graph.minNotes', 2));
  const [byEra, setByEra] = useState(() => load('exo.graph.byEra', false));
  const [stretchSetting, setStretch] = useState(() => load('exo.graph.stretch', 1)); // horizontal stretch of the people graph
  const stretch = mode === 'people' ? stretchSetting : 1;
  const [dates, setDates] = useState<PeopleDates | null>(null);
  const [editDates, setEditDates] = useState<{ born: string; died: string; active: string } | null>(null);
  const alertText = useRef('');
  const [dupes, setDupes] = useState<DuplicateSuggestion[] | null>(null);
  const [showDupes, setShowDupes] = useState(false);
  const [mergeInto, setMergeInto] = useState<string | null>(null); // the "Merge into…" field on a person's card
  const [busy, setBusy] = useState(false);
  const selectAfterLoad = useRef<string | null>(null);
  const [reload, setReload] = useState(0); // bumped after a merge, in case the vault signal is missed
  const [notesData, setNotesData] = useState<GraphData | null>(null);
  const [peopleData, setPeopleData] = useState<PeopleGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tip, setTip] = useState<{ i: number; x: number; y: number; pinned: boolean } | null>(null);
  const [find, setFind] = useState('');
  const [, setFrame] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [focusTag, setFocusTag] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const wrap = useRef<HTMLDivElement>(null);
  const autoFit = useRef(false); // while true, the view glides to keep the whole graph in frame
  const fitFrame = useRef(0);
  const viewRef = useRef(view);
  const stretchRef = useRef(1);
  viewRef.current = view;
  stretchRef.current = stretch;
  const lastMode = useRef(mode);
  const sim = useRef<ReturnType<typeof forceSimulation<N>> | null>(null);
  const nodesRef = useRef<N[]>([]);
  const linksRef = useRef<L[]>([]);
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    save('exo.graph.mode', mode);
    save('exo.graph.links', show);
    save('exo.graph.minNotes', minNotes);
    save('exo.graph.byEra', byEra);
    save('exo.graph.stretch', stretchSetting);
  }, [mode, show, minNotes, byEra, stretchSetting]);

  useEffect(() => {
    if (mode === 'notes') api.graph().then(setNotesData);
    else {
      api.peopleGraph().then(setPeopleData);
      api.duplicates().then(setDupes, () => setDupes(null));
    }
  }, [tick, mode, reload]);

  // After a merge, keep the merged person selected under their new name.
  useEffect(() => {
    const want = selectAfterLoad.current;
    if (!want || !peopleData) return;
    selectAfterLoad.current = null;
    const p = peopleData.people.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (p) setSelected(PERSON + p.id);
  }, [peopleData]);

  // Dates for the person card, and for arranging by era. Turning that on dates anyone not yet dated,
  // in the background; the layout follows as batches arrive.
  useEffect(() => {
    if (mode !== 'people') return;
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
  }, [mode, byEra, tick, reload]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const noteTitles = useMemo(() => new Map((peopleData?.notes || []).map((n) => [n.id, n.title])), [peopleData]);
  const personNamesById = useMemo(() => new Map((peopleData?.people || []).map((p) => [PERSON + p.id, p.name])), [peopleData]);

  // What to draw, built from whichever dataset the current mode uses.
  const graph = useMemo((): { nodes: N[]; links: L[] } | null => {
    if (mode === 'notes') {
      if (!notesData) return null;
      return { nodes: notesData.nodes.map((n) => ({ ...n, kind: 'note' as const })), links: notesData.links.map((l) => ({ ...l })) };
    }
    if (!peopleData) return null;

    // Who speaks in each note, and who is mentioned, counting only people in enough notes to show
    // (speakers included: a panel of guests from one video shouldn't fill the graph). Starred people always show.
    const byNote = new Map<string, { a: string[]; m: string[] }>();
    const note = (s: string) => byNote.get(s) || (byNote.set(s, { a: [], m: [] }), byNote.get(s)!);
    for (const p of peopleData.people) {
      if (p.appears.length + p.mentioned.length < minNotes && !matchesStarred(starredList, p.name)) continue;
      for (const s of p.appears) note(s).a.push(p.id);
      for (const s of p.mentioned) note(s).m.push(p.id);
    }

    // One link per pair of people, carrying the episodes they share.
    const pairs = new Map<string, { a: string; b: string; episodes: Episode[] }>();
    const add = (x: string, y: string, ep: Episode) => {
      const [a, b] = x < y ? [x, y] : [y, x];
      const key = `${a}\n${b}`;
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { a, b, episodes: [] }));
      p.episodes.push(ep);
    };
    for (const [slug, { a, m }] of byNote) {
      if (show.with) for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) add(a[i], a[j], { slug, kind: 'with' });
      if (show.about) for (const x of a) for (const y of m) add(x, y, { slug, kind: 'about', speaker: x });
      if (show.together) for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) add(m[i], m[j], { slug, kind: 'together' });
    }

    const links: L[] = [];
    const linked = new Map<string, number>(); // how many people each person is linked to
    for (const { a, b, episodes } of pairs.values()) {
      // Being mentioned side by side once is noise; twice or more starts to mean something.
      if (episodes.every((e) => e.kind === 'together') && episodes.length < 2) continue;
      episodes.sort((x, y) => RANK[y.kind] - RANK[x.kind]);
      links.push({ source: PERSON + a, target: PERSON + b, kind: episodes[0].kind, episodes, strength: episodes.length });
      linked.set(a, (linked.get(a) || 0) + 1).set(b, (linked.get(b) || 0) + 1);
    }
    // Size shows how connected someone is: the number of people they're linked to (area in proportion).
    // Labels are offered to the most connected first, so size and naming agree.
    const shown = peopleData.people.filter((p) => linked.has(p.id));
    const maxLinks = Math.max(1, ...shown.map((p) => linked.get(p.id)!));
    const nodes: N[] = shown.map((p) => {
      const n = linked.get(p.id)!;
      return {
        id: PERSON + p.id,
        title: p.name,
        kind: 'person' as const,
        tags: [],
        degree: n,
        links: n,
        appears: p.appears.length > 0,
        r: 3 + 13 * Math.sqrt(n / maxLinks),
      };
    });
    return { nodes, links };
  }, [mode, notesData, peopleData, show, minNotes, starredKey]);

  useEffect(() => {
    if (!graph) return;
    if (lastMode.current !== mode) {
      lastMode.current = mode;
      nodesRef.current = [];
    }
    const firstLayout = nodesRef.current.length === 0;
    setTip(null);
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes: N[] = graph.nodes.map((n) => ({ ...n, x: prev.get(n.id)?.x, y: prev.get(n.id)?.y }));
    const links: L[] = graph.links.map((l) => ({ ...l }));
    nodesRef.current = nodes;
    linksRef.current = links;
    sim.current?.stop();
    const people = mode === 'people';
    sim.current = forceSimulation(nodes)
      .force(
        'link',
        forceLink<N, L>(links)
          .id((d) => d.id)
          .distance((l) => (l.kind ? LINK_DIST[l.kind] : 170 - l.strength * 20))
          .strength((l) => (l.kind ? LINK_PULL[l.kind] : 0.5)),
      )
      .force('charge', people ? forceManyBody().strength(-200).distanceMax(700) : forceManyBody().strength(-420))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(people ? 0.06 : 0.04))
      .force('y', forceY(0).strength(people ? 0.06 : 0.04))
      .force('collide', forceCollide<N>().radius((d) => radius(d) + (people ? 3 : 6)))
      .on('tick', () => setFrame((f) => f + 1));
    if (prev.size) sim.current.alpha(0.5);
    // A new layout starts small and spreads out; follow it with the camera rather than jumping at the end.
    if (firstLayout) startFit();
    return () => {
      sim.current?.stop();
    };
  }, [graph]);

  // Arrange by era: swap the centring forces for a pull towards each person's place in time.
  useEffect(() => {
    setEditDates(null);
    setMergeInto(null);
  }, [selected]);

  const eraWas = useRef(false);
  useEffect(() => {
    const s = sim.current;
    if (!s || !graph) return;
    const on = mode === 'people' && byEra;
    const known = dates?.dates || {};
    for (const n of nodesRef.current) {
      const d = n.kind === 'person' ? known[n.id.slice(PERSON.length)] : undefined;
      n.year = d && d.confidence !== 'none' ? (d.active ?? null) : null;
      n.conf = d?.confidence;
    }
    const people = mode === 'people';
    if (on) {
      s.force('center', null);
      // Shorter-range repulsion: the crowd of present-day people mustn't shove everyone else down a century.
      s.force('charge', forceManyBody().strength(-140).distanceMax(240));
      s.force('x', forceX(0).strength(0.006));
      s.force('spread', eraSpread());
      s.force(
        'y',
        forceY<N>((d) => (d.year != null ? eraY(d.year) : 0)).strength((d) => (d.year != null ? ERA_PULL[d.conf || 'low'] : d.conf === 'none' ? 0.01 : 0.03)),
      );
    } else {
      s.force('center', forceCenter(0, 0));
      s.force('charge', people ? forceManyBody().strength(-200).distanceMax(700) : forceManyBody().strength(-420));
      s.force('x', forceX(0).strength(people ? 0.06 : 0.04));
      s.force('spread', null);
      s.force('y', forceY(0).strength(people ? 0.06 : 0.04));
    }
    // Same-era links are longer and softer than usual, so each period has room to spread out sideways.
    (s.force('link') as ForceLink<N, L> | undefined)
      ?.distance((l) => (l.kind ? LINK_DIST[l.kind] : 170 - l.strength * 20) * (on ? 1.8 : 1))
      .strength((l) => {
        const base = l.kind ? LINK_PULL[l.kind] : 0.5;
        if (!on) return base;
        const a = (l.source as N).year;
        const b = (l.target as N).year;
        return a != null && b != null && Math.abs(eraY(a) - eraY(b)) > ERA_GAP ? 0 : base * 0.5;
      });
    const toggled = eraWas.current !== on;
    eraWas.current = on;
    if (toggled || on) {
      s.alpha(Math.max(s.alpha(), toggled ? 0.6 : 0.12)).restart();
      if (toggled) startFit();
    }
  }, [graph, dates, byEra, mode]);

  useEffect(() => () => cancelAnimationFrame(fitFrame.current), []);

  /** The view that shows every node, with a margin. */
  function fitTarget() {
    const nodes = nodesRef.current.filter((n) => n.x != null);
    if (!nodes.length || !wrap.current) return null;
    const xs = nodes.map((n) => n.x! * stretchRef.current);
    const ys = nodes.map((n) => n.y!);
    const w = Math.max(...xs) - Math.min(...xs) + 220;
    const h = Math.max(...ys) - Math.min(...ys) + 120;
    const k = Math.min(1.5, Math.max(0.2, Math.min(wrap.current.clientWidth / w, wrap.current.clientHeight / h) * 0.85));
    return { k, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
  }

  /** Glide the view towards the whole graph each frame until the layout settles and the view arrives. */
  function startFit() {
    autoFit.current = true;
    cancelAnimationFrame(fitFrame.current);
    const step = () => {
      if (!autoFit.current) return;
      const t = fitTarget();
      if (t) {
        const v = viewRef.current;
        const ease = 0.07;
        // Ease zoom in log space and the centre in graph space, so zooming out doesn't swing sideways.
        const k = v.k * Math.pow(t.k / v.k, ease);
        const cx = -v.x / v.k + (t.cx - -v.x / v.k) * ease;
        const cy = -v.y / v.k + (t.cy - -v.y / v.k) * ease;
        const next = { k, x: -cx * k, y: -cy * k };
        const settled = !sim.current || sim.current.alpha() < 0.02;
        const arrived = Math.abs(Math.log(t.k / k)) < 0.004 && Math.hypot((t.cx - cx) * k, (t.cy - cy) * k) < 0.5;
        viewRef.current = next;
        setView(next);
        if (settled && arrived) {
          autoFit.current = false;
          return;
        }
      }
      fitFrame.current = requestAnimationFrame(step);
    };
    fitFrame.current = requestAnimationFrame(step);
  }

  /** The person has taken over the camera. */
  function stopFit() {
    autoFit.current = false;
    cancelAnimationFrame(fitFrame.current);
  }

  const tags = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of notesData?.nodes || []) for (const t of n.tags) c.set(t, (c.get(t) || 0) + 1);
    return [...c.entries()].sort((a, b) => Number(mine.has(b[0])) - Number(mine.has(a[0])) || b[1] - a[1]).map(([t]) => t);
  }, [notesData, mine]);

  const nodes = nodesRef.current;
  const links = linksRef.current;
  const focus = hover ?? selected;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of links) {
      const a = (l.source as N).id;
      const b = (l.target as N).id;
      if (a === focus) s.add(b);
      if (b === focus) s.add(a);
    }
    return s;
  }, [focus, links, graph]);

  const isFaded = (n: N) => !!((neighbours && !neighbours.has(n.id)) || (mode === 'notes' && focusTag && !n.tags.includes(focusTag)));
  // Labels never overlap one another (house style): the same placement for notes and people.
  // Starred people are offered space first, then the best connected.
  const autoLabels = pickLabels(nodes, view, size, stretch, (n) => (n.kind === 'person' && isStarred(n.title) ? 1 : 0));
  // Draw the hovered or selected node and its neighbours last, so their labels sit on top.
  const drawOrder = neighbours
    ? [...nodes.filter((n) => !neighbours.has(n.id)), ...nodes.filter((n) => neighbours.has(n.id) && n.id !== focus), ...nodes.filter((n) => n.id === focus)]
    : nodes;
  // Links you can point at: those of the selected person, or all of them when there aren't many.
  const hitLinks = mode !== 'people' ? [] : links.map((l, i) => ({ l, i })).filter(({ l }) => (selected ? (l.source as N).id === selected || (l.target as N).id === selected : links.length <= 400));
  const person = selected ? peopleData?.people.find((p) => PERSON + p.id === selected) : undefined;
  const personNames = useMemo(() => (graph?.nodes || []).filter((n) => n.kind === 'person').map((n) => n.title).sort((a, b) => a.localeCompare(b)), [graph]);
  const tipLink = tip ? links[tip.i] : undefined;
  const personDates = person ? dates?.dates[person.id] : undefined;

  // Era lines across the canvas, thinned so labels never crowd at the current zoom.
  const eraTicks: { year: number; y: number }[] = [];
  if (mode === 'people' && byEra) {
    const years = nodes.filter((n) => n.year != null && n.x != null).map((n) => n.year!);
    if (years.length) {
      const oldest = Math.min(...years);
      let last = -Infinity;
      for (const year of ERA_TICKS) {
        if (year < oldest - 400 && eraTicks.length) break;
        const y = size.h / 2 + view.y + eraY(year) * view.k;
        if (y - last < 26) continue;
        last = y;
        if (y > -20 && y < size.h + 20) eraTicks.push({ year, y });
      }
    }
  }

  async function saveDates() {
    if (!person || !editDates) return;
    try {
      const d = await api.setPersonDates({ id: person.id, name: person.name, ...editDates });
      setDates((x) => (x ? { ...x, dates: { ...x.dates, [person.id]: d } } : x));
      setEditDates(null);
    } catch (e) {
      alertText.current = (e as Error).message;
      setFrame((f) => f + 1);
    }
  }
  /** Merge `alias` into `into`. The server saves it and signals a vault change, which reloads the graph. */
  async function merge(alias: string, into: string) {
    setBusy(true);
    try {
      await api.mergePeople(alias, into);
      selectAfterLoad.current = selected ? into : null;
      setMergeInto(null);
      setReload((r) => r + 1);
      setDupes((d) => d?.filter((x) => x.keep.name !== alias && x.merge.name !== alias) ?? d);
    } catch (e) {
      alertText.current = (e as Error).message;
      setFrame((f) => f + 1);
    } finally {
      setBusy(false);
    }
  }

  async function unmerge(alias: string) {
    if (!person) return;
    selectAfterLoad.current = person.name;
    await api.unmergePerson(alias).catch(() => {});
    setReload((r) => r + 1);
  }

  async function notSame(d: DuplicateSuggestion) {
    setDupes((x) => x?.filter((y) => y !== d) ?? x);
    await api.notSame(d.keep.name, d.merge.name).catch(() => {});
  }

  function selectPerson(id: string) {
    setSelected(PERSON + id);
    setTip(null);
    centreOn(PERSON + id);
  }

  /** Stretch sideways about the middle of the screen, so what you're looking at stays in view. */
  function changeStretch(next: number) {
    stopFit();
    setView((v) => ({ ...v, x: (v.x * next) / stretch }));
    setStretch(next);
  }

  function switchMode(m: Mode) {
    if (m === mode) return;
    setHover(null);
    setSelected(null);
    setTip(null);
    setMode(m);
  }

  function toggle(k: LinkKind) {
    const next = { ...show, [k]: !show[k] };
    if (next.with || next.about || next.together) setShow(next);
  }

  function centreOn(id: string) {
    stopFit();
    const n = nodesRef.current.find((x) => x.id === id);
    if (!n || n.x == null) return;
    const k = Math.max(view.k, 1.1);
    setView({ k, x: -n.x * stretch * k, y: -n.y! * k });
  }

  function onFind(value: string) {
    setFind(value);
    const n = nodesRef.current.find((x) => x.kind === 'person' && x.title.toLowerCase() === value.trim().toLowerCase());
    if (n) {
      setSelected(n.id);
      setTip(null);
      centreOn(n.id);
    }
  }

  function tipAt(e: React.PointerEvent, i: number, pinned: boolean) {
    const r = wrap.current!.getBoundingClientRect();
    setTip({ i, x: e.clientX - r.left, y: e.clientY - r.top, pinned });
  }

  function onWheel(e: React.WheelEvent) {
    stopFit();
    const r = wrap.current!.getBoundingClientRect();
    const px = e.clientX - r.left - size.w / 2;
    const py = e.clientY - r.top - size.h / 2;
    const k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)));
    setView({ k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k });
  }

  function onDown(e: React.PointerEvent, id?: string) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Dots can't be dragged: pressing on one and moving pans the view, like empty canvas. A click still selects it.
    drag.current = { kind: id ? 'node' : 'pan', id, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 6) {
      d.moved = true; // small wobbles during a click still count as a click
      stopFit();
    }
    if (d.moved) setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  }
  function onUp() {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'pan' && !d.moved) {
      // A click on empty canvas clears everything.
      setSelected(null);
      setTip(null);
      setHover(null);
      setFind('');
    }
    if (d?.kind === 'node') {
      const n = nodes.find((x) => x.id === d.id)!;
      if (!d.moved) {
        if (n.kind === 'person') {
          setSelected(selected === n.id ? null : n.id);
          setTip(null);
        } else go({ slug: d.id });
      }
    }
  }

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <h1>Graph</h1>
        <div className="seg" role="group" aria-label="Show a graph of">
          <button aria-pressed={mode === 'notes'} onClick={() => switchMode('notes')}>
            Notes
          </button>
          <button aria-pressed={mode === 'people'} onClick={() => switchMode('people')}>
            People
          </button>
        </div>
        <span className="muted">
          {mode === 'notes'
            ? `${notesData?.nodes.length ?? 0} notes · ${notesData?.links.length ?? 0} connections`
            : `${nodes.length} people · ${links.length.toLocaleString()} links`}
        </span>
        <span className="grow" />
        {mode === 'notes' ? (
          <select value={focusTag} onChange={(e) => setFocusTag(e.target.value)} aria-label="Highlight a tag">
            <option value="">Highlight a tag…</option>
            {[true, false].map((own) => {
              const group = tags.filter((t) => mine.has(t) === own);
              return group.length ? (
                <optgroup key={String(own)} label={own ? 'My tags' : 'Tags'}>
                  {group.map((t) => (
                    <option key={t} value={t}>
                      #{t}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        ) : (
          <>
            <button className="legend-chip" aria-pressed={show.with} title="Both speak in the same note" onClick={() => toggle('with')}>
              <span className="legend-line with" /> Talk together
            </button>
            <button className="legend-chip" aria-pressed={show.about} title="One speaks in a note and the other is discussed in it" onClick={() => toggle('about')}>
              <span className="legend-line about" /> Talks about
            </button>
            <button
              className="legend-chip"
              aria-pressed={show.together}
              title="Both are discussed in the same notes (at least two of them)"
              onClick={() => toggle('together')}
            >
              <span className="legend-line together" /> Mentioned together
            </button>
            <button
              className="legend-chip"
              aria-pressed={byEra}
              title="Nudge people down the graph by when they lived: the further down, the longer ago"
              onClick={() => setByEra(!byEra)}
            >
              <Icon name="era" size={13} /> By era
            </button>
            {byEra && dates?.job.running && (
              <span className="muted era-progress" title="Working out when people lived, most-mentioned first">
                Dating people… {dates.job.done.toLocaleString()}/{dates.job.total.toLocaleString()}
              </span>
            )}
            {byEra && !dates?.job.running && dates?.job.error && (
              <span className="muted era-progress" title={dates.job.error}>
                Some dates failed
              </span>
            )}
            {dupes && dupes.length > 0 && (
              <button className={cx('btn btn-sm dupes-btn', showDupes && 'on')} title="Names that are probably the same person, for you to merge" onClick={() => setShowDupes(!showDupes)}>
                Possible duplicates · {dupes.length}
              </button>
            )}
            <select
              value={minNotes}
              onChange={(e) => setMinNotes(Number(e.target.value))}
              aria-label="Minimum number of notes a person must be in"
              title="Show only people who come up in at least this many notes, speaking or mentioned. Starred people always show."
            >
              {MIN_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'Any mention' : `In ${n}+ notes`}
                </option>
              ))}
            </select>
            <label className="stretch-control" title="Stretch the graph sideways, to give names more room">
              <span>Width</span>
              <input type="range" min={0.5} max={3} step={0.05} value={stretch} onChange={(e) => changeStretch(Number(e.target.value))} onDoubleClick={() => changeStretch(1)} aria-label="Horizontal stretch" />
            </label>
            <input className="graph-find" list="graph-people" value={find} onChange={(e) => onFind(e.target.value)} placeholder="Find a person…" aria-label="Find a person" />
            <datalist id="graph-people">
              {personNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
      </div>
      <div className="graph-wrap" ref={wrap} onWheel={onWheel} onPointerDown={(e) => onDown(e)} onPointerMove={onMove} onPointerUp={onUp}>
        <button
          className="btn btn-sm graph-fit"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={startFit}
        >
          Fit to view
        </button>
        {graph && graph.nodes.length === 0 && (
          <div className="graph-empty muted">
            {mode === 'notes' ? 'The graph fills in as notes are added and connected.' : 'No people match these filters yet.'}
          </div>
        )}
        <svg width={size.w} height={size.h}>
          {eraTicks.length > 0 && (
            <g className="era-axis">
              {eraTicks.map((t) => (
                <g key={t.year}>
                  <line x1={0} x2={size.w} y1={t.y} y2={t.y} />
                  <text x={size.w - 12} y={t.y - 4} textAnchor="end">
                    {yearLabel(t.year)}
                  </text>
                </g>
              ))}
            </g>
          )}
          <g transform={`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`}>
            {links.map((l, i) => {
              const s = l.source as N;
              const t = l.target as N;
              if (s.x == null || t.x == null) return null;
              const lit = tip?.i === i || (neighbours ? neighbours.has(s.id) && neighbours.has(t.id) && (s.id === focus || t.id === focus) : false);
              return (
                <line
                  key={i}
                  x1={s.x * stretch}
                  y1={s.y}
                  x2={t.x * stretch}
                  y2={t.y}
                  className={cx('g-link', l.kind, lit && 'lit', (neighbours || tip) && !lit && 'faded')}
                  strokeWidth={l.kind ? Math.min(4, { with: 1.8, about: 0.9, together: 0.7 }[l.kind] + 0.4 * (l.strength - 1)) : 0.6 + l.strength * 0.6}
                />
              );
            })}
            {hitLinks.map(({ l, i }) => {
              const s = l.source as N;
              const t = l.target as N;
              if (s.x == null || t.x == null) return null;
              return (
                <line
                  key={`hit${i}`}
                  x1={s.x * stretch}
                  y1={s.y}
                  x2={t.x * stretch}
                  y2={t.y}
                  className="g-hit"
                  strokeWidth={10 / view.k}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerMove={(e) => !tip?.pinned && tipAt(e, i, false)}
                  onPointerLeave={() => !tip?.pinned && setTip(null)}
                  onClick={(e) => tipAt(e as unknown as React.PointerEvent, i, true)}
                />
              );
            })}
            {drawOrder.map((n) => {
              if (n.x == null) return null;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x * stretch},${n.y})`}
                  className={cx('g-node', n.kind, n.appears && 'appears', n.kind === 'person' && isStarred(n.title) && 'starred', isFaded(n) && 'faded', (hover === n.id || selected === n.id) && 'hover')}
                  onPointerDown={(e) => onDown(e, n.id)}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  <circle r={radius(n)} />
                  {/* Hover or selection: an ink ring just outside the dot */}
                  {(hover === n.id || selected === n.id) && <circle className="g-ring" r={radius(n) + 3.5 / view.k} />}
                </g>
              );
            })}
            {/* Labels go in their own layer, above every node; focused labels are drawn last. */}
            {drawOrder.map((n) => {
              if (n.x == null) return null;
              const starred = n.kind === 'person' && isStarred(n.title);
              // The hovered or selected node and its neighbours are always named; the rest only where there's room.
              const showLabel = autoLabels.has(n.id) || neighbours?.has(n.id);
              if (!showLabel) return null;

              return (
                <g key={`label:${n.id}`} transform={`translate(${n.x * stretch},${n.y})`} className={cx('g-label', n.appears && 'appears', starred && 'starred', (n.id === hover || n.id === selected) && 'focus', isFaded(n) && 'faded')}>
                  <Label place={autoLabels.get(n.id) || 'below'} r={radius(n)} k={view.k} lines={labelLines(n.title, n.kind === 'person')} />
                </g>
              );
            })}
          </g>
        </svg>
        {tip && tipLink?.episodes && (
          <div
            className={cx('graph-tip', tip.pinned && 'pinned')}
            style={{ left: Math.max(8, Math.min(tip.x + 14, size.w - 330)), top: Math.max(8, Math.min(tip.y + 14, size.h - 120)) }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="graph-tip-head">
              {personNamesById.get((tipLink.source as N).id)} <span className="muted">·</span> {personNamesById.get((tipLink.target as N).id)}
              {tip.pinned && (
                <button className="icon-btn" onClick={() => setTip(null)} aria-label="Close">
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
            <ul>
              {tipLink.episodes.map((e) => (
                <li key={e.slug + e.kind + (e.speaker || '')}>
                  <a href={href({ slug: e.slug })}>{noteTitles.get(e.slug) || e.slug}</a>
                  <span className="graph-tip-kind">
                    {e.kind === 'with' ? 'both speak' : e.kind === 'together' ? 'both mentioned' : `${personNamesById.get(PERSON + e.speaker) || ''} speaks`}
                  </span>
                </li>
              ))}
            </ul>
            {!tip.pinned && <div className="graph-tip-hint">Click the line to keep this open</div>}
          </div>
        )}
        {mode === 'people' && showDupes && dupes && (
          <div className="graph-dupes" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
            <div className="graph-card-head">
              <h2>Possible duplicates</h2>
              <button className="icon-btn" onClick={() => setShowDupes(false)} aria-label="Close">
                <Icon name="x" size={14} />
              </button>
            </div>
            <p className="graph-card-sub">Names that look like one person. Merging joins their notes, links, star and dates; it can be undone from the person’s card.</p>
            {dupes.length === 0 && <p className="muted">None left.</p>}
            <ul className="dupe-list">
              {dupes.map((d) => (
                <li key={d.keep.id + '|' + d.merge.id}>
                  {[d.keep, d.merge].map((p) => (
                    <div key={p.id} className="dupe-name">
                      <button className="link-btn plain" onClick={() => selectPerson(p.id)}>
                        {p.name}
                      </button>
                      <span className="muted">
                        {' '}
                        · {p.notes} {p.notes === 1 ? 'note' : 'notes'}
                        {p.dates && p.dates.confidence !== 'none' ? ` · ${lifeLabel(p.dates)}` : ''}
                      </span>
                    </div>
                  ))}
                  <div className="dupe-actions">
                    <button className="btn btn-sm" disabled={busy} onClick={() => merge(d.merge.name, d.keep.name)} title={`“${d.merge.name}” becomes another name for ${d.keep.name}`}>
                      Keep “{d.keep.name}”
                    </button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => merge(d.keep.name, d.merge.name)} title={`“${d.keep.name}” becomes another name for ${d.merge.name}`}>
                      Keep “{d.merge.name}”
                    </button>
                    <button className="link-btn" onClick={() => notSame(d)}>
                      Different people
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {mode === 'people' && person && (
          <div className="graph-card" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
            <div className="graph-card-head">
              <h2>
                <PersonStar name={person.name} size={15} /> {person.name}
              </h2>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close">
                <Icon name="x" size={14} />
              </button>
            </div>
            {editDates ? (
              <form
                className="dates-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveDates();
                }}
              >
                <label>
                  Born <input value={editDates.born} onChange={(e) => setEditDates({ ...editDates, born: e.target.value })} placeholder="384 BC" autoFocus />
                </label>
                <label>
                  Died <input value={editDates.died} onChange={(e) => setEditDates({ ...editDates, died: e.target.value })} placeholder="322 BC, or living" />
                </label>
                <label>
                  Active <input value={editDates.active} onChange={(e) => setEditDates({ ...editDates, active: e.target.value })} placeholder="optional" />
                </label>
                {alertText.current && <span className="dates-error">{alertText.current}</span>}
                <span className="dates-edit-actions">
                  <button className="btn btn-sm" type="submit">
                    Save
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => ((alertText.current = ''), setEditDates(null))}>
                    Cancel
                  </button>
                </span>
              </form>
            ) : (
              <p className="person-dates">
                {personDates ? lifeLabel(personDates) : dates?.job.running ? 'Dating…' : 'No dates yet'}
                {personDates?.confidence === 'low' && <span className="muted"> · a guess</span>}
                {personDates?.edited && <span className="muted"> · set by you</span>}
                <button
                  className="link-btn"
                  onClick={() => {
                    alertText.current = '';
                    setEditDates({
                      born: asText(personDates?.born),
                      died: personDates?.living ? 'living' : asText(personDates?.died),
                      active: personDates?.edited ? asText(personDates?.active) : '',
                    });
                  }}
                >
                  {personDates ? 'Correct' : 'Add dates'}
                </button>
              </p>
            )}
            {(peopleData?.aliases?.[person.id]?.length ?? 0) > 0 && (
              <p className="person-aliases">
                Also called{' '}
                {peopleData!.aliases![person.id].map((a, i) => (
                  <span key={a} className="alias-chip">
                    {i > 0 && ', '}
                    {a}
                    <button className="icon-btn" onClick={() => unmerge(a)} title={`Make “${a}” a separate person again`} aria-label={`Unmerge ${a}`}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </p>
            )}
            {mergeInto != null ? (
              <form
                className="merge-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (mergeInto.trim()) merge(person.name, mergeInto.trim());
                }}
              >
                <input list="graph-people" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} placeholder="The name to keep, e.g. Jesus Christ" autoFocus aria-label="Merge into" />
                <span className="dates-edit-actions">
                  <button className="btn btn-sm" type="submit" disabled={busy || !mergeInto.trim()}>
                    Merge
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => setMergeInto(null)}>
                    Cancel
                  </button>
                </span>
                <span className="muted merge-hint">“{person.name}” becomes another name for this person. Your notes aren’t changed.</span>
                {alertText.current && <span className="dates-error">{alertText.current}</span>}
              </form>
            ) : (
              <p className="person-dates">
                <button className="link-btn first" onClick={() => ((alertText.current = ''), setMergeInto(''))}>
                  Merge into…
                </button>
              </p>
            )}
            <p className="graph-card-sub">
              {[person.appears.length && `speaks in ${person.appears.length}`, person.mentioned.length && `mentioned in ${person.mentioned.length}`].filter(Boolean).join(' · ')}
              {' · '}point at a line to see the notes behind it
            </p>
            {person.appears.length > 0 && (
              <>
                <h3 className="panel-h">Speaks in</h3>
                <ul className="graph-card-list">
                  {person.appears.map((s) => (
                    <li key={s}>
                      <a href={href({ slug: s })}>{noteTitles.get(s) || s}</a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {person.mentioned.length > 0 && (
              <>
                <h3 className="panel-h">Mentioned in</h3>
                <ul className="graph-card-list">
                  {person.mentioned.map((s) => (
                    <li key={s}>
                      <a href={href({ slug: s })}>{noteTitles.get(s) || s}</a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button className="btn btn-sm" onClick={() => go({ q: `"${person.name}"` })}>
              <Icon name="search" size={13} /> Search transcripts
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

type Place = 'below' | 'above' | 'right' | 'left';

const LINE = 14; // label line height, in screen pixels (house chart label: 12/14)

/**
 * A person's name on one or two lines: longer names with several words are split where the two
 * lines come out most even ("Augustine / of Hippo"), so labels are narrower and more of them fit.
 * Notes keep their titles on one line.
 */
function labelLines(text: string, person: boolean): string[] {
  const clip = (t: string, max: number) => (t.length > max ? t.slice(0, max - 2) + '…' : t);
  const words = text.split(' ');
  if (!person || text.length <= 11 || words.length < 2) return [clip(text, 38)];
  let best = 1;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    const bestA = words.slice(0, best).join(' ').length;
    const bestB = words.slice(best).join(' ').length;
    if (Math.max(a, b) < Math.max(bestA, bestB)) best = i;
  }
  return [clip(words.slice(0, best).join(' '), 24), clip(words.slice(best).join(' '), 24)];
}

function Label({ place, r, k, lines }: { place: Place; r: number; k: number; lines: string[] }) {
  const n = lines.length;
  const first = {
    below: r + 13 / k,
    above: -r - 5 / k - ((n - 1) * LINE) / k,
    right: 4 / k - ((n - 1) * LINE) / 2 / k,
    left: 4 / k - ((n - 1) * LINE) / 2 / k,
  }[place];
  const x = { below: 0, above: 0, right: r + 4 / k, left: -r - 4 / k }[place];
  const anchor = place === 'right' ? 'start' : place === 'left' ? 'end' : 'middle';
  return (
    <text x={x} y={first} textAnchor={anchor} style={{ fontSize: 12 / k, strokeWidth: 3.5 / k }}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i ? LINE / k : 0}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

function radius(n: { degree: number; kind: Kind; r?: number }) {
  if (n.r != null) return n.r;
  return 6 + Math.sqrt(n.degree) * 3.2;
}

/**
 * Which people to name when nothing is hovered: the largest in view first. Each label tries below,
 * above, right and left of its circle, and is left out only if all four would overlap a label
 * already placed, so a smaller name never hides a bigger one. The biggest names are shown even in
 * crowded parts (more as you zoom in); beyond those, anyone is named whose label fits without
 * covering another label or another dot.
 */
function pickLabels(nodes: N[], view: { x: number; y: number; k: number }, size: { w: number; h: number }, stretch = 1, priority: (n: N) => number = () => 0) {
  const out = new Map<string, Place>();
  const budget = Math.min(150, Math.round(32 * Math.max(1, view.k) ** 2));
  const boxes: number[][] = [];
  const ox = size.w / 2 + view.x;
  const oy = size.h / 2 + view.y;
  const clash = (b: number[]) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const ranked = nodes
    .filter((n) => n.x != null)
    .map((n) => ({ n, x: ox + n.x! * stretch * view.k, y: oy + n.y! * view.k, r: radius(n) * view.k }))
    .filter(({ x, y }) => x > 0 && x < size.w && y > 0 && y < size.h) // in view
    .sort((a, b) => priority(b.n) - priority(a.n) || b.n.degree - a.n.degree || (b.n.links || 0) - (a.n.links || 0));

  // Dots bucketed on a grid, so checking whether a label would cover one stays cheap with many people.
  const CELL = 40;
  type Dot = (typeof ranked)[number];
  const grid = new Map<string, Dot[]>();
  for (const p of ranked) {
    const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
    (grid.get(key) || grid.set(key, []).get(key)!).push(p);
  }
  const coversDot = (b: number[], self: Dot) => {
    for (let cx = Math.floor((b[0] - CELL) / CELL); cx <= Math.floor((b[2] + CELL) / CELL); cx++)
      for (let cy = Math.floor((b[1] - CELL) / CELL); cy <= Math.floor((b[3] + CELL) / CELL); cy++)
        for (const q of grid.get(`${cx},${cy}`) || []) {
          if (q === self) continue;
          const r = Math.max(2, q.r);
          if (q.x + r > b[0] && q.x - r < b[2] && q.y + r > b[1] && q.y - r < b[3]) return true;
        }
    return false;
  };

  for (const p of ranked) {
    const { n, x, y, r } = p;
    const free = out.size < budget; // the biggest names may sit over small dots; the rest must find clear space
    const lines = labelLines(n.title, n.kind === 'person');
    const w = Math.max(...lines.map((l) => textWidth(l, !!n.appears))) + 4;
    const h = lines.length * LINE;
    const tries: [Place, number[]][] = [
      ['below', [x - w / 2, y + r + 3, x + w / 2, y + r + 3 + h]],
      ['above', [x - w / 2, y - r - 3 - h, x + w / 2, y - r - 3]],
      ['right', [x + r + 3, y - h / 2, x + r + 3 + w, y + h / 2]],
      ['left', [x - r - 3 - w, y - h / 2, x - r - 3, y + h / 2]],
    ];
    const hit = tries.find(([, b]) => !clash(b) && (free || !coversDot(b, p)));
    if (!hit) continue;
    boxes.push(hit[1]);
    out.set(n.id, hit[0]);
  }
  return out;
}

// Label widths measured with the label font, cached per name.
const widths = new Map<string, number>();
// Measurements taken before the web font arrived are wrong, so start again once it has.
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => widths.clear());
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, bold: boolean) {
  const key = (bold ? 'b:' : 'n:') + text;
  let w = widths.get(key);
  if (w == null) {
    if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx) {
      measureCtx.font = `${bold ? 600 : 400} 12px 'IBM Plex Sans', system-ui, sans-serif`;
      w = measureCtx.measureText(text).width;
    } else w = text.length * 6.4;
    widths.set(key, w);
  }
  return w;
}
