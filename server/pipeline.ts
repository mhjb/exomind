import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { getConfig } from './config.ts';
import { RateLimitError, fetchVideo, listPlaylist, youtubeId } from './youtube.ts';
import crypto from 'node:crypto';
import { NotAnArticle, articleFromPaste, fetchArticle, isVideoUrl, normaliseUrl, type ArticleData, type PastedArticle } from './article.ts';
import { budgetState, estimateSummaryCost } from './usage.ts';
import { findConnections, summarise, type Candidate, type SummaryResult } from './llm.ts';
import { relatedCandidates } from './search.ts';
import { articleMarkdown, fmtTime, parseTranscriptMarkdown, textFragmentLink, timeLink, transcriptMarkdown } from './transcript.ts';
import { allEntries, myTagSet, dirs, findById, getEntry, getSection, readTranscript, uniqueSlug, writeNote, writeTranscript } from './vault.ts';
import type { Connection, JobKind, NoteMeta, QueueItem } from '../shared/types.ts';
import { INVEST_TAG } from '../shared/types.ts';
import { parsePersonEntry, peopleList, personKey } from './names.ts';

export const pipelineEvents = new EventEmitter();

interface State {
  items: QueueItem[];
  seen: string[]; // video ids ever picked up from the playlist
  lastPoll?: string;
  lastPollError?: string;
}

let state: State = { items: [], seen: [] };
let working: QueueItem | null = null;
let polling = false;
let pollTimer: NodeJS.Timeout | null = null;
let nextPoll: Date | null = null;
let ytWaitUntil = 0; // YouTube rate-limited us: no fetches before this time
let lastYtFetch = 0;
let wakeTimer: NodeJS.Timeout | null = null;
const YT_GAP_MS = 20_000; // space out YouTube requests
const BACKOFF_MIN = [10, 20, 40, 80]; // minutes between automatic retries after a 429

/** Stops a job without marking it failed-for-good: it needs the user to approve the cost. */
class NeedsApproval extends Error {}

const stateFile = () => path.join(dirs().exo, 'state.json');

export function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = { items: [], seen: [] };
  }
  // Anything interrupted mid-flight goes back in the queue.
  for (const i of state.items) if (i.status === 'processing') i.status = 'queued';
  saveState();
}

