// Fetching web articles: download the page, pull out the readable text with Mozilla's Readability
// (the engine behind Firefox Reader View), and split it into paragraphs that play the part a
// video transcript plays elsewhere.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ArticleData {
  id: string; // normalised URL
  url: string;
  title: string;
  site?: string;
  siteUrl?: string;
  author?: string;
  published?: string; // YYYY-MM-DD
  thumbnail?: string;
  description?: string;
  paragraphs: string[];
  words: number;
  /** Set when the site blocked us and the text came from a Wayback Machine snapshot instead. */
  archived?: { url: string; date?: string };
  /** The text was pasted in by hand because the page couldn't be fetched. */
  pasted?: boolean;
}

/** What the user pasted for a link Exo-mind couldn't fetch. */
export interface PastedArticle {
  text: string; // plain text from the clipboard
  html?: string; // the clipboard's HTML, when the copy came from a browser (keeps paragraph breaks and headings)
  title?: string;
  author?: string;
  published?: string; // YYYY-MM-DD
}

/** The page isn't a readable article (too little text, not HTML, a video page…). Worth trying yt-dlp instead. */
export class NotAnArticle extends Error {}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// Hosts that are always handled by yt-dlp rather than read as articles.
const VIDEO_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|dailymotion\.com|twitch\.tv|rumble\.com|bitchute\.com|odysee\.com|bilibili\.com|tiktok\.com|soundcloud\.com|podcasts\.apple\.com|open\.spotify\.com)$/i;

export function isVideoUrl(url: string) {
  try {
    const u = new URL(url);
    if (VIDEO_HOSTS.test(u.hostname)) return true;
    return /(^|\.)ted\.com$/i.test(u.hostname) && u.pathname.startsWith('/talks');
  } catch {
    return false;
  }
}

const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|ref_url|source|smid|cmpid|igshid|s|si|_hsenc|_hsmi|mkt_tok)$/i;

/** One canonical form per article, so the same link pasted twice isn't fetched twice. */
export function normaliseUrl(url: string) {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return url.trim();
  }
}

const tidy = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

function isoDay(s?: string | null) {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(+d) ? undefined : d.toISOString().slice(0, 10);
}

/** schema.org data many publishers embed: author, date, publisher. */
function jsonLd(document: any) {
  const out: { author?: string; published?: string; publisher?: string; headline?: string; image?: string } = {};
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node['@graph']) visit(node['@graph']);
    const type = [].concat(node['@type'] || []).join(' ');
    if (/Article|Posting|Blog|Report|NewsArticle|WebPage/i.test(type)) {
      const a = [].concat(node.author || []).map((x: any) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
      if (a.length && !out.author) out.author = a.join(', ');
      out.published ||= node.datePublished || node.dateCreated;
      out.publisher ||= typeof node.publisher === 'string' ? node.publisher : node.publisher?.name;
      out.headline ||= node.headline;
      const img = [].concat(node.image || [])[0] as any;
      out.image ||= typeof img === 'string' ? img : img?.url;
    }
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(s.textContent || ''));
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }
  return out;
}

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, dd, dt';

/** Split Readability's cleaned HTML into paragraphs of plain text. */
function paragraphsFrom(html: string, fallbackText: string): string[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const out: string[] = [];
  for (const el of document.querySelectorAll(BLOCKS) as any) {
    if (el.querySelector(BLOCKS)) continue; // take the innermost block only, so nothing is counted twice
    const t = tidy(el.textContent);
    if (t) out.push(t);
  }
  const count = (xs: string[]) => xs.join(' ').split(/\s+/).filter(Boolean).length;
  // Some sites lay text out in bare <div>s and <br>s: fall back to the text's own line breaks.
  if (count(out) < count([fallbackText]) * 0.6) {
    return fallbackText
      .split(/\n\s*\n|\n/)
      .map(tidy)
      .filter(Boolean);
  }
  return out;
}

const BROWSER_HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-NZ,en;q=0.9' };

/** Statuses that usually mean "you look like a bot" rather than "this page doesn't exist". */
const BLOCKED = new Set([401, 403, 429, 503]);

/** A 200 that is really a bot-check interstitial (Cloudflare and friends). */
function isChallengePage(res: Response, html: string) {
  if (res.headers.get('cf-mitigated') === 'challenge') return true;
  return html.length < 50_000 && /<title>\s*(Just a moment|Attention Required|Access denied|Please verify you are a human)/i.test(html);
}

async function get(url: string) {
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: BROWSER_HEADERS });
}

/**
 * Ask the Wayback Machine for its latest snapshot. The `id_` flag returns the page exactly as
 * archived, without the archive's toolbar or rewritten links, so Readability sees the original.
 */
async function fetchFromArchive(url: string): Promise<{ html: string; archived: { url: string; date?: string } } | null> {
  let res: Response;
  try {
    res = await get(`https://web.archive.org/web/2id_/${url}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml/i.test(type)) return null;
  const html = await res.text();
  if (isChallengePage(res, html)) return null;
  const m = /web\.archive\.org\/web\/(\d{8,14})id_\//.exec(res.url);
  const stamp = m?.[1];
  return {
    html,
    archived: {
      url: stamp ? `https://web.archive.org/web/${stamp}/${url}` : `https://web.archive.org/web/${url}`,
      date: stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : undefined,
    },
  };
}

