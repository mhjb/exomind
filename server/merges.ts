// Merging two names into one person, undoing it, and suggesting likely duplicates.

import { canonicalName, mergeGroups, notSamePairs, writeMergeGroups, writeNotSamePairs } from './aliases.ts';
import { activeYear, moveDates, peopleDates } from './lifespans.ts';
import { peopleGraph } from './people.ts';
import { moveStar } from './starredPeople.ts';
import { vaultEvents } from './vault.ts';
import { personKey, withoutInitials } from './names.ts';
import type { DuplicateSuggestion, PersonDates } from '../shared/types.ts';

const same = (a: string, b: string) => {
  const x = personKey(a);
  const y = personKey(b);
  return !!x && (x === y || withoutInitials(x) === withoutInitials(y));
};

const changed = () => vaultEvents.emit('change', { slug: '', kind: 'people' });

/** Treat `alias` as another name for `into`. Anyone already merged into `alias` comes along. */
export function mergePeople(aliasIn: string, intoIn: string) {
  const alias = aliasIn.trim();
  const into = canonicalName(intoIn.trim()); // merging into an alias means merging into its person
  if (!personKey(alias) || !personKey(into)) throw new Error('Two names are needed');
  if (same(alias, into)) throw new Error('Those are already the same person');

  const groups = mergeGroups();
  const moving = [alias, ...(groups.find((g) => same(g.name, alias))?.aliases || [])];
  const rest = groups
    .filter((g) => !same(g.name, alias))
    .map((g) => ({ ...g, aliases: g.aliases.filter((a) => !moving.some((m) => same(m, a))) }));
  let target = rest.find((g) => same(g.name, into));
  if (!target) rest.push((target = { name: into, aliases: [] }));
  for (const m of moving) if (!target.aliases.some((a) => same(a, m))) target.aliases.push(m);
  writeMergeGroups(rest);

  for (const m of moving) {
    moveStar(m, into);
    moveDates(personKey(m), personKey(into), into);
  }
  // A suggestion dismissed earlier no longer matters.
  writeNotSamePairs(notSamePairs().filter(([a, b]) => !(same(a, alias) && same(b, into)) && !(same(b, alias) && same(a, into))));
  changed();
  return { ok: true };
}

/** Make `alias` its own person again. */
export function unmergePerson(aliasIn: string) {
  const alias = aliasIn.trim();
  writeMergeGroups(mergeGroups().map((g) => ({ ...g, aliases: g.aliases.filter((a) => !same(a, alias)) })));
  changed();
  return { ok: true };
}

/** Two names that look alike but are different people: stop suggesting them. */
export function markNotSame(a: string, b: string) {
  const pairs = notSamePairs();
  if (!pairs.some(([x, y]) => (same(x, a) && same(y, b)) || (same(x, b) && same(y, a)))) pairs.push([a.trim(), b.trim()]);
  writeNotSamePairs(pairs);
  return { ok: true };
}

// Words that don't identify anyone on their own.
// Regnal numbers are kept: "Charles III" isn't any Charles.
const STOP = new Set(['of', 'the', 'de', 'la', 'le', 'von', 'van', 'der', 'and', 'st', 'saint', 'jr', 'sr']);
// "Mary, mother of Jesus" names someone by their relation to Jesus; she isn't Jesus.
const RELATIONAL = /\b(mother|father|son|daughter|wife|husband|brother|sister|disciple|student|teacher)\b/;
const words = (key: string) => key.split(' ').filter((w) => (w.length > 1 || w === 'i') && !STOP.has(w));

/** Whether two people's dates allow them to be the same person. */
function datesAgree(a: PersonDates, b: PersonDates): boolean {
  const x = activeYear(a);
  const y = activeYear(b);
  if (x == null || y == null) return false;
  const now = new Date().getFullYear();
  // Dates for the ancient world are looser than for the modern one.
  const slack = Math.max(40, 0.1 * (now - Math.min(x, y)));
  if (Math.abs(x - y) > slack) return false;
  if (a.born != null && b.born != null && Math.abs(a.born - b.born) > slack) return false;
  // Modern people are dated to the year: two names for one person share a birth year.
  if (Math.min(x, y) > 1850 && (a.born == null || b.born == null || Math.abs(a.born - b.born) > 1)) return false;
  return true;
}