function saveState() {
  // Keep the log bounded: all unfinished items plus the most recent 300 finished ones.
  const open = state.items.filter((i) => i.status === 'queued' || i.status === 'processing' || i.status === 'error');
  const closed = state.items.filter((i) => !open.includes(i)).slice(-300);
  state.items = [...closed, ...open].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  fs.mkdirSync(dirs().exo, { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  pipelineEvents.emit('queue');
}

export function queueSnapshot() {
  // Once the note exists, its own star is the one that counts (it may have been changed in the reader).
  return [...state.items].reverse().map((i) => {
    const e = i.slug ? getEntry(i.slug) : undefined;
    return e ? { ...i, starred: !!e.meta.starred, invest: !!e.meta.my_tags?.includes(INVEST_TAG) } : i;
  });
}

/** A note's own tags with "investment" added or taken away. */
function withInvest(meta: NoteMeta, on: boolean): NoteMeta {
  const rest = (meta.my_tags || []).filter((t) => t !== INVEST_TAG);
  const mine = on ? [...rest, INVEST_TAG] : rest;
  return { ...meta, my_tags: mine.length ? mine : undefined };
}

/**
 * Star or unstar a queue item, or tag it "investment" (the queue's investment button). If its note
 * already exists, that's changed too.
 */
export function starItem(id: string, on: boolean, flag: 'starred' | 'invest' = 'starred') {
  const i = state.items.find((x) => x.id === id);
  if (!i) throw new Error('That queue item is gone.');
  i[flag] = on || undefined;
  const e = i.slug ? getEntry(i.slug) : undefined;
  if (e && flag === 'starred' && !!e.meta.starred !== on) writeNote(i.slug!, { ...e.meta, starred: on || undefined }, e.body);
  if (e && flag === 'invest' && !!e.meta.my_tags?.includes(INVEST_TAG) !== on) writeNote(i.slug!, withInvest(e.meta, on), e.body);
  saveState();
}

/** Carry a star or the investment tag given in the queue onto a note that already existed (a duplicate, or a half-finished earlier attempt). */
function applyQueuedStar(item: QueueItem) {
  const e = (item.starred || item.invest) && item.slug ? getEntry(item.slug) : undefined;
  if (!e) return;
  let meta = e.meta;
  if (item.starred && !meta.starred) meta = { ...meta, starred: true };
  if (item.invest && !meta.my_tags?.includes(INVEST_TAG)) meta = withInvest(meta, true);
  if (meta !== e.meta) writeNote(item.slug!, meta, e.body);
}

export function pollInfo() {
  return {
    lastPoll: state.lastPoll,
    lastPollError: state.lastPollError,
    nextPoll: nextPoll?.toISOString(),
    polling,
    working: working ? `${working.title || working.id}: ${working.step || ''}` : undefined,
    youtubeWaitUntil: ytWaitUntil > Date.now() ? new Date(ytWaitUntil).toISOString() : undefined,
  };
}

// ---------------- queue ----------------

function enqueue(item: Omit<QueueItem, 'status' | 'queuedAt'>) {
  const existing = state.items.find((i) => i.id === item.id && (i.status === 'queued' || i.status === 'processing'));
  if (existing) return existing;
  const full: QueueItem = { ...item, status: 'queued', queuedAt: new Date().toISOString() };
  state.items = state.items.filter((i) => i.id !== item.id); // replace any old record for this id
  state.items.push(full);
  saveState();
  kick();
  return full;
}

export function addUrl(url: string) {
  const vid = youtubeId(url);
  // Videos are keyed by YouTube id; anything else (articles, other video sites) by its tidied URL.
  const id = vid || (isVideoUrl(url) ? url : normaliseUrl(url));
  const e = findById(id);
  if (e) return { exists: e.slug };
  const item = enqueue({ id, kind: 'ingest', url, source: 'manual', title: url });
  return { item };
}

export function addNoteJob(kind: Exclude<JobKind, 'ingest'>, slug: string) {
  const e = getEntry(slug);
  if (!e) throw new Error('No such note');
  return enqueue({ id: `${kind}:${slug}`, kind, slug, title: e.meta.title, source: 'app' });
}

export function retry(id: string, approve = false) {
  const i = state.items.find((x) => x.id === id);
  if (!i) return;
  i.status = 'queued';
  i.error = undefined;
  i.step = undefined;
  i.retryAt = undefined;
  i.attempts = 0;
  if (approve) i.approved = true;
  if (!approve && i.needsApproval) i.needsApproval = false;
  saveState();
  kick();
}

// Text pasted in for links that couldn't be fetched. Kept beside state.json rather than in it,
// so the queue file stays small; removed once the article is in the vault.
const pastedFile = (id: string) => path.join(dirs().exo, 'pasted', crypto.createHash('sha1').update(id).digest('hex') + '.json');

function readPasted(id: string): PastedArticle | null {
  try {
    return JSON.parse(fs.readFileSync(pastedFile(id), 'utf8'));
  } catch {
    return null;
  }
}

/** Use text the user pasted in place of fetching the page, then run the item again. */
export function pasteArticle(id: string, p: PastedArticle) {
  const i = state.items.find((x) => x.id === id);
  if (!i || i.kind !== 'ingest' || !i.url) throw new Error('That queue item is gone, or it isn’t a link.');
  if (i.status === 'processing') throw new Error('That item is being processed right now.');
  articleFromPaste(i.url, p); // check it now, so a bad paste is reported straight back to the form
  fs.mkdirSync(path.dirname(pastedFile(id)), { recursive: true });
  fs.writeFileSync(pastedFile(id), JSON.stringify(p));
  retry(id);
}

export function skip(id: string) {
  const i = state.items.find((x) => x.id === id);
  if (!i || i.status === 'processing') return;
  i.status = 'skipped';
  i.finishedAt = new Date().toISOString();
  saveState();
}

export function clearFinished() {
  state.items = state.items.filter((i) => i.status === 'queued' || i.status === 'processing' || i.status === 'error');
  saveState();
}

function setStep(item: QueueItem, step: string) {
  item.step = step;
  pipelineEvents.emit('queue');
}

function needsYoutube(i: QueueItem) {
  return i.kind === 'ingest' && isVideoUrl(i.url || '') && !findById(youtubeId(i.url || '') || i.id);
}

function scheduleWake(at: number) {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    kick();
  }, Math.max(1000, at - Date.now() + 500));
}

