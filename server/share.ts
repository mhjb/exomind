/**
 * Sharing a single note as a public, read-only page.
 *
 * A snapshot of the note, holding only what was chosen in the Share panel, is written to a
 * Cloudflare KV namespace under a random id. The Pages site in cloudflare/ serves it at
 * <shareBaseUrl>/s/<id>. Nothing else in the vault ever leaves this machine. A shared page
 * doesn't follow later edits: publishing again updates it, at the same address.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.ts';
import { fullNote, getEntry, getSection, readTranscript } from './vault.ts';
import { noteSpeakers, peopleGraph } from './people.ts';
import { peopleDates } from './lifespans.ts';
import { parseTranscriptMarkdown } from './transcript.ts';
import { DEFAULT_SHARE_OPTIONS, SHARE_INDEX_KEY, type PeopleGraph, type ShareIndexEntry, type ShareOptions, type ShareRecord, type ShareSnapshot } from '../shared/types.ts';

const FILE = path.join(DATA_DIR, 'shares.json');

function readAll(): Record<string, ShareRecord> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeAll(all: Record<string, ShareRecord>) {
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export function shareConfigured() {
  const c = getConfig();
  return !!(c.cloudflareAccountId && c.cloudflareKvNamespaceId && c.cloudflareApiToken && c.shareBaseUrl);
}

export function getShare(slug: string): ShareRecord | null {
  return readAll()[slug] || null;
}

function cleanOptions(o: Partial<ShareOptions>): ShareOptions {
  const out = { ...DEFAULT_SHARE_OPTIONS };
  for (const k of Object.keys(out) as (keyof ShareOptions)[]) if (typeof o[k] === 'boolean') out[k] = o[k]!;
  return out;
}

/** Remove one `## Heading` section (up to the next `## `). */
function dropSection(body: string, heading: string) {
  const re = new RegExp(`^## ${heading}\\s*$`, 'm');
  const m = re.exec(body);
  if (!m) return body;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/\n## /);
  return (body.slice(0, m.index) + (next >= 0 ? rest.slice(next + 1) : '')).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function buildSnapshot(slug: string, opts: ShareOptions, id: string, sharedAt: string): ShareSnapshot {
  const note = fullNote(slug);
  if (!note) throw new Error('That note is gone.');
  const m = note.meta;
  const title = (s: string) => getEntry(s)?.meta.title || s;

  let body = note.body.replace(/^# .*\n+/, '');
  // The "My notes" section is yours; an empty one is just clutter.
  if (!opts.myNotes || !getSection(body, 'My notes')) body = dropSection(body, 'My notes');
  // Links to other notes can't be followed on a shared page: keep their words, drop the link.
  body = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_x, s: string, label?: string) => (label || title(s.trim())).trim());

  const snap: ShareSnapshot = {
    v: 1,
    id,
    sharedAt,
    options: opts,
    meta: {
      type: m.type,
      title: m.title,
      url: m.url,
      channel: m.channel,
      channel_url: m.channel_url,
      author: m.author,
      published: m.published,
      duration: m.duration,
      words: m.words,
      thumbnail: m.thumbnail,
      transcript_source: m.transcript_source,
      people: m.people,
    },
    speakers: noteSpeakers(m, note.body),
    body,
  };
  if (opts.tags) snap.tags = m.tags;
  if (opts.works && m.works?.length) snap.works = m.works;

  if (opts.otherNotes) {
    const seen = new Set<string>();
    snap.connections = [
      ...note.connections.filter((c) => c.exists).map((c) => ({ slug: c.target, title: c.title, reason: c.reason, strength: c.strength })),
      ...note.backlinks.map((b) => ({ slug: b.slug, title: b.title, reason: b.reason, strength: b.strength })),
    ]
      .filter((c) => !seen.has(c.slug) && seen.add(c.slug))
      .map(({ title, reason, strength }) => ({ title, reason, strength }));
  }

  if (opts.peopleGraph) {
    // Only the people in this note, and (if chosen) the titles of the other notes they come up in.
    const g = peopleGraph();
    const keep = (s: string) => s === slug || opts.otherNotes;
    const inNote = g.people.filter((p) => p.appears.includes(slug) || p.mentioned.includes(slug));
    const ids = new Set(inNote.map((p) => p.id));
    const people = inNote.map((p) => ({ id: p.id, name: p.name, appears: p.appears.filter(keep), mentioned: p.mentioned.filter(keep) }));
    const referenced = new Set(people.flatMap((p) => [...p.appears, ...p.mentioned]));
    const library: PeopleGraph = {
      notes: g.notes.filter((n) => referenced.has(n.id)).map((n) => ({ id: n.id, title: n.id === slug ? m.title : n.title })),
      people,
      aliasOf: Object.fromEntries(Object.entries(g.aliasOf || {}).filter(([, to]) => ids.has(to))),
    };
    // Slugs of other notes would hint at their titles; replace them with neutral ids.
    if (opts.otherNotes) {
      const alias = new Map([...referenced].map((s, i) => [s, s === slug ? 'this' : `n${i}`]));
      library.notes = library.notes.map((n) => ({ ...n, id: alias.get(n.id)! }));
      library.people = library.people.map((p) => ({ ...p, appears: p.appears.map((s) => alias.get(s)!), mentioned: p.mentioned.map((s) => alias.get(s)!) }));
    } else {
      library.notes = library.notes.map((n) => ({ ...n, id: 'this' }));
      library.people = library.people.map((p) => ({ ...p, appears: p.appears.map(() => 'this'), mentioned: p.mentioned.map(() => 'this') }));
    }
    snap.library = library;
    const all = peopleDates().dates;
    snap.dates = Object.fromEntries(Object.entries(all).filter(([k]) => ids.has(k)));
  }

  if (opts.transcript) {
    const md = readTranscript(m, slug);
    if (md) snap.transcript = parseTranscriptMarkdown(md);
  }
  return snap;
}

