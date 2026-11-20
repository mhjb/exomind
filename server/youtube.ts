import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.ts';
import { parseJson3, parseVtt, toParagraphs } from './transcript.ts';
import type { TranscriptSegment } from '../shared/types.ts';

function run(args: string[], timeoutMs = 180_000): Promise<{ stdout: string; stderr: string; code: number }> {
  const cfg = getConfig();
  const full = [...args];
  if (cfg.cookiesFromBrowser) full.unshift('--cookies-from-browser', cfg.cookiesFromBrowser);
  return new Promise((resolve, reject) => {
    execFile(
      cfg.ytdlpPath,
      full,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, PATH: extendedPath() } },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`yt-dlp not found (looked for "${cfg.ytdlpPath}"). Install it with: brew install yt-dlp`));
          return;
        }
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

// Homebrew paths aren't always on PATH when launched from a GUI (e.g. a future Electron wrapper).
function extendedPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  return [process.env.PATH || '', ...extra].join(path.delimiter);
}

function lastError(stderr: string) {
  const lines = stderr.split('\n').filter((l) => /ERROR/.test(l));
  return (lines.pop() || stderr.trim().split('\n').pop() || 'unknown yt-dlp error').replace(/^ERROR:\s*/, '');
}

export async function ytdlpVersion(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await run(['--version'], 15_000);
    if (r.code !== 0) return { ok: false, error: lastError(r.stderr) };
    return { ok: true, version: r.stdout.trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
}

export async function listPlaylist(url: string): Promise<{ title?: string; entries: PlaylistEntry[] }> {
  const r = await run(['--flat-playlist', '-J', '--no-warnings', url]);
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(lastError(r.stderr));
  const data = JSON.parse(r.stdout);
  const entries: PlaylistEntry[] = (data.entries || [])
    .filter((e: any) => e && e.id && !/^\[(private|deleted) video\]$/i.test(e.title || ''))
    .map((e: any) => ({
      id: e.id,
      title: e.title || e.id,
      url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    }));
  return { title: data.title, entries };
}

export interface VideoData {
  id: string;
  url: string;
  title: string;
  channel?: string;
  channel_url?: string;
  published?: string;
  duration?: number;
  thumbnail?: string;
  description?: string;
  chapters?: { start_time: number; title: string }[];
  youtube: boolean;
  transcript: TranscriptSegment[]; // paragraphs
  transcriptSource: 'manual' | 'auto' | 'none';
}

export class RateLimitError extends Error {}

function isRateLimit(msg: string) {
  return /\b429\b|too many requests|rate.?limit/i.test(msg);
}

/** Choose the single best caption track: human-made first, then original-language auto-captions. */
function pickTrack(info: any, subLangs: string): { lang: string; auto: boolean } | null {
  const patterns = (subLangs || 'en.*')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p}$`));
  const ok = (lang: string) => patterns.some((re) => re.test(lang));
  const manual = Object.keys(info.subtitles || {}).filter((l) => l !== 'live_chat' && ok(l));
  const auto = Object.keys(info.automatic_captions || {}).filter(ok);
  const rank = (l: string) => (l.endsWith('-orig') ? 3 : 0) + (l === 'en' ? 2 : 0) + (/^en-(GB|NZ|AU)/.test(l) ? 1 : 0);
  if (manual.length) return { lang: manual.sort((a, b) => rank(b) - rank(a))[0], auto: false };
  if (auto.length) return { lang: auto.sort((a, b) => rank(b) - rank(a))[0], auto: true };
  return null;
}

/**
 * Fetch metadata + one caption track for a video. Two yt-dlp calls: metadata first, then exactly
 * one subtitle download (asking for several at once is what triggers YouTube's 429s).
 */
export async function fetchVideo(url: string): Promise<VideoData> {
  const cfg = getConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-'));
  try {
    const meta = await run(['-J', '--skip-download', '--ignore-no-formats-error', '--no-playlist', '--no-warnings', url]);
    if (meta.code !== 0 && !meta.stdout.trim()) {
      const msg = lastError(meta.stderr);
      throw isRateLimit(msg) ? new RateLimitError(msg) : new Error(msg);
    }
    const info = JSON.parse(meta.stdout);
    const id: string = info.id;

    let transcript: TranscriptSegment[] = [];
    let transcriptSource: VideoData['transcriptSource'] = 'none';
    const track = pickTrack(info, cfg.subLangs);
    if (track) {
      const r = await run([
        '--skip-download',
        '--ignore-no-formats-error',
        '--no-playlist',
        '--no-warnings',
        track.auto ? '--write-auto-subs' : '--write-subs',
        '--sub-langs',
        track.lang,
        '--sub-format',
        'json3/vtt/best',
        '-o',
        path.join(tmp, '%(id)s.%(ext)s'),
        url,
      ]);
      const file = fs.readdirSync(tmp).find((f) => /\.(json3|vtt|srv3|srt)$/.test(f));
      if (!file) {
        const msg = lastError(r.stderr);
        if (isRateLimit(msg)) throw new RateLimitError(msg);
        throw new Error(`Couldn't download captions: ${msg}`);
      }
      const raw = fs.readFileSync(path.join(tmp, file), 'utf8');
      const segs = file.endsWith('.json3') ? parseJson3(raw) : parseVtt(raw);
      if (segs.length) {
        transcript = toParagraphs(segs);
        transcriptSource = track.auto ? 'auto' : 'manual';
      }
    }

    const ud: string | undefined = info.upload_date;
    return {
      id,
      url: info.webpage_url || url,
      title: info.title || id,
      channel: info.channel || info.uploader,
      channel_url: info.channel_url || info.uploader_url,
      published: ud && ud.length === 8 ? `${ud.slice(0, 4)}-${ud.slice(4, 6)}-${ud.slice(6, 8)}` : undefined,
      duration: info.duration ? Math.round(info.duration) : undefined,
      thumbnail: info.thumbnail,
      description: info.description,
      chapters: info.chapters?.map((c: any) => ({ start_time: c.start_time, title: c.title })),
      youtube: /youtube/i.test(info.extractor_key || info.extractor || ''),
      transcript,
      transcriptSource,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Best-effort extraction of a YouTube video id from a URL (used to de-duplicate manual adds). */
export function youtubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/youtube\.com\/(?:shorts|live|embed)\/([\w-]{11})/);
  return m ? m[1] : null;
}
