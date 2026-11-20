// People you've starred as worth paying attention to, kept in the vault as `people.md`
// so the list travels with your notes and can be edited by hand (one `- name:` per person).
//
// Entries are objects rather than bare names so they can later grow into person pages
// (aliases, notes) without changing the format.

import { readPeopleFile, writePeopleField } from './aliases.ts';
import { personKey, withoutInitials } from './names.ts';
import { peopleGraph } from './people.ts';
import type { StarredPerson } from '../shared/types.ts';

interface Entry {
  name: string;
}

function read(): Entry[] {
  const raw = readPeopleFile().data.starred;
  return (Array.isArray(raw) ? raw : [])
    .map((e: unknown) => ({ name: String(typeof e === 'object' && e ? (e as { name?: unknown }).name ?? '' : e ?? '').trim() }))
    .filter((e) => e.name);
}

function write(list: Entry[]) {
  writePeopleField('starred', list);
}

const same = (a: string, b: string) => {
  const x = personKey(a);
  const y = personKey(b);
  return !!x && (x === y || withoutInitials(x) === withoutInitials(y));
};

/** The starred people, with the notes each one speaks in and is mentioned in. */
export function starredPeople(): StarredPerson[] {
  const list = read();
  if (!list.length) return [];
  const graph = peopleGraph().people;
  return list
    .map((e) => {
      const p = graph.find((g) => same(g.id, e.name));
      return { name: e.name, key: personKey(e.name), appears: p?.appears || [], mentioned: p?.mentioned || [] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Star or unstar someone. Returns the updated list. */
export function setStarred(name: string, starred: boolean): StarredPerson[] {
  const clean = name.trim();
  if (!clean || !personKey(clean)) throw new Error('A name is needed');
  const list = read().filter((e) => !same(e.name, clean));
  if (starred) list.push({ name: clean });
  write(list);
  return starredPeople();
}

/**
 * After a speaker is renamed in a note, move a star on the old name to the new one, so the person
 * isn't listed twice. Only when the old name no longer appears in any note: otherwise it may be a
 * different person who was wrongly credited here, and their star stays.
 */
export function renameStarred(from: string, to: string) {
  const list = read();
  if (!list.some((e) => same(e.name, from))) return;
  if (peopleGraph().people.some((g) => same(g.id, from))) return;
  const next = list.filter((e) => !same(e.name, from));
  if (!next.some((e) => same(e.name, to))) next.push({ name: to.trim() });
  write(next);
}

/** After two names are merged, a star on the merged-away name moves to the person it now belongs to. */
export function moveStar(from: string, to: string) {
  const list = read();
  if (!list.some((e) => same(e.name, from))) return;
  const next = list.filter((e) => !same(e.name, from));
  if (!next.some((e) => same(e.name, to))) next.push({ name: to.trim() });
  write(next);
}