async function kv(method: 'PUT' | 'DELETE', id: string, body?: string) {
  const c = getConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.cloudflareAccountId)}/storage/kv/namespaces/${encodeURIComponent(c.cloudflareKvNamespaceId)}/values/${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${c.cloudflareApiToken}`, ...(body ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}) },
    body,
  });
  const data = (await r.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[] };
  if (!r.ok || data.success === false) {
    if (method === 'DELETE' && r.status === 404) return;
    throw new Error(`Cloudflare: ${data.errors?.map((e) => e.message).join('; ') || r.statusText}`);
  }
}

/** The public list of everything shared, rebuilt from this machine's records (the source of truth). */
function buildIndex(all: Record<string, ShareRecord>): ShareIndexEntry[] {
  return Object.entries(all)
    .map(([slug, r]): ShareIndexEntry | null => {
      const e = getEntry(slug);
      if (!e) return null;
      const m = e.meta;
      return {
        id: r.id,
        title: m.title,
        type: m.type,
        channel: m.channel,
        speakers: noteSpeakers(m, e.body),
        thumbnail: m.thumbnail,
        published: m.published,
        duration: m.duration,
        gist: m.gist,
        sharedAt: r.sharedAt,
      };
    })
    .filter((x): x is ShareIndexEntry => !!x)
    .sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
}

async function writeIndex(all: Record<string, ShareRecord>) {
  await kv('PUT', SHARE_INDEX_KEY, JSON.stringify(buildIndex(all)));
}

export async function publishShare(slug: string, options: Partial<ShareOptions>): Promise<ShareRecord> {
  if (!shareConfigured()) throw new Error('Sharing isn’t set up yet. Add the Cloudflare details in Settings.');
  const all = readAll();
  const id = all[slug]?.id || crypto.randomBytes(9).toString('base64url');
  const opts = cleanOptions(options);
  const sharedAt = new Date().toISOString();
  const snap = buildSnapshot(slug, opts, id, sharedAt);
  await kv('PUT', id, JSON.stringify(snap));
  const rec: ShareRecord = { id, url: `${getConfig().shareBaseUrl.replace(/\/+$/, '')}/s/${id}`, options: opts, sharedAt };
  all[slug] = rec;
  writeAll(all);
  await writeIndex(all);
  return rec;
}

export async function unpublishShare(slug: string) {
  const all = readAll();
  const rec = all[slug];
  if (!rec) return;
  if (shareConfigured()) await kv('DELETE', rec.id);
  delete all[slug];
  writeAll(all);
  if (shareConfigured()) await writeIndex(all);
}
