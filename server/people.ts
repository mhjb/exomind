// The people graph: who appears in which notes, and who is only mentioned.
//
// New notes record speakers explicitly (`speakers:` in the frontmatter). For older notes they are
// inferred at no cost from what is already saved: the speakers of the quotes, anyone marked as host
// or guest in the people list, and people whose name is in the title or channel.

import { allEntries, getSection, vaultEvents } from './vault.ts';
import { parsePersonEntry, peopleList, personKey, withoutInitials } from './names.ts';
import type { NoteMeta, PeopleGraph } from '../shared/types.ts';
import { aliasMap, peopleFileStamp } from './aliases.ts';

// Labels a model sometimes uses in place of a name.
const GENERIC = /\b(?:host|speaker|narrator|interviewer|questioner|audience|unknown|participant|moderator|voice)\b/i;

/** Title and channel as separate phrases: "Rod Dreher on X | Interesting Times with Ross Douthat". */
function titlePhrases(meta: NoteMeta): string[] {
  return [...meta.title.split(/\s[|–—-]\s|:\s|[()[\]]/), meta.channel || ''].map((t) => ` ${personKey(t)} `).filter((t) => t.trim());
}

/** Whether a name is in the title as a participant, not as the subject ("X on Walter Benjamin"). */
function inTitle(phrases: string[], key: string): boolean {
  return phrases.some((ph) => {
    const i = ph.indexOf(` ${key} `);
    if (i < 0) return false;
    const before = ph.slice(0, i + 1);
    return !/ (?:on|about|reads|reading) /.test(before);
  });
}

