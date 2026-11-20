import fs from 'node:fs';
import path from 'node:path';
import { allEntries, allTags, dirs, vaultEvents } from './vault.ts';
import { parseTranscriptMarkdown } from './transcript.ts';
import type { SearchHit, TranscriptSegment } from '../shared/types.ts';

// A small BM25 index over notes and transcripts. Rebuilt lazily whenever the vault changes.
// Good enough for thousands of notes; swap for embeddings later if keyword recall proves too literal.

const STOP = new Set(
  'a an and are as at be but by for from has have he her his i if in into is it its of on or our she so that the their them then there these they this to was we were what when which who will with you your not no do does did can could would should just about than more most also very really like one two get got going know think yeah okay um uh'.split(
    ' ',
  ),
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9À-ɏ]+/g) || [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

interface Doc {
  slug: string;
  kind: 'note' | 'transcript';
  tf: Map<string, number>;
  len: number;
  text: string;
  paras?: TranscriptSegment[];
}

let docs: Doc[] = [];
let df = new Map<string, number>();
let avgLen = { note: 1, transcript: 1 };
let dirty = true;
const transcriptCache = new Map<string, { mtime: number; paras: TranscriptSegment[] }>();

vaultEvents.on('change', () => (dirty = true));

function makeDoc(slug: string, kind: Doc['kind'], weighted: string[], text: string, paras?: TranscriptSegment[]): Doc {
  const tf = new Map<string, number>();
  let len = 0;
  for (const w of weighted.flatMap((s) => tokenize(s))) {
    tf.set(w, (tf.get(w) || 0) + 1);
    len++;
  }
  return { slug, kind, tf, len, text, paras };
}

function loadTranscript(slug: string, rel?: string): TranscriptSegment[] {
  const file = path.join(dirs().root, rel || `transcripts/${slug}.md`);
  if (!fs.existsSync(file)) return [];
  const mtime = fs.statSync(file).mtimeMs;
  const c = transcriptCache.get(slug);
  if (c && c.mtime === mtime) return c.paras;
  const paras = parseTranscriptMarkdown(fs.readFileSync(file, 'utf8'));
  transcriptCache.set(slug, { mtime, paras });
  return paras;
}

function rebuild() {
  docs = [];
  for (const e of allEntries()) {
    const m = e.meta;
    const tagText = allTags(m).join(' ');
    docs.push(
      makeDoc(
        e.slug,
        'note',
        // Repetition = field weighting: titles and tags count more than body text.
        [m.title, m.title, m.title, tagText, tagText, m.gist || '', (m.people || []).join(' '), (m.works || []).join(' '), e.body],
        `${m.gist || ''}\n${e.body.replace(/^# .*\n+/, '').replace(/^> .*\n+/, '')}`,
      ),
    );
    const paras = loadTranscript(e.slug, m.transcript);
    if (paras.length) {
      const text = paras.map((p) => p.text).join(' ');
      docs.push(makeDoc(e.slug, 'transcript', [text], text, paras));
    }
  }
  df = new Map();
  const tot = { note: 0, transcript: 0 };
  const cnt = { note: 0, transcript: 0 };
  for (const d of docs) {
    tot[d.kind] += d.len;
    cnt[d.kind]++;
    for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  avgLen = { note: tot.note / (cnt.note || 1) || 1, transcript: tot.transcript / (cnt.transcript || 1) || 1 };
  dirty = false;
}

function bm25(d: Doc, terms: string[]) {
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  let s = 0;
  for (const t of terms) {
    const f = d.tf.get(t);
    if (!f) continue;
    const n = df.get(t) || 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / avgLen[d.kind]));
  }
  return s;
}

function snippet(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.search(new RegExp(`\\b${t.replace(/[^a-z0-9]/g, '')}`));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 180).replace(/\s+/g, ' ');
  const start = Math.max(0, at - 80);
  return (start > 0 ? '…' : '') + text.slice(start, start + 220).replace(/\s+/g, ' ').replace(/[#*>_`]/g, '') + '…';
}

export function search(q: string, limit = 40): SearchHit[] {
  if (dirty) rebuild();
  const terms = [...new Set(tokenize(q))];
  if (!terms.length) return [];
  const bySlug = new Map<string, SearchHit>();
  const titles = new Map(allEntries().map((e) => [e.slug, e.meta]));
  for (const d of docs) {
    let score = bm25(d, terms);
    if (score <= 0) continue;
    if (d.kind === 'transcript') score *= 0.6;
    const prev = bySlug.get(d.slug);
    if (prev && prev.score >= score) {
      prev.score += score * 0.2;
      continue;
    }
    const m = titles.get(d.slug)!;
    let hit: SearchHit = { slug: d.slug, title: m.title, channel: m.channel, score: score + (prev ? prev.score * 0.2 : 0), snippet: '', where: d.kind };
    if (m.type === 'article') hit.article = true;
    if (d.kind === 'transcript' && d.paras) {
      const para = d.paras.find((p) => terms.some((t) => tokenize(p.text).includes(t))) || d.paras[0];
      hit = { ...hit, snippet: snippet(para.text, terms), t: para.t };
    } else {
      hit.snippet = snippet(d.text, terms);
    }
    bySlug.set(d.slug, hit);
  }
  return [...bySlug.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Candidate notes related to some text — the shortlist the model then judges for real connections. */
export function relatedCandidates(text: string, exclude: string, k = 25): string[] {
  if (dirty) rebuild();
  const tf = new Map<string, number>();
  for (const w of tokenize(text)) tf.set(w, (tf.get(w) || 0) + 1);
  // Use the most distinctive terms of the source text as the query.
  const N = docs.length || 1;
  const terms = [...tf.entries()]
    .map(([w, f]) => [w, f * Math.log(1 + N / ((df.get(w) || 0) + 1))] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([w]) => w);
  const scores = new Map<string, number>();
  for (const d of docs) {
    if (d.slug === exclude) continue;
    const s = bm25(d, terms) * (d.kind === 'transcript' ? 0.4 : 1);
    if (s > 0) scores.set(d.slug, (scores.get(d.slug) || 0) + s);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([s]) => s);
}