/**
 * Pairs that are probably the same person, for you to confirm:
 * - one name is the other with words left out ("Augustine" / "Augustine of Hippo", "Jesus" / "Jesus Christ"),
 *   and their dates agree; or
 * - both have the same, firmly known birth and death years ("Saint Augustine" / "Augustine of Hippo").
 * Nothing is merged without you.
 */
export function duplicateSuggestions(): DuplicateSuggestion[] {
  const people = peopleGraph().people;
  const dates = peopleDates().dates;
  const dismissed = notSamePairs();
  const isDismissed = (a: string, b: string) => dismissed.some(([x, y]) => (same(x, a) && same(y, b)) || (same(x, b) && same(y, a)));

  const byId = new Map(people.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: DuplicateSuggestion[] = [];
  const consider = (aId: string, bId: string, reason: DuplicateSuggestion['reason']) => {
    const key = aId < bId ? `${aId}\n${bId}` : `${bId}\n${aId}`;
    if (aId === bId || seen.has(key)) return;
    seen.add(key);
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;
    if (isDismissed(a.name, b.name)) return;
    const card = (p: typeof a) => ({ id: p.id, name: p.name, notes: p.appears.length + p.mentioned.length, dates: dates[p.id] });
    // Offer to keep the name your notes use most (on a tie, the fuller one); you can choose the other.
    const [keep, drop] = card(b).notes > card(a).notes || (card(b).notes === card(a).notes && b.name.length > a.name.length) ? [b, a] : [a, b];
    out.push({ keep: card(keep), merge: card(drop), reason });
  };

  // Same words, fewer of them.
  const index = new Map<string, string[]>();
  for (const p of people) for (const w of new Set(words(p.id))) (index.get(w) || index.set(w, []).get(w)!).push(p.id);
  for (const p of people) {
    const mine = words(p.id);
    if (!mine.length) continue;
    const da = dates[p.id];
    // A bare "David" or "Sam" could be anyone: only names firmly placed in time are compared.
    if (!da || da.confidence === 'none' || da.confidence === 'low') continue;
    const rarest = mine.reduce((x, y) => ((index.get(x)?.length || 0) <= (index.get(y)?.length || 0) ? x : y));
    for (const q of index.get(rarest) || []) {
      if (q === p.id) continue;
      const theirs = words(q);
      if (theirs.length <= mine.length || !mine.every((w) => theirs.includes(w)) || RELATIONAL.test(q)) continue;
      const db = dates[q];
      if (!db || db.confidence === 'none' || db.confidence === 'low' || !datesAgree(da, db)) continue;
      consider(p.id, q, 'name');
    }
  }

  // Same firm dates.
  const byDates = new Map<string, string[]>();
  for (const p of people) {
    const d = dates[p.id];
    if (!d || d.born == null || d.died == null || d.confidence === 'low' || d.confidence === 'none') continue;
    const k = `${d.born}|${d.died}`;
    (byDates.get(k) || byDates.set(k, []).get(k)!).push(p.id);
  }
  for (const ids of byDates.values()) {
    if (ids.length < 2 || ids.length > 6) continue; // a crowd sharing dates is a coincidence, not one person
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        // Different people do share years, so ask for a name in common. In the ancient world one person
        // often goes by quite different single names (Octavian / Augustus), so there one word is enough.
        const shared = words(ids[i]).some((w) => words(ids[j]).includes(w));
        const ancient = (dates[ids[i]].died ?? 0) < 1500;
        if (shared || (ancient && (words(ids[i]).length === 1 || words(ids[j]).length === 1))) consider(ids[i], ids[j], 'dates');
      }
  }

  return out.sort((x, y) => y.keep.notes + y.merge.notes - (x.keep.notes + x.merge.notes));
}
