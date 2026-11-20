// Merged people: names that are the same person ("Jesus" → "Jesus Christ"). Kept in the vault's
// `people.md` beside the starred list, as
//
//   merged:
//     - name: Jesus Christ
//       aliases: [Jesus]
//   not_same:
//     - [Paul, Paul the Apostle]
//
// The notes themselves are never rewritten: the people graph, stars and dates read the names through
// this list, so a merge can be undone and the list edited by hand.

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { dirs } from './vault.ts';
import { personKey, withoutInitials } from './names.ts';

export interface MergeGroup {
  name: string;
  aliases: string[];
}

const HEADER = 'People starred in Exo-mind, and names merged as the same person. Edit in the app, or edit the lists above by hand.\n';

const file = () => path.join(dirs().root, 'people.md');
let cache: { file: string; mtime: number; data: Record<string, unknown>; content: string } | null = null;

/** The whole of people.md: frontmatter and text. Shared with the starred list. */
export function readPeopleFile(): { data: Record<string, unknown>; content: string } {
  const f = file();
  let mtime = 0;
  try {
    mtime = fs.statSync(f).mtimeMs;
  } catch {
    return { data: {}, content: '' };
  }
  if (cache && cache.file === f && cache.mtime === mtime) return cache;
  let data: Record<string, unknown> = {};
  let content = '';
  try {
    const m = matter(fs.readFileSync(f, 'utf8'));
    data = m.data || {};
    content = m.content;
  } catch (e) {
    console.error('[people] failed to read', f, (e as Error).message);
  }
  cache = { file: f, mtime, data, content };
  return cache;
}

/** Replace one list in people.md, keeping the others and the text as they are. Empty lists are dropped. */
export function writePeopleField(key: string, value: unknown[]) {
  const { data, content } = readPeopleFile();
  const next: Record<string, unknown> = { ...data };
  if (value.length) next[key] = value;
  else delete next[key];
  fs.writeFileSync(file(), matter.stringify('\n' + (content.trim() || HEADER.trim()) + '\n', next));
  cache = null;
}

/** Changes whenever people.md does, by the app or by hand. */
export function peopleFileStamp(): number {
  try {
    return fs.statSync(file()).mtimeMs;
  } catch {
    return 0;
  }
}

const str = (v: unknown) => String(v ?? '').trim();

export function mergeGroups(): MergeGroup[] {
  const raw = readPeopleFile().data.merged;
  return (Array.isArray(raw) ? raw : [])
    .map((g: unknown) => {
      const o = (typeof g === 'object' && g ? g : {}) as { name?: unknown; aliases?: unknown };
      const aliases = (Array.isArray(o.aliases) ? o.aliases : [o.aliases]).map(str).filter(Boolean);
      return { name: str(o.name), aliases };
    })
    .filter((g) => g.name && g.aliases.length);
}

export function writeMergeGroups(groups: MergeGroup[]) {
  writePeopleField(
    'merged',
    groups.filter((g) => g.aliases.length).map((g) => ({ name: g.name, aliases: g.aliases })),
  );
}

/** Pairs marked as not the same person, so they aren't suggested again. */
export function notSamePairs(): string[][] {
  const raw = readPeopleFile().data.not_same;
  return (Array.isArray(raw) ? raw : []).filter(Array.isArray).map((p: unknown[]) => p.map(str)).filter((p) => p.length === 2 && p[0] && p[1]);
}

export function writeNotSamePairs(pairs: string[][]) {
  writePeopleField('not_same', pairs);
}

/**
 * Alias matching key → the name it's merged into. Keys are matched like everywhere else in the
 * people graph, so "Jesus" also catches "jesus" and "Jésus".
 */
export function aliasMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of mergeGroups())
    for (const a of g.aliases) {
      const k = personKey(a);
      if (!k || k === personKey(g.name)) continue;
      m.set(k, g.name);
      if (!m.has(withoutInitials(k))) m.set(withoutInitials(k), g.name);
    }
  return m;
}

/** The name someone is merged into, or the name itself. */
export function canonicalName(name: string, map = aliasMap()): string {
  const k = personKey(name);
  return map.get(k) || map.get(withoutInitials(k)) || name;
}