export function kick() {
  if (working || getConfig().paused) return;
  if (budgetState().over) {
    pipelineEvents.emit('queue');
    return; // monthly budget reached: wait until it's raised or the month turns over
  }
  const now = Date.now();
  let wakeAt = Infinity;
  const next = state.items.find((i) => {
    if (i.status !== 'queued') return false;
    const due = i.retryAt ? Date.parse(i.retryAt) : 0;
    if (due > now) {
      wakeAt = Math.min(wakeAt, due);
      return false;
    }
    if (ytWaitUntil > now && needsYoutube(i)) {
      wakeAt = Math.min(wakeAt, ytWaitUntil);
      return false;
    }
    return true;
  });
  if (!next) {
    if (wakeAt < Infinity) scheduleWake(wakeAt);
    return;
  }
  working = next;
  next.status = 'processing';
  next.error = undefined;
  saveState();
  runJob(next)
    .then(() => {
      next.status = 'done';
      next.step = undefined;
      next.retryAt = undefined;
    })
    .catch((e: Error) => {
      if (e instanceof RateLimitError) {
        const n = (next.attempts || 0) + 1;
        next.attempts = n;
        if (n <= BACKOFF_MIN.length) {
          const at = Date.now() + BACKOFF_MIN[n - 1] * 60_000;
          ytWaitUntil = Math.max(ytWaitUntil, at);
          next.status = 'queued';
          next.retryAt = new Date(at).toISOString();
          next.step = `YouTube is rate-limiting; retry ${n} of ${BACKOFF_MIN.length}`;
          console.warn(`[pipeline] ${next.id}: rate limited, retrying in ${BACKOFF_MIN[n - 1]} min`);
          return;
        }
      }
      if (e instanceof NeedsApproval) {
        next.status = 'error';
        next.needsApproval = true;
        next.error = e.message;
        return;
      }
      console.error(`[pipeline] ${next.id}:`, e.stack || e.message);
      next.status = 'error';
      next.error = e.message;
    })
    .finally(() => {
      next.finishedAt = new Date().toISOString();
      working = null;
      saveState();
      setImmediate(kick);
    });
}

async function runJob(item: QueueItem) {
  if (item.kind === 'ingest') return ingest(item);
  if (item.kind === 'resummarise') {
    await resummariseNote(item.slug!, (s) => setStep(item, s));
    setStep(item, 'Finding connections');
    return reconnectNote(item.slug!);
  }
  if (item.kind === 'reconnect') {
    setStep(item, 'Finding connections');
    return reconnectNote(item.slug!);
  }
}

// ---------------- maintenance ----------------

const JUNK_MARKUP = /<\/?(item|group|tags|summary|key_ideas|quotes|idea|explanation|quote|questions|people|works|gist|speaker|seconds)\b[^>]*>/;

/** Notes whose summary came out malformed (stray markup, or no tags), and aren't already queued. */
export function brokenNotes() {
  const busy = new Set(state.items.filter((i) => i.status === 'queued' || i.status === 'processing').map((i) => i.slug));
  return allEntries().filter(
    (e) => e.meta.transcript && !busy.has(e.slug) && e.meta.gist && (JUNK_MARKUP.test(e.body) || e.meta.tags.length === 0),
  );
}

export function brokenReport() {
  const model = getConfig().model;
  const notes = brokenNotes();
  const estimate = notes.reduce((sum, e) => sum + (estimateSummaryCost(model, readTranscript(e.meta, e.slug)?.length || 0) || 0), 0);
  return { notes: notes.map((e) => ({ slug: e.slug, title: e.meta.title })), estimate };
}

export function resummariseBroken() {
  const notes = brokenNotes();
  for (const e of notes) {
    const item = addNoteJob('resummarise', e.slug);
    item.approved = true;
  }
  saveState();
  return notes.length;
}

// ---------------- the pipeline proper ----------------

