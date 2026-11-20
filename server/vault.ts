import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import matter from 'gray-matter';
import chokidar, { type FSWatcher } from 'chokidar';
import { getConfig } from './config.ts';
import type { Backlink, Connection, NoteFull, NoteMeta, NoteSummary, ResolvedConnection } from '../shared/types.ts';
import { INVEST_TAG } from '../shared/types.ts';

interface Entry {
  slug: string;
  meta: NoteMeta;
  body: string; // body without the generated connections section
  mtime: number;
}

export const vaultEvents = new EventEmitter();
const notes = new Map<string, Entry>();
let watcher: FSWatcher | null = null;
const recentWrites = new Map<string, number>(); // slug -> time, to avoid echoing our own writes

export const dirs = () => {
  const root = getConfig().vaultPath;
  return {
    root,
    notes: path.join(root, 'notes'),
    transcripts: path.join(root, 'transcripts'),
    exo: path.join(root, '.exo'),
    trash: path.join(root, '.trash'),
  };
};

// ---------- markdown helpers ----------

const CONN_MARK = '<!-- exo:connections — generated from the `connections` frontmatter; edit links in the app -->';

export function stripConnections(body: string) {
  const i = body.indexOf('## Connections\n' + CONN_MARK.slice(0, 20));
  if (i < 0) return body.trimEnd();
  const rest = body.slice(i + 15);
  const next = rest.search(/\n## /);
  return (body.slice(0, i) + (next >= 0 ? rest.slice(next + 1) : '')).trimEnd();
}

function connectionsSection(conns: Connection[]) {
  if (!conns.length) return '';
  const lines = conns.map((c) => {
    const t = notes.get(c.target)?.meta.title;
    return `- [[${c.target}${t ? '|' + t.replace(/[|\]]/g, '') : ''}]] — ${c.reason}`;
  });
  return `\n\n## Connections\n${CONN_MARK}\n${lines.join('\n')}\n`;
}

/** Get the text of a `## Heading` section (without the heading). */
export function getSection(body: string, heading: string): string | null {
  const re = new RegExp(`^## ${heading}\\s*$`, 'm');
  const m = re.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/\n## /);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

export function slugify(s: string) {
  let slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 70) {
    slug = slug.slice(0, 70);
    const cut = slug.lastIndexOf('-');
    if (cut > 40) slug = slug.slice(0, cut); // don't end mid-word
  }
  return slug.replace(/-+$/, '') || 'note';
}

export function uniqueSlug(base: string, id?: string) {
  let slug = slugify(base);
  if (!notes.has(slug) && !fs.existsSync(path.join(dirs().notes, slug + '.md'))) return slug;
  if (id) slug = `${slug}-${slugify(id)}`;
  let n = 2;
  let candidate = slug;
  while (notes.has(candidate)) candidate = `${slug}-${n++}`;
  return candidate;
}

function clean<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (v === undefined || v === null || v === '' ? undefined : v)));
}

function normaliseMeta(data: any, slug: string): NoteMeta {
  const d = { ...data };
  for (const k of ['published', 'added']) {
    if (d[k] instanceof Date) d[k] = k === 'published' ? d[k].toISOString().slice(0, 10) : d[k].toISOString();
  }
  return {
    id: String(d.id ?? slug),
    type: d.type || 'manual',
    title: String(d.title ?? slug),
    ...d,
    tags: Array.isArray(d.tags) ? d.tags.map(String) : d.tags ? String(d.tags).split(/,\s*/) : [],
    my_tags: Array.isArray(d.my_tags) ? d.my_tags.map(String) : d.my_tags ? String(d.my_tags).split(/,\s*/) : undefined,
    connections: Array.isArray(d.connections)
      ? d.connections.filter((c: any) => c && c.target).map((c: any) => ({ ...c, target: String(c.target), reason: String(c.reason ?? '') }))
      : [],
    added: d.added || new Date(0).toISOString(),
  };
}

// ---------- read / write ----------

function readFile(file: string): Entry | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const slug = path.basename(file, '.md');
    const parsed = matter(raw);
    return {
      slug,
      meta: normaliseMeta(parsed.data, slug),
      body: stripConnections(parsed.content.replace(/^\n+/, '')),
      mtime: fs.statSync(file).mtimeMs,
    };
  } catch (e) {
    console.error('[vault] failed to read', file, (e as Error).message);
    return null;
  }
}

export function writeNote(slug: string, meta: NoteMeta, body: string) {
  const d = dirs();
  fs.mkdirSync(d.notes, { recursive: true });
  const cleanBody = stripConnections(body);
  const full = cleanBody + connectionsSection(meta.connections);
  const out = matter.stringify('\n' + full.trim() + '\n', clean(meta));
  const file = path.join(d.notes, slug + '.md');
  recentWrites.set(slug, Date.now());
  fs.writeFileSync(file, out);
  notes.set(slug, { slug, meta, body: cleanBody, mtime: Date.now() });
  vaultEvents.emit('change', { slug, kind: 'write' });
}

export function writeTranscript(slug: string, content: string) {
  const d = dirs();
  fs.mkdirSync(d.transcripts, { recursive: true });
  fs.writeFileSync(path.join(d.transcripts, slug + '.md'), content);
  return `transcripts/${slug}.md`;
}

