import { getConfig } from './config.ts';
import { complete, type CallCtx } from './models.ts';
import { fmtTime, transcriptForModel } from './transcript.ts';
import type { TranscriptSegment } from '../shared/types.ts';
import { parsePersonEntry, peopleList, personKey } from './names.ts';

export interface SummaryResult {
  gist: string;
  summary: string[];
  key_ideas: { idea: string; explanation: string }[];
  quotes: { text: string; seconds: number; speaker?: string }[];
  people: string[];
  speakers: string[]; // the people who speak in the source (a subset of people)
  works: string[];
  tags: string[];
  questions: string[];
}

export interface SourceInfo {
  title: string;
  channel?: string;
  published?: string;
  duration?: number;
  description?: string;
  chapters?: { start_time: number; title: string }[];
  kind?: 'video' | 'article';
  author?: string;
  words?: number;
}

export type { CallCtx } from './models.ts';

// ---------------- summarising ----------------

function summarySystem(existingTags: string[], article = false) {
  const about = getConfig().aboutMe.trim();
  return [
    article
      ? 'You distil articles and essays into notes for a personal knowledge base.'
      : 'You distil talks, interviews and podcasts into notes for a personal knowledge base.',
    article
      ? 'Be faithful to the source: represent the author\'s views accurately, distinguish them from views the author reports or argues against, attribute claims to whoever makes them, and do not add outside facts or opinions.'
      : 'Be faithful to the source: represent the speakers\' views accurately, attribute claims to whoever makes them, and do not add outside facts or opinions.',
    article
      ? 'The text was extracted automatically from a web page and may include stray captions, sign-up prompts or navigation; ignore anything that is not part of the article.'
      : 'Auto-generated captions mis-hear names and technical terms; silently correct obvious errors using the title, description and context.',
    'Write in clear, plain prose, using British/NZ spelling.',
    about ? `About the reader (use only to judge what is worth noticing, never to slant the content): ${about}` : '',
    existingTags.length ? `Tags already used in the vault: ${existingTags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function sourceHeader(s: SourceInfo) {
  const lines = [`Title: ${s.title}`];
  if (s.kind === 'article') {
    if (s.author) lines.push(`Author: ${s.author}`);
    if (s.channel) lines.push(`Publication: ${s.channel}`);
  } else if (s.channel) lines.push(`Channel: ${s.channel}`);
  if (s.published) lines.push(`Published: ${s.published}`);
  if (s.duration) lines.push(`Length: ${fmtTime(s.duration)}`);
  if (s.words) lines.push(`Length: ${s.words} words`);
  if (s.chapters?.length) lines.push(`Chapters:\n${s.chapters.map((c) => `  [${fmtTime(c.start_time)}] ${c.title}`).join('\n')}`);
  if (s.description) lines.push(`Description:\n${s.description.slice(0, 4000)}`);
  return lines.join('\n');
}

const CHUNK_CHARS = 400_000; // ~100k tokens: single pass below this

export async function summarise(src: SourceInfo, paras: TranscriptSegment[], existingTags: string[], ctx: CallCtx = {}): Promise<SummaryResult> {
  const article = src.kind === 'article';
  const system = summarySystem(existingTags, article);
  const marker = article ? '[¶n]' : '[m:ss]';
  const textName = article ? 'article' : 'transcript';
  let transcript = transcriptForModel(paras, article);

  if (transcript.length > CHUNK_CHARS) {
    // Very long source: take detailed notes on each chunk, then summarise the notes.
    const chunks: string[] = [];
    for (let i = 0; i < transcript.length; i += CHUNK_CHARS) chunks.push(transcript.slice(i, i + CHUNK_CHARS));
    const notes: string[] = [];
    for (const [i, c] of chunks.entries()) {
      const r = await complete({
        model: getConfig().model,
        maxTokens: 6000,
        system,
        user: `${sourceHeader(src)}\n\nThis is part ${i + 1} of ${chunks.length} of the ${textName}. Take detailed notes: the claims and arguments in order, with ${marker} markers, plus any verbatim quotable lines with their markers.\n\n<${textName}_part>\n${c}\n</${textName}_part>`,
        kind: 'summary-part',
        ctx,
      });
      notes.push(r.text);
    }
    transcript = notes.map((n, i) => `--- Notes on part ${i + 1} ---\n${n}`).join('\n\n');
  }

  const body = paras.length
    ? `<${textName}>\n${transcript}\n</${textName}>`
    : '(No transcript was available. Work from the title, description and chapters only, keep the summary short, and leave quotes empty.)';

  const res = await complete({
    model: getConfig().model,
    maxTokens: 12000,
    system,
    user: `${sourceHeader(src)}\n\n${body}\n\n${article ? ARTICLE_FORMAT : NOTE_FORMAT}`,
    kind: 'summary',
    ctx,
  });
  const text = res.text;
  if (res.truncated) console.warn('[llm] summary was cut off at the length limit; parsing what arrived');
  const out = parseNoteMarkdown(text);
  if (!out.gist && !out.summary.length) {
    console.error('[llm] unusable summary output:', text.slice(0, 2000));
    throw new Error('The model returned an empty summary — try Retry');
  }
  return out;
}

// The summary is requested as plain Markdown in fixed sections. Models write this far more reliably
// than long structured tool calls, which leaked "<item>" and "<parameter>" markup into the fields.
const NOTE_FORMAT = `Write the note as plain Markdown using exactly these headings, in this order, with nothing before the first heading or after the last section. No XML, HTML or code fences.

## Gist
One or two sentences: the core of what this source argues or offers.

## Summary
- 6–14 substantive bullets in the order the material unfolds. State the actual claims, arguments and examples, never "the speaker discusses X".

## Key ideas
- **Short name of the idea** — 1–3 sentences explaining it. (3–6 of the most important or original ideas.)

## Quotes
- "Verbatim line from the transcript" — Speaker name [m:ss]
(2–5 memorable lines, using the nearest [m:ss] marker. Write "None" if there is no transcript.)

## People
- Full name of each person featured or substantively discussed, spelling corrected. Mark everyone who speaks in the source itself (host, guest, lecturer, panellist) by adding " (speaks)", e.g. "Jane Smith (speaks)". List them first.

## Works
- Books, papers, films, projects or organisations substantively referenced, e.g. "Title (Author)".

## Tags
3–8 topical tags, lowercase-hyphenated, comma-separated on one line. Reuse existing vault tags where they fit.

## Questions
- 2–4 open questions this raises, worth further thought.`;

// The same note shape for articles: paragraph markers instead of timestamps, authors instead of speakers.
const ARTICLE_FORMAT = NOTE_FORMAT.replace(
  /## Gist\n[\s\S]*$/,
  `## Gist
One or two sentences: the core of what this article argues or offers.

## Summary
- 6–14 substantive bullets in the order the argument unfolds. State the actual claims, arguments and examples, never "the author discusses X".

## Key ideas
- **Short name of the idea** — 1–3 sentences explaining it. (3–6 of the most important or original ideas.)

## Quotes
- "Verbatim sentence from the article" — Author name [¶n]
(2–5 memorable lines, copied exactly, with the [¶n] marker of the paragraph they come from. Attribute a line to the person who said or wrote it, which may be someone the author quotes.)

## People
- Full name of each person featured or substantively discussed. Mark the article's author(s) by adding " (writes)", e.g. "Jane Smith (writes)", and list them first.

## Works
- Books, papers, films, projects or organisations substantively referenced, e.g. "Title (Author)".

## Tags
3–8 topical tags, lowercase-hyphenated, comma-separated on one line. Reuse existing vault tags where they fit.

## Questions
- 2–4 open questions this raises, worth further thought.`,
);

const MARKUP = /<\/?(?:item|group|parameter|invoke|function_calls|antml:[a-z_]+|idea|explanation|quote|speaker|seconds|tags|summary|key_ideas|quotes|people|works|questions|gist)\b[^>]*>/gi;

function bulletLines(section: string): string[] {
  const out: string[] = [];
  for (const raw of section.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) out.push(m[1].trim());
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ' ' + line.trim();
    else out.push(line.trim());
  }
  return out.map((l) => l.replace(MARKUP, '').trim()).filter((l) => l && !/^none\.?$/i.test(l) && !/^\(.*\)$/.test(l));
}

export function parseNoteMarkdown(text: string): SummaryResult {
  const clean = text.replace(/```[a-z]*\n?/gi, '');
  const sections = new Map<string, string>();
  const re = /^#{1,3}\s*(.+?)\s*$/gm;
  const heads: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) heads.push({ name: m[1].toLowerCase().replace(/[^a-z ]/g, '').trim(), start: m.index, end: m.index + m[0].length });
  heads.forEach((h, i) => sections.set(h.name, clean.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : undefined).trim()));
  const get = (...names: string[]) => {
    for (const n of names) for (const [k, v] of sections) if (k.startsWith(n)) return v;
    return '';
  };

  const quotes = bulletLines(get('quotes', 'quote'))
    .map((l) => {
      const q = l.match(/^[>"“']*\s*["“]?(.+?)["”]?\s*(?:[—–-]+\s*(.*?))?\s*[\[(](¶\s*\d+|\d{1,2}(?::\d{2}){1,2})[\])]\s*$/);
      if (!q) return { text: l.replace(/^["“]|["”]$/g, ''), seconds: 0 };
      // For articles the "seconds" field holds the paragraph number.
      const secs = q[3].startsWith('¶') ? Number(q[3].slice(1).trim()) : q[3].split(':').reduce((a, n) => a * 60 + Number(n), 0);
      return { text: q[1].replace(/["”]$/, '').trim(), seconds: secs, speaker: (q[2] || '').replace(/,\s*$/, '').trim() || undefined };
    })
    .filter((q) => q.text);

  const out = normaliseSummary({
    gist: get('gist').replace(MARKUP, '').replace(/\s+/g, ' ').trim(),
    summary: bulletLines(get('summary')),
    key_ideas: bulletLines(get('key ideas', 'key idea')).map((l) => {
      const k = l.match(/^\*\*(.+?)\*\*\s*[—–:-]?\s*(.*)$/);
      return k ? { idea: k[1].replace(/[.:]$/, ''), explanation: k[2] } : l;
    }),
    quotes,
    people: bulletLines(get('people')),
    works: bulletLines(get('works')),
    tags: bulletLines(get('tags')).flatMap((l) => l.split(/,\s*/)),
    questions: bulletLines(get('questions')),
  });
  return out;
}

// Tool output is usually well-formed, but fields can arrive missing, as JSON-encoded strings,
// or as newline-separated text. Coerce everything into the expected shape rather than crash.
// Some model outputs encode lists as "<item>…</item>" text, with nested <idea>/<quote seconds="…"> tags.
function parseXmlish(content: string): unknown {
  const inner = content.replace(/^\s*<group>([\s\S]*)<\/group>\s*$/, '$1').trim();
  const re = /<(\w+)((?:\s+\w+="[^"]*")*)\s*>([\s\S]*?)<\/\1>/g;
  const obj: Record<string, unknown> = {};
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(inner))) {
    found = true;
    obj[m[1]] = m[3].trim();
    for (const a of m[2].matchAll(/(\w+)="([^"]*)"/g)) obj[a[1]] = a[2];
  }
  return found ? obj : inner;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' && x.includes('<item>') ? asArray(x) : [x]));
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.includes('<item>')) {
      return [...t.matchAll(/<item>([\s\S]*?)(?:<\/item>|(?=<item>)|$)/g)].map((m) => parseXmlish(m[1])).filter((x) => x !== '');
    }
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
    return t
      .split(/\n+/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
  }
  if (v && typeof v === 'object') return [v];
  return [];
}

const str = (v: unknown) =>
  (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/<\/?(?:item|group|parameter|invoke)\b[^>]*>/gi, '').trim();

function toSeconds(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, v);
  const s = str(v);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((a, n) => a * 60 + Number(n), 0);
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

/** Separate "Jane Smith (speaks)" markers from the names. */
function splitPeople(raw: string[], extraSpeakers: string[]) {
  const parsed = peopleList(raw).map(parsePersonEntry).filter((p) => p.name);
  const people = [...new Map(parsed.map((p) => [personKey(p.name), p.name])).values()];
  const speakers = [...new Map([...parsed.filter((p) => p.speaks).map((p) => p.name), ...extraSpeakers].map((n) => [personKey(n), n])).values()];
  return { people, speakers };
}

export function normaliseSummary(raw: unknown): SummaryResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => asArray(v).map((x) => (typeof x === 'object' && x ? Object.values(x).map(str).join(' — ') : str(x))).filter(Boolean);
  return {
    gist: str(r.gist),
    summary: strings(r.summary),
    key_ideas: asArray(r.key_ideas)
      .map((k) => {
        if (typeof k === 'string') {
          const [idea, ...rest] = k.split(/\s[—–:-]\s|:\s/);
          return { idea: str(idea).replace(/\*\*/g, ''), explanation: rest.join(' — ').trim() };
        }
        const o = (k || {}) as Record<string, unknown>;
        return { idea: str(o.idea ?? o.name ?? o.title), explanation: str(o.explanation ?? o.description) };
      })
      .filter((k) => k.idea || k.explanation),
    quotes: asArray(r.quotes)
      .map((q) => {
        if (typeof q === 'string') return { text: q, seconds: 0 };
        const o = (q || {}) as Record<string, unknown>;
        return { text: str(o.text ?? o.quote), seconds: toSeconds(o.seconds ?? o.timestamp ?? o.time), speaker: str(o.speaker) || undefined };
      })
      .filter((q) => q.text),
    ...splitPeople(strings(r.people), strings(r.speakers)),
    works: strings(r.works),
    tags: strings(r.tags).flatMap((t) => t.split(/,\s*/)).filter(Boolean),
    questions: strings(r.questions),
  };
}

// ---------------- connections ----------------

export interface Candidate {
  slug: string;
  title: string;
  channel?: string;
  gist?: string;
  tags: string[];
  ideas: string;
  people?: string;
}

const CONNECT_SYSTEM =
  'You maintain the links in a personal knowledge base. Given a new note and a shortlist of existing notes, pick only the connections a thoughtful reader would genuinely value — usually 0–6. Prefer substantive intellectual links (agreement, disagreement, one illuminating the other, the same concept under different names) over surface topical overlap. It is fine to return none.';

const CONNECT_FORMAT = `Reply with one line per connection and nothing else, in exactly this form:
- slug-of-existing-note | strength | one sentence naming the specific link
Strength is 3 (directly in dialogue), 2 (clearly related) or 1 (suggestive). The reason must name the specific link (a shared argument, a tension, one extends or answers the other), not just "both are about X". Use slugs exactly as given. If nothing is worth linking, reply with the single word: none`;

export async function findConnections(note: { title: string; text: string }, candidates: Candidate[], ctx: CallCtx = {}) {
  if (!candidates.length) return [];
  const list = candidates
    .map(
      (c) =>
        `<note slug="${c.slug}">\nTitle: ${c.title}${c.channel ? ` (${c.channel})` : ''}\nTags: ${c.tags.join(', ')}\nGist: ${c.gist || ''}\nIdeas: ${c.ideas}${c.people ? `\nPeople: ${c.people}` : ''}\n</note>`,
    )
    .join('\n');
  const user = `<new_note>\nTitle: ${note.title}\n${note.text}\n</new_note>\n\n<existing_notes>\n${list}\n</existing_notes>\n\n${CONNECT_FORMAT}`;
  const res = await complete({ model: getConfig().connectModel || getConfig().model, maxTokens: 3000, system: CONNECT_SYSTEM, user, kind: 'connections', ctx });
  return parseConnections(res.text, new Set(candidates.map((c) => c.slug)));
}

export function parseConnections(text: string, valid: Set<string>) {
  const out: { slug: string; reason: string; strength: number }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/[`*]/g, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    let slug = parts[0].replace(/^\[+|\]+$/g, '').split(/\s/)[0];
    let strength = 2;
    let reason = '';
    if (parts.length >= 3) {
      strength = Number(parts[1].match(/\d/)?.[0]) || 2;
      reason = parts.slice(2).join(' | ');
    } else {
      // Tolerate "slug (3): reason" or "slug — reason".
      const m = line.match(/^\[*([a-z0-9-]+)\]*\s*(?:\((\d)\))?\s*[:—–-]+\s*(.+)$/);
      if (!m) continue;
      slug = m[1];
      strength = Number(m[2]) || 2;
      reason = m[3];
    }
    if (!valid.has(slug) || out.some((o) => o.slug === slug)) continue;
    out.push({ slug, reason: reason.trim(), strength: Math.min(3, Math.max(1, strength)) });
  }
  return out;
}