async function ingest(item: QueueItem) {
  const known = youtubeId(item.url || '') || item.id;
  const already = findById(known);
  if (already) {
    // A previous attempt got as far as writing the note; finish the job from there.
    item.slug = already.slug;
    applyQueuedStar(item);
    if (!already.meta.gist) {
      const md = readTranscript(already.meta, already.slug);
      checkCost(item, md ? md.length : 0);
      await resummariseNote(already.slug, (s) => setStep(item, s));
    }
    setStep(item, 'Finding connections');
    return reconnectNote(already.slug);
  }

  // Not a known video site: try reading it as an article first, falling back to yt-dlp for
  // pages that turn out to be videos (or have too little text to be an article).
  const pasted = readPasted(item.id);
  if (pasted) {
    setStep(item, 'Reading pasted text');
    await ingestArticle(item, articleFromPaste(item.url!, pasted));
    fs.rmSync(pastedFile(item.id), { force: true });
    return;
  }

  let notArticle: NotAnArticle | null = null;
  if (!isVideoUrl(item.url!)) {
    setStep(item, 'Fetching article');
    try {
      return await ingestArticle(item, await fetchArticle(item.url!, (step) => setStep(item, step)));
    } catch (e) {
      if (!(e instanceof NotAnArticle)) throw e;
      notArticle = e;
      setStep(item, 'Not an article; trying it as a video');
    }
  }

  const gap = lastYtFetch + YT_GAP_MS - Date.now();
  if (gap > 0) {
    setStep(item, 'Pausing between YouTube requests');
    await new Promise((r) => setTimeout(r, gap));
  }
  setStep(item, 'Fetching metadata & captions');
  lastYtFetch = Date.now();
  let v;
  try {
    v = await fetchVideo(item.url!);
  } catch (e) {
    if (notArticle) throw new Error(`${notArticle.message} It isn't a video yt-dlp can read either.`);
    throw e;
  }
  item.title = v.title;
  const dup = findById(v.id);
  if (dup) {
    item.slug = dup.slug;
    applyQueuedStar(item);
    item.step = 'Already in the vault';
    return;
  }

  const slug = uniqueSlug(v.title, v.id);
  item.slug = slug;
  const transcriptRel = writeTranscript(slug, transcriptMarkdown(v.title, v.url, v.transcript, v.transcriptSource));
  const meta: NoteMeta = {
    id: v.id,
    type: v.youtube ? 'youtube' : 'video',
    title: v.title,
    url: v.url,
    channel: v.channel,
    channel_url: v.channel_url,
    published: v.published,
    added: new Date().toISOString(),
    duration: v.duration,
    thumbnail: v.thumbnail,
    tags: [],
    transcript: transcriptRel,
    transcript_source: v.transcriptSource,
    starred: item.starred || undefined,
    my_tags: item.invest ? [INVEST_TAG] : undefined,
    connections: [],
  };
  // Write a stub straight away so the note exists even if summarising fails.
  writeNote(slug, meta, `# ${v.title}\n\n_Summary pending._\n\n## My notes\n\n`);

  checkCost(item, v.transcript.reduce((n, p) => n + p.text.length + 8, 0));

  setStep(item, v.transcript.length ? 'Summarising' : 'Summarising (no captions found)');
  const s = await summarise(
    { title: v.title, channel: v.channel, published: v.published, duration: v.duration, description: v.description, chapters: v.chapters },
    v.transcript,
    topTags(),
    { slug },
  );
  applySummary(slug, meta, s, '');

  setStep(item, 'Finding connections');
  await reconnectNote(slug);
}

async function ingestArticle(item: QueueItem, a: ArticleData) {
  item.title = a.title;
  const dup = findById(a.id);
  if (dup) {
    item.slug = dup.slug;
    applyQueuedStar(item);
    item.step = 'Already in the vault';
    return;
  }
  const slug = uniqueSlug(a.title, a.site);
  item.slug = slug;
  const transcriptRel = writeTranscript(slug, articleMarkdown(a.title, a.url, a.paragraphs));
  const meta: NoteMeta = {
    id: a.id,
    type: 'article',
    title: a.title,
    url: a.url,
    channel: a.site,
    channel_url: a.siteUrl,
    author: a.author,
    published: a.published,
    added: new Date().toISOString(),
    words: a.words,
    thumbnail: a.thumbnail,
    tags: [],
    transcript: transcriptRel,
    transcript_source: 'article',
    archived: a.archived?.url,
    archived_date: a.archived?.date,
    pasted: a.pasted || undefined,
    starred: item.starred || undefined,
    my_tags: item.invest ? [INVEST_TAG] : undefined,
    connections: [],
  };
  writeNote(slug, meta, `# ${a.title}\n\n_Summary pending._\n\n## My notes\n\n`);

  checkCost(item, a.paragraphs.reduce((n, p) => n + p.length + 8, 0));

  setStep(item, 'Summarising');
  const s = await summarise(
    { title: a.title, channel: a.site, author: a.author, published: a.published, description: a.description, kind: 'article', words: a.words },
    a.paragraphs.map((text, i) => ({ t: i + 1, text })),
    topTags(),
    { slug },
  );
  applySummary(slug, meta, s, '');

  setStep(item, 'Finding connections');
  await reconnectNote(slug);
}