export async function fetchArticle(url: string, onStep?: (step: string) => void): Promise<ArticleData> {
  let res: Response;
  try {
    res = await get(url);
  } catch (e) {
    throw new Error(`Couldn't reach the page: ${(e as Error).message}`);
  }

  // Blocked (or served a bot check): try an archived copy before giving up.
  let html: string | undefined;
  let blocked: string | undefined;
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (!res.ok) {
    if (!BLOCKED.has(res.status)) throw new Error(`The site answered ${status}.`);
    blocked = `The site answered ${status}.`;
  } else {
    const type = res.headers.get('content-type') || '';
    if (/pdf/i.test(type)) throw new NotAnArticle("That link is a PDF, which Exo-mind can't read yet.");
    if (type && !/html|xml/i.test(type)) throw new NotAnArticle(`That link isn't a web page (${type.split(';')[0]}).`);
    html = await res.text();
    if (isChallengePage(res, html)) blocked = 'The site showed a bot check instead of the page.';
  }
  if (blocked) {
    onStep?.('Site blocked the request; trying the Wayback Machine');
    const snap = await fetchFromArchive(url);
    if (!snap) throw new Error(`${blocked} It blocks automated readers, and the Wayback Machine has no copy either.`);
    return parseArticle(snap.html, url, snap.archived);
  }
  return parseArticle(html!, res.url || url);
}

function parseArticle(html: string, finalUrl: string, archived?: ArticleData['archived']): ArticleData {
  const { document } = parseHTML(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      const v = tidy(el?.getAttribute('content'));
      if (v) return v;
    }
    return undefined;
  };
  if (/^video/i.test(meta('og:type') || '')) throw new NotAnArticle('That page is a video.');

  const ld = jsonLd(document);
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(u, finalUrl).toString();
    } catch {
      return undefined;
    }
  };
  const pageMeta = {
    title: meta('og:title', 'twitter:title') || ld.headline || tidy(document.querySelector('title')?.textContent),
    site: meta('og:site_name', 'application-name') || ld.publisher,
    author: ld.author || meta('author', 'article:author', 'parsely-author', 'sailthru.author', 'dc.creator'),
    published: meta('article:published_time', 'parsely-pub-date', 'pubdate', 'date', 'dc.date', 'citation_publication_date') || ld.published,
    image: abs(meta('og:image', 'og:image:url', 'twitter:image') || ld.image),
    description: meta('og:description', 'description', 'twitter:description'),
  };

  // Readability rewrites the document it is given, so it goes last.
  const art = new Readability(document as any, { charThreshold: 300 }).parse();
  if (!art?.content) throw new NotAnArticle("Couldn't find any article text on that page.");
  const paragraphs = paragraphsFrom(art.content, art.textContent || '');
  const words = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
  if (words < 150) {
    throw new NotAnArticle(
      `Only found ${words} words of text on that page. It may load its text with JavaScript, sit behind a paywall or need a login.`,
    );
  }

  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const author = tidy(art.byline || pageMeta.author)
    .replace(/^by\s+/i, '')
    .replace(/\s*\|.*$/, '');
  return {
    id: normaliseUrl(finalUrl),
    url: normaliseUrl(finalUrl),
    title: tidy(art.title) || pageMeta.title || host,
    site: tidy(art.siteName) || pageMeta.site || host,
    siteUrl: new URL(finalUrl).origin,
    author: author && author.length < 120 && !/^https?:/.test(author) ? author : undefined,
    published: isoDay(pageMeta.published) || isoDay((art as any).publishedTime),
    thumbnail: pageMeta.image,
    description: pageMeta.description || tidy(art.excerpt) || undefined,
    paragraphs,
    words,
    archived,
  };
}

const countWords = (xs: string[]) => xs.join(' ').split(/\s+/).filter(Boolean).length;

/** Plain text into paragraphs: blank lines if there are any, otherwise single line breaks. */
function paragraphsFromText(text: string) {
  const t = text.replace(/\r\n?/g, '\n');
  const parts = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
  return parts.map(tidy).filter(Boolean);
}

/** Build an article from text the user pasted in, for pages that block automated readers. */
export function articleFromPaste(url: string, p: PastedArticle): ArticleData {
  const plain = paragraphsFromText(p.text || '');
  let paragraphs = plain;
  if (p.html && p.html.trim()) {
    // A select-all copy brings menus and footers along; Readability strips those. A careful
    // selection of just the article may be too short for Readability, so fall back to the raw blocks.
    const { document } = parseHTML(`<!doctype html><html><head><title></title></head><body>${p.html}</body></html>`);
    const art = new Readability(document as any, { charThreshold: 100 }).parse();
    const fromReadability = art?.content ? paragraphsFrom(art.content, art.textContent || '') : [];
    const fromBlocks = paragraphsFrom(p.html, p.text || '');
    const best = countWords(fromReadability) >= countWords(plain) * 0.5 ? fromReadability : fromBlocks;
    if (countWords(best) >= countWords(plain) * 0.5) paragraphs = best;
  }
  const words = countWords(paragraphs);
  if (words < 30) throw new Error(`Only ${words} words were pasted. Copy the article text from the page and paste it again.`);

  let host = '';
  let origin: string | undefined;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    origin = u.origin;
  } catch {
    /* keep going without a site */
  }
  return {
    id: normaliseUrl(url),
    url: normaliseUrl(url),
    title: tidy(p.title) || paragraphs[0].slice(0, 120) || host,
    site: host || undefined,
    siteUrl: origin,
    author: tidy(p.author) || undefined,
    published: isoDay(p.published),
    paragraphs,
    words,
    pasted: true,
  };
}