export function readTranscript(meta: NoteMeta, slug: string): string | null {
  const rel = meta.transcript || `transcripts/${slug}.md`;
  const file = path.join(dirs().root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function deleteNote(slug: string) {
  const d = dirs();
  const e = notes.get(slug);
  if (!e) return false;
  fs.mkdirSync(d.trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const src = path.join(d.notes, slug + '.md');
  if (fs.existsSync(src)) fs.renameSync(src, path.join(d.trash, `${slug}.${stamp}.md`));
  const t = path.join(d.root, e.meta.transcript || `transcripts/${slug}.md`);
  if (fs.existsSync(t)) fs.renameSync(t, path.join(d.trash, `${slug}.transcript.${stamp}.md`));
  notes.delete(slug);
  recentWrites.set(slug, Date.now());
  vaultEvents.emit('change', { slug, kind: 'delete' });
  return true;
}

// ---------- queries ----------

export function getEntry(slug: string) {
  return notes.get(slug);
}

export function allEntries() {
  return [...notes.values()];
}

export function findById(id: string) {
  for (const e of notes.values()) if (e.meta.id === id) return e;
  return undefined;
}

export function backlinksFor(slug: string): Backlink[] {
  const out: Backlink[] = [];
  for (const e of notes.values()) {
    if (e.slug === slug) continue;
    const c = e.meta.connections.find((c) => c.target === slug);
    if (c) out.push({ slug: e.slug, title: e.meta.title, reason: c.reason, strength: c.strength });
  }
  return out;
}

export function summaries(): NoteSummary[] {
  const incoming = new Map<string, number>();
  for (const e of notes.values()) for (const c of e.meta.connections) incoming.set(c.target, (incoming.get(c.target) || 0) + 1);
  return allEntries()
    .map((e) => ({
      slug: e.slug,
      type: e.meta.type,
      title: e.meta.title,
      channel: e.meta.channel,
      author: e.meta.author,
      words: e.meta.words,
      gist: e.meta.gist,
      tags: allTags(e.meta),
      myTags: e.meta.my_tags || [],
      added: e.meta.added,
      published: e.meta.published,
      duration: e.meta.duration,
      thumbnail: e.meta.thumbnail,
      starred: e.meta.starred,
      links: e.meta.connections.length + (incoming.get(e.slug) || 0),
    }))
    .sort((a, b) => b.added.localeCompare(a.added));
}

/**
 * The old investment flag became the personal tag "investment". Notes still carrying the flag get the
 * tag instead; and since the tag is now yours, the model's own "investment" tags are taken off, so it
 * means only what you've flagged.
 */
function migrateInvestFlag() {
  const flagged = [...notes.values()].filter((e) => e.meta.invest);
  if (!flagged.length) return;
  for (const e of flagged) {
    const mine = [...new Set([...(e.meta.my_tags || []), INVEST_TAG])];
    writeNote(e.slug, { ...e.meta, invest: undefined, my_tags: mine, tags: e.meta.tags.filter((t) => t !== INVEST_TAG) }, e.body);
  }
  for (const e of notes.values())
    if (e.meta.tags.includes(INVEST_TAG) && !e.meta.my_tags?.includes(INVEST_TAG)) writeNote(e.slug, { ...e.meta, tags: e.meta.tags.filter((t) => t !== INVEST_TAG) }, e.body);
  console.log(`[vault] moved ${flagged.length} investment flag(s) to the "${INVEST_TAG}" tag`);
}

/** Your tags: ones you've added by hand that the model doesn't also use (see web/src/App.tsx). */
export function myTagSet(): Set<string> {
  const mine = new Set<string>();
  const theirs = new Set<string>();
  for (const e of notes.values()) {
    for (const t of e.meta.my_tags || []) mine.add(t);
    for (const t of e.meta.tags) theirs.add(t);
  }
  for (const t of theirs) mine.delete(t);
  return mine;
}

/** Every tag on a note: those added by hand first, then the model's (without repeats). */
export function allTags(meta: NoteMeta): string[] {
  return [...new Set([...(meta.my_tags || []), ...meta.tags])];
}

export function fullNote(slug: string): NoteFull | null {
  const e = notes.get(slug);
  if (!e) return null;
  const connections: ResolvedConnection[] = e.meta.connections.map((c) => {
    const t = notes.get(c.target);
    return { ...c, title: t?.meta.title || c.target, exists: !!t };
  });
  return { slug, meta: e.meta, body: e.body, connections, backlinks: backlinksFor(slug) };
}

// ---------- lifecycle ----------

export function loadVault() {
  const d = dirs();
  for (const p of [d.notes, d.transcripts, d.exo]) fs.mkdirSync(p, { recursive: true });
  notes.clear();
  for (const f of fs.readdirSync(d.notes)) {
    if (!f.endsWith('.md')) continue;
    const e = readFile(path.join(d.notes, f));
    if (e) notes.set(e.slug, e);
  }
  migrateInvestFlag();
  console.log(`[vault] ${notes.size} notes in ${d.root}`);
  watch();
}

function watch() {
  watcher?.close();
  const d = dirs();
  watcher = chokidar.watch(d.notes, { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 250 } });
  const onChange = (file: string) => {
    if (!file.endsWith('.md')) return;
    const slug = path.basename(file, '.md');
    const w = recentWrites.get(slug);
    if (w && Date.now() - w < 2000) return; // our own write
    const e = readFile(file);
    if (e) {
      notes.set(slug, e);
      vaultEvents.emit('change', { slug, kind: 'external' });
    }
  };
  watcher.on('add', onChange).on('change', onChange);
  watcher.on('unlink', (file: string) => {
    const slug = path.basename(file, '.md');
    if (notes.delete(slug)) vaultEvents.emit('change', { slug, kind: 'delete' });
  });
}