/** Speakers named in the note's "Quotes" section: "> — Jane Smith, [12:34](…)". */
function quoteSpeakers(body: string): string[] {
  const out: string[] = [];
  for (const line of (getSection(body, 'Quotes') || '').split('\n')) {
    if (!/^>\s*—/.test(line)) continue;
    const m = line.match(/—\s*([^—,[\n]+?),\s*\[?(?:¶\d+|\d{1,2}:\d{2})/);
    const name = m?.[1].trim();
    if (name && /^\p{Lu}/u.test(name) && name.split(/\s+/).length <= 5 && !GENERIC.test(name)) out.push(name);
  }
  return out;
}

/** Everyone named in a note, each flagged as appearing (speaking) in it or only mentioned. */
export function notePeople(meta: NoteMeta, body: string): { name: string; speaks: boolean }[] {
  const listed = peopleList(meta.people).map(parsePersonEntry).filter((p) => p.name);
  // In a video, whoever is quoted spoke in it. In an article, people quoted are quoted by the author, not co-authors.
  const fromQuotes = meta.type === 'article' || meta.speakers_edited ? [] : peopleList(quoteSpeakers(body));
  const explicit = peopleList(meta.speakers).map((s) => parsePersonEntry(s).name);

  const speakerKeys = new Set<string>();
  const addSpeaker = (n: string) => {
    const k = personKey(n);
    if (k) speakerKeys.add(k).add(withoutInitials(k));
  };
  explicit.forEach(addSpeaker);
  fromQuotes.forEach(addSpeaker);
  if (!explicit.length && !meta.speakers_edited) {
    // Older notes: fall back on role markers and on names in the title or channel.
    const phrases = titlePhrases(meta);
    for (const p of listed) {
      const k = personKey(p.name);
      if (p.speaks) addSpeaker(p.name);
      // Single names ("Plato", "Isaiah") are too likely to be the subject rather than a speaker.
      else if (k.includes(' ') && (inTitle(phrases, k) || inTitle(phrases, withoutInitials(k)))) addSpeaker(p.name);
    }
    // Last resort, for titles like "Srnicek & Williams": a surname among the first few people listed.
    if (!speakerKeys.size)
      listed.slice(0, 4).forEach((p) => {
        const words = personKey(p.name).split(' ');
        const last = words[words.length - 1];
        if (words.length > 1 && last.length >= 4 && inTitle(phrases, last)) addSpeaker(p.name);
      });
  }

  const out = new Map<string, { name: string; speaks: boolean }>();
  const add = (name: string, speaks: boolean) => {
    const k = personKey(name);
    if (!k) return;
    const prev = out.get(k);
    out.set(k, { name: prev?.name || name, speaks: speaks || !!prev?.speaks });
  };
  for (const p of listed) {
    const k = personKey(p.name);
    add(p.name, speakerKeys.has(k) || speakerKeys.has(withoutInitials(k)));
  }
  // Quote speakers or listed speakers missing from the people list still appear.
  for (const n of [...explicit, ...fromQuotes]) {
    const k = personKey(n);
    if (![...out.keys()].some((o) => o === k || withoutInitials(o) === withoutInitials(k))) add(n, true);
  }
  return [...out.values()];
}

// The graph is rebuilt only when a note or people.md (merges) changes: several requests ask for it at once.
let vaultVersion = 0;
vaultEvents.on('change', () => vaultVersion++);
let cached: { stamp: string; graph: PeopleGraph } | null = null;

export function peopleGraph(): PeopleGraph {
  const stamp = `${vaultVersion}|${peopleFileStamp()}`;
  if (cached?.stamp === stamp) return cached.graph;
  const graph = buildPeopleGraph();
  cached = { stamp, graph };
  return graph;
}

function buildPeopleGraph(): PeopleGraph {
  const notes: PeopleGraph['notes'] = [];
  const acc = new Map<string, { names: Map<string, number>; appears: Set<string>; mentioned: Set<string> }>();
  for (const e of allEntries()) {
    const people = notePeople(e.meta, e.body);
    if (!people.length) continue;
    notes.push({ id: e.slug, title: e.meta.title, channel: e.meta.channel });
    for (const p of people) {
      const k = personKey(p.name);
      let a = acc.get(k);
      if (!a) acc.set(k, (a = { names: new Map(), appears: new Set(), mentioned: new Set() }));
      a.names.set(p.name, (a.names.get(p.name) || 0) + 1);
      (p.speaks ? a.appears : a.mentioned).add(e.slug);
    }
  }

  // "Jordan Peterson" joins "Jordan B. Peterson" when that is the only initialled match.
  const byBare = new Map<string, string[]>();
  for (const o of acc.keys()) {
    const b = withoutInitials(o);
    (byBare.get(b) || byBare.set(b, []).get(b)!).push(o);
  }
  for (const k of [...acc.keys()]) {
    if (withoutInitials(k) !== k || k.split(' ').length < 2) continue;
    const matches = (byBare.get(k) || []).filter((o) => o !== k && acc.has(o));
    if (matches.length !== 1) continue;
    const from = acc.get(k)!;
    const into = acc.get(matches[0])!;
    for (const [n, c] of from.names) into.names.set(n, (into.names.get(n) || 0) + c);
    from.appears.forEach((s) => into.appears.add(s));
    from.mentioned.forEach((s) => into.mentioned.add(s));
    acc.delete(k);
  }

  // Names merged by hand ("Jesus" → "Jesus Christ") join the person they were merged into, shown under that name.
  const aliases = aliasMap();
  const aliasNames: Record<string, string[]> = {};
  const aliasOf: Record<string, string> = {};
  const forced = new Map<string, string>();
  for (const k of [...acc.keys()]) {
    const canon = aliases.get(k) || aliases.get(withoutInitials(k));
    if (!canon) continue;
    let ck = personKey(canon);
    // The person merged into may itself be stored under an initialled spelling.
    if (!acc.has(ck)) ck = [...acc.keys()].find((o) => withoutInitials(o) === withoutInitials(ck)) || ck;
    if (ck === k) continue;
    const from = acc.get(k)!;
    let into = acc.get(ck);
    if (!into) acc.set(ck, (into = { names: new Map(), appears: new Set(), mentioned: new Set() }));
    from.appears.forEach((s) => into.appears.add(s));
    from.mentioned.forEach((s) => into.mentioned.add(s));
    (aliasNames[ck] ||= []).push(...from.names.keys());
    aliasOf[k] = ck;
    forced.set(ck, canon);
    acc.delete(k);
  }

  const people: PeopleGraph['people'] = [];
  for (const [id, a] of acc) {
    for (const s of a.appears) a.mentioned.delete(s);
    // Display the most used spelling; on a tie, the fuller one.
    const name = forced.get(id) || [...a.names.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0][0];
    people.push({ id, name, appears: [...a.appears], mentioned: [...a.mentioned] });
  }
  people.sort((x, y) => y.appears.length + y.mentioned.length - (x.appears.length + x.mentioned.length) || x.name.localeCompare(y.name));
  return { notes, people, aliases: aliasNames, aliasOf };
}

/** The people the graph currently treats as speaking in a note (an article's authors). */
export function noteSpeakers(meta: NoteMeta, body: string): string[] {
  return notePeople(meta, body)
    .filter((p) => p.speaks)
    .map((p) => p.name);
}

/**
 * Set who speaks in a note: a video's speakers, or an article's authors. The new names replace the
 * old ones everywhere the people graph looks: the `speakers` field (and `author` for articles), the
 * people list, the People & works lines and, for a straight rename, the quote attributions.
 * Several names can be given, separated by commas, semicolons or "and". Once set by hand, the list
 * is final: speakers are no longer inferred from quotes or the title.
 */
export function setSpeakers(meta: NoteMeta, body: string, input: string): { meta: NoteMeta; body: string; renamed?: { from: string; to: string } } {
  const article = meta.type === 'article';
  const next = peopleList(input.trim() ? [input.trim()] : [])
    .map((n) => parsePersonEntry(n).name)
    .filter(Boolean);
  const current = noteSpeakers(meta, body);
  const oldNames = [...current, ...(article ? peopleList(meta.author ? [meta.author] : []) : [])].map((n) => parsePersonEntry(n).name);
  const oldKeys = new Set(oldNames.flatMap((n) => [personKey(n), withoutInitials(personKey(n))]));
  const isOld = (n: string) => {
    const k = personKey(parsePersonEntry(n).name);
    return oldKeys.has(k) || oldKeys.has(withoutInitials(k));
  };
  const nextKeys = new Set(next.flatMap((n) => [personKey(n), withoutInitials(personKey(n))]));
  const isNext = (n: string) => {
    const k = personKey(parsePersonEntry(n).name);
    return nextKeys.has(k) || nextKeys.has(withoutInitials(k));
  };

  // One speaker swapped for one other ("O.G. Rose" → "Daniel Rose", the rest unchanged) is a rename:
  // the same person under a better name, not a second person.
  const dropped = current.filter((n) => !isNext(n));
  const added = next.filter((n) => !isOld(n));
  const renamed = dropped.length === 1 && added.length === 1 ? { from: parsePersonEntry(dropped[0]).name, to: added[0] } : undefined;
  const fromKey = renamed ? personKey(renamed.from) : '';
  const isRenamed = (n: string) => {
    if (!renamed) return false;
    const k = personKey(parsePersonEntry(n).name);
    return k === fromKey || withoutInitials(k) === withoutInitials(fromKey);
  };

  // People list: new speakers first. A wrongly detected article author or a renamed speaker is dropped;
  // a video's former speaker otherwise stays on as someone mentioned (probably discussed, just not speaking).
  const others = peopleList(meta.people)
    .map((p) => parsePersonEntry(p).name)
    .filter((p) => p && !isNext(p) && !(article && isOld(p)) && !isRenamed(p));
  const people = [...next, ...others];

  // Rebuild the speaker lines of "People & works" from the new lists.
  const lines = next.length
    ? [`- **${article ? 'Author' : 'Speaking'}:** ${next.join(', ')}`, ...(others.length ? [`- **Mentioned:** ${others.join(', ')}`] : [])]
    : others.length
      ? [`- **People:** ${others.join(', ')}`]
      : [];
  const peopleLine = /^- \*\*(?:Author|Speaking|Mentioned|People):\*\* .*$/m;
  let out = body;
  if (peopleLine.test(out)) {
    out = out.replace(peopleLine, '\u0000');
    out = out.replace(new RegExp(peopleLine.source + '\\n?', 'gm'), '');
    out = out.replace(/\u0000\n?/, lines.length ? lines.join('\n') + '\n' : '');
  } else if (lines.length && /^## People & works\s*$/m.test(out)) {
    out = out.replace(/^## People & works\s*\n\n?/m, (h) => `${h.trimEnd()}\n\n${lines.join('\n')}\n`);
  }

  // Quotes: credit the new name when this is a straight rename (one name for one), or for an article
  // whose authors were wrong. Several speakers in a video are left as the model attributed them.
  // Also, a quote credited to a first or last name alone ("Iain") gets the matching full name.
  const rename = next.length === 1 && (article || current.length <= 1);
  const fullName = (name: string) => {
    const k = personKey(name);
    if (k.includes(' ')) return null;
    const hits = next.filter((n) => {
      const w = personKey(n).split(' ');
      return w.length > 1 && (w[0] === k || w[w.length - 1] === k);
    });
    return hits.length === 1 ? hits[0] : null;
  };
  out = out.replace(/^(>\s*—\s*)([^—,[\n]+?)(,\s*\[)/gm, (m, a, name: string, b) => {
    const to = fullName(name) || (rename && isOld(name) ? next[0] : null) || (isRenamed(name) ? renamed!.to : null);
    return to ? `${a}${to}${b}` : m;
  });

  return {
    meta: {
      ...meta,
      ...(article ? { author: next.length ? next.join(', ') : undefined } : {}),
      speakers: next.length ? next : undefined,
      speakers_edited: true,
      people,
    },
    body: out,
    renamed,
  };
}

/** The names and works listed in a body's "People & works" lines. */
function listedInBody(body: string) {
  const speakers: string[] = [];
  const people: string[] = [];
  const works: string[] = [];
  for (const m of body.matchAll(/^- \*\*(Author|Speaking|Mentioned|People|Works):\*\*[ \t]*(.*)$/gm)) {
    if (m[1] === 'Works') {
      works.push(...m[2].split(/;\s*/).map((w) => w.trim()).filter(Boolean));
      continue;
    }
    const names = peopleList([m[2]]).map((n) => parsePersonEntry(n).name).filter(Boolean);
    people.push(...names);
    if (m[1] === 'Author' || m[1] === 'Speaking') speakers.push(...names);
  }
  return { speakers, people, works };
}

const sameNames = (a: string[], b: string[]) => {
  const k = (l: string[]) => l.map(personKey).sort().join('|');
  return k(a) === k(b);
};

/**
 * Keep a note's `people` and `works` fields in step with its "People & works" lines after the body is
 * edited by hand: names or works added to the lines in this edit are added to the fields, and ones
 * deleted from the lines are removed. Only the change is applied, because the lines don't always split
 * back into the stored lists ("John Russell, 1st Earl Russell" is one person; some works contain
 * semicolons). A changed Speaking (or an article's Author) line goes through setSpeakers, like the
 * speakers editor.
 */
export function syncPeopleFromBody(meta: NoteMeta, oldBody: string, body: string): { meta: NoteMeta; body: string; renamed?: { from: string; to: string } } {
  if (oldBody === body) return { meta, body };
  const before = listedInBody(oldBody);
  const after = listedInBody(body);
  const keys = (l: string[]) => new Set(l.flatMap((n) => [personKey(n), withoutInitials(personKey(n))]));
  const matches = (set: Set<string>, n: string) => {
    const k = personKey(parsePersonEntry(n).name);
    return set.has(k) || set.has(withoutInitials(k));
  };

  // People
  const beforeKeys = keys(before.people);
  const afterKeys = keys(after.people);
  const added = after.people.filter((n) => !matches(beforeKeys, n));
  const removed = keys(before.people.filter((n) => !matches(afterKeys, n)));
  let people = peopleList(meta.people).filter((p) => !matches(removed, p));
  const have = keys(people.map((p) => parsePersonEntry(p).name));
  people = [...people, ...added.filter((n) => !matches(have, n))];

  // Works, compared as written (ignoring case and spacing)
  const norm = (w: string) => w.toLowerCase().replace(/\s+/g, ' ').trim();
  const worksBefore = new Set(before.works.map(norm));
  const worksAfter = new Set(after.works.map(norm));
  const worksGone = new Set([...worksBefore].filter((w) => !worksAfter.has(w)));
  let works = (meta.works || []).filter((w) => !worksGone.has(norm(w)));
  const worksHave = new Set(works.map(norm));
  works = [...works, ...after.works.filter((w) => !worksBefore.has(norm(w)) && !worksHave.has(norm(w)))];

  // Lists nobody touched stay exactly as stored.
  const next: NoteMeta = { ...meta };
  if (added.length || removed.size) next.people = people.length ? people : undefined;
  if (worksGone.size || works.length !== (meta.works || []).length) next.works = works.length ? works : undefined;
  if (!sameNames(before.speakers, after.speakers) && after.speakers.length) return setSpeakers(next, body, after.speakers.join(', '));
  return { meta: next, body };
}
