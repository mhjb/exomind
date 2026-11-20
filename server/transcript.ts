import type { TranscriptSegment } from '../shared/types.ts';

/** Parse YouTube's json3 caption format into raw timed segments. */
export function parseJson3(raw: string): TranscriptSegment[] {
  const data = JSON.parse(raw);
  const out: TranscriptSegment[] = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s: { utf8?: string }) => s.utf8 || '')
      .join('')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!text) continue;
    out.push({ t: (ev.tStartMs || 0) / 1000, text });
  }
  return out;
}

/** Parse WebVTT, removing the rolling duplicate lines that YouTube auto-captions produce. */
export function parseVtt(raw: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const blocks = raw.replace(/\r/g, '').split(/\n\n+/);
  let lastLine = '';
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const t = parseVttTime(lines[timeIdx].split('-->')[0].trim());
    const textLines = lines
      .slice(timeIdx + 1)
      .map((l) => decodeEntities(l.replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean);
    const fresh: string[] = [];
    for (const l of textLines) {
      if (l === lastLine) continue;
      fresh.push(l);
      lastLine = l;
    }
    if (fresh.length) out.push({ t, text: fresh.join(' ') });
  }
  return out;
}

function parseVttTime(s: string): number {
  const parts = s.split(':').map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs;
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Merge short caption events into readable paragraphs (~30–60s each, breaking at sentence ends). */
export function toParagraphs(segs: TranscriptSegment[], minSecs = 30, maxSecs = 75): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment | null = null;
  for (const s of segs) {
    const text = s.text.replace(/\[(music|applause|laughter)\]/gi, (m) => m.toLowerCase());
    if (!cur) {
      cur = { t: s.t, text };
      continue;
    }
    const span = s.t - cur.t;
    const sentenceEnd = /[.!?…]["')\]]?$/.test(cur.text);
    if (span >= maxSecs || (span >= minSecs && sentenceEnd)) {
      out.push(cur);
      cur = { t: s.t, text };
    } else {
      cur.text += ' ' + text;
    }
  }
  if (cur) out.push(cur);
  return out.map((p) => ({ t: Math.floor(p.t), text: p.text.replace(/\s+/g, ' ').trim() }));
}

export function fmtTime(secs: number) {
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function timeLink(url: string | undefined, secs: number) {
  if (!url) return '';
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${Math.floor(secs)}s`;
}

/** Transcript as it's written to disk: one paragraph per timestamp. */
export function transcriptMarkdown(title: string, url: string | undefined, paras: TranscriptSegment[], source: string) {
  const head = `---\ntitle: ${JSON.stringify(title)}\nurl: ${url || ''}\nsource: ${source}\n---\n\n# Transcript — ${title}\n\n`;
  return head + paras.map((p) => `**[${fmtTime(p.t)}](${timeLink(url, p.t)})** ${p.text}`).join('\n\n') + '\n';
}

/** Read a transcript file back into paragraphs. */
export function parseTranscriptMarkdown(md: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  // Videos: **[12:34](…)** text. Articles: **[¶12](…)** text, where t is the paragraph number.
  const re = /^\*\*\[(¶?)([\d:]+)\]\([^)]*\)\*\*\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) out.push({ t: m[1] ? Number(m[2]) : parseVttTime(m[2]), text: m[3] });
  return out;
}

/**
 * A link that opens the article scrolled to (and highlighting) a passage, using the browser's
 * text-fragment syntax: url#:~:text=start,end. If the words don't match exactly, the page simply opens at the top.
 */
export function textFragmentLink(url: string | undefined, text: string) {
  if (!url) return '';
  const words = text.replace(/[“”"‘’]/g, (c) => (c === '‘' || c === '’' ? "'" : '')).split(/\s+/).filter(Boolean);
  if (!words.length) return url;
  const enc = (ws: string[]) =>
    encodeURIComponent(ws.join(' ')).replace(/[-,&()!'*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const frag = words.length > 14 ? `${enc(words.slice(0, 6))},${enc(words.slice(-4))}` : enc(words.slice(0, 10));
  return `${url.split('#')[0]}#:~:text=${frag}`;
}

/** Article text as it's written to disk: one numbered paragraph per line, each linking back into the page. */
export function articleMarkdown(title: string, url: string, paras: string[]) {
  const head = `---\ntitle: ${JSON.stringify(title)}\nurl: ${url}\nsource: article\n---\n\n# Article text — ${title}\n\n`;
  return head + paras.map((p, i) => `**[¶${i + 1}](${textFragmentLink(url, p)})** ${p}`).join('\n\n') + '\n';
}

/** Transcript as fed to the model: compact, with [m:ss] (or [¶n] for articles) markers so quotes can be located. */
export function transcriptForModel(paras: TranscriptSegment[], article = false) {
  return paras.map((p) => `[${article ? `¶${p.t}` : fmtTime(p.t)}] ${p.text}`).join('\n');
}