/** Per-item cost guard: very long sources wait for the user's OK. */
function checkCost(item: QueueItem, transcriptChars: number) {
  const cfg = getConfig();
  const est = estimateSummaryCost(cfg.model, transcriptChars);
  if (est != null) item.estimate = Math.round(est * 10000) / 10000;
  if (item.approved || !cfg.maxCostPerItemUsd || est == null || est <= cfg.maxCostPerItemUsd) return;
  throw new NeedsApproval(
    `Estimated cost US$${est.toFixed(2)} is above your per-item limit of US$${cfg.maxCostPerItemUsd.toFixed(2)}. The transcript is saved; approve to summarise it anyway.`,
  );
}

function topTags(limit = 150) {
  const counts = new Map<string, number>();
  const yours = myTagSet(); // never offer the model your own tags
  for (const e of allEntries()) for (const t of e.meta.tags) if (!yours.has(t)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

function normTag(t: string) {
  return t.toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function applySummary(slug: string, meta: NoteMeta, s: SummaryResult, myNotes: string) {
  // Your own tags ("inspiring", "investment") are yours alone: the model's suggestions of them are dropped.
  const yours = myTagSet();
  const tags = [...new Set([...meta.tags, ...s.tags.map(normTag)].filter((t) => t && !yours.has(t)))];
  // The star and your tags may have been changed (in the queue or the reader) while the summary was being written.
  const current = getEntry(slug)?.meta;
  const starred = current ? current.starred : meta.starred;
  const my_tags = current ? current.my_tags : meta.my_tags;
  const next: NoteMeta = { ...meta, starred, my_tags, gist: s.gist, tags, people: s.people, speakers: s.speakers.length ? s.speakers : undefined, works: s.works, model: getConfig().model };
  writeNote(slug, next, buildBody(next, s, myNotes));
}

export function buildBody(meta: NoteMeta, s: SummaryResult, myNotes: string) {
  const out: string[] = [`# ${meta.title}`, '', `> ${s.gist}`, '', '## Summary', '', ...s.summary.map((b) => `- ${b}`)];
  if (s.key_ideas.length) {
    out.push('', '## Key ideas', '');
    for (const k of s.key_ideas) out.push(`- **${k.idea}** — ${k.explanation}`);
  }
  const article = meta.type === 'article';
  if (s.quotes.length) {
    out.push('', '## Quotes', '');
    for (const q of s.quotes) {
      const pos = article ? `¶${q.seconds}` : fmtTime(q.seconds);
      const target = article ? textFragmentLink(meta.url, q.text) : timeLink(meta.url, q.seconds);
      const link = meta.url ? `[${pos}](${target})` : pos;
      out.push(`> “${q.text.replace(/^["“]|["”]$/g, '')}”  \n> — ${q.speaker ? `${q.speaker}, ` : ''}${link}`, '');
    }
    if (out[out.length - 1] === '') out.pop();
  }
  if (s.people.length || s.works.length) {
    out.push('', '## People & works', '');
    const speaking = new Set(s.speakers.map(personKey));
    const mentioned = s.people.filter((p) => !speaking.has(personKey(p)));
    if (s.speakers.length) {
      out.push(`- **${article ? 'Author' : 'Speaking'}:** ${s.speakers.join(', ')}`);
      if (mentioned.length) out.push(`- **Mentioned:** ${mentioned.join(', ')}`);
    } else if (s.people.length) out.push(`- **People:** ${s.people.join(', ')}`);
    if (s.works.length) out.push(`- **Works:** ${s.works.join('; ')}`);
  }
  if (s.questions.length) {
    out.push('', '## Questions', '');
    for (const q of s.questions) out.push(`- ${q}`);
  }
  out.push('', '## My notes', '', myNotes.trim(), '');
  return out.join('\n');
}

async function resummariseNote(slug: string, step: (s: string) => void) {
  const e = getEntry(slug);
  if (!e) throw new Error('Note no longer exists');
  const md = readTranscript(e.meta, slug);
  const paras = md ? parseTranscriptMarkdown(md) : [];
  step('Summarising');
  const s = await summarise(
    {
      title: e.meta.title,
      channel: e.meta.channel,
      published: e.meta.published,
      duration: e.meta.duration,
      kind: e.meta.type === 'article' ? 'article' : 'video',
      author: e.meta.author,
      words: e.meta.words,
    },
    paras,
    topTags(),
    { slug },
  );
  const fresh = getEntry(slug)!; // re-read in case it was edited meanwhile
  applySummary(slug, fresh.meta, s, getSection(fresh.body, 'My notes') || '');
}

/** "People: A, B, C" from a stored people list, without role notes; empty if there's nobody. */
function namesLine(people: unknown, max: number) {
  const names = peopleList(people).map((p) => parsePersonEntry(p).name).filter(Boolean);
  return names.length ? `People: ${names.slice(0, max).join(', ')}` : '';
}

export async function reconnectNote(slug: string) {
  const e = getEntry(slug);
  if (!e) throw new Error('Note no longer exists');
  const others = allEntries().filter((o) => o.slug !== slug && o.meta.gist);
  if (!others.length) return;
  const noteText = [
    e.meta.gist,
    `Tags: ${e.meta.tags.join(', ')}`,
    // People matter for links too: a person added by hand (say, a company's founder) can be the connection.
    namesLine(e.meta.people, 40),
    getSection(e.body, 'Summary'),
    getSection(e.body, 'Key ideas'),
    getSection(e.body, 'My notes'),
  ]
    .filter(Boolean)
    .join('\n');
  // Small vault: let the model see everything. Larger: keyword shortlist first.
  const slugs = others.length <= 40 ? others.map((o) => o.slug) : relatedCandidates(`${e.meta.title} ${noteText}`, slug, 30);
  const candidates: Candidate[] = slugs
    .map((s) => getEntry(s)!)
    .filter(Boolean)
    .map((o) => ({
      slug: o.slug,
      title: o.meta.title,
      channel: o.meta.channel,
      gist: o.meta.gist,
      tags: o.meta.tags,
      ideas: (getSection(o.body, 'Key ideas') || '').replace(/\s+/g, ' ').slice(0, 700),
      people: namesLine(o.meta.people, 15).replace(/^People: /, ''),
    }));
  const found = await findConnections({ title: e.meta.title, text: noteText }, candidates, { slug });
  const fresh = getEntry(slug)!;
  const manual = fresh.meta.connections.filter((c) => c.manual);
  const auto: Connection[] = found
    .filter((c) => !manual.some((m) => m.target === c.slug))
    .map((c) => ({ target: c.slug, reason: c.reason, strength: c.strength }));
  writeNote(slug, { ...fresh.meta, connections: [...manual, ...auto] }, fresh.body);
}

// ---------------- polling ----------------

export async function pollNow() {
  const cfg = getConfig();
  if (!cfg.playlistUrl || polling) return;
  polling = true;
  pipelineEvents.emit('queue');
  try {
    const { entries } = await listPlaylist(cfg.playlistUrl);
    const seen = new Set(state.seen);
    let added = 0;
    for (const en of entries) {
      if (seen.has(en.id)) continue;
      state.seen.push(en.id);
      if (findById(en.id)) continue;
      enqueue({ id: en.id, kind: 'ingest', url: en.url, title: en.title, source: 'playlist' });
      added++;
    }
    state.lastPollError = undefined;
    console.log(`[poll] ${entries.length} in playlist, ${added} new`);
  } catch (e) {
    state.lastPollError = (e as Error).message;
    console.error('[poll] failed:', state.lastPollError);
  } finally {
    polling = false;
    state.lastPoll = new Date().toISOString();
    saveState();
  }
}

export function restartPoller() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  nextPoll = null;
  const cfg = getConfig();
  if (!cfg.autoPoll || !cfg.playlistUrl) {
    pipelineEvents.emit('queue');
    return;
  }
  const schedule = (ms: number) => {
    nextPoll = new Date(Date.now() + ms);
    pollTimer = setTimeout(async () => {
      await pollNow();
      schedule(getConfig().pollMinutes * 60_000);
    }, ms);
  };
  schedule(3_000); // poll shortly after start-up, then on the interval
  pipelineEvents.emit('queue');
}
