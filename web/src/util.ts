import { useEffect, useState } from 'react';
import type React from 'react';

// ---------- tiny hash router ----------
export interface Route {
  view: 'library' | 'queue' | 'graph' | 'tags' | 'settings' | 'usage';
  slug?: string;
  tags: string[]; // notes must carry every one of these tags
  q?: string;
  starred?: boolean;
  person?: string; // matching key of a starred person: their notes only
}

export function parseHash(h = location.hash): Route {
  const [p, qs] = h.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  const tags = [...new Set(params.getAll('tag').flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean))];
  // Old links to the investment list (?invest=1) open the "investment" tag, which replaced it.
  if (params.get('invest') === '1' && !tags.includes('investment')) tags.push('investment');
  const base = { tags, q: params.get('q') || undefined, starred: params.get('starred') === '1', person: params.get('person') || undefined };
  if (parts[0] === 'note') return { view: 'library', slug: parts[1], ...base };
  if (['queue', 'graph', 'tags', 'settings', 'usage'].includes(parts[0])) return { view: parts[0] as Route['view'], tags: [] };
  return { view: 'library', ...base };
}

/** A link to a view. `tag` is shorthand for a filter on that one tag. */
export function href(r: Partial<Route> & { tag?: string }) {
  const params = new URLSearchParams();
  for (const t of r.tags ?? (r.tag ? [r.tag] : [])) params.append('tag', t);
  if (r.q) params.set('q', r.q);
  if (r.starred) params.set('starred', '1');
  if (r.person) params.set('person', r.person);
  const qs = params.toString() ? `?${params}` : '';
  if (r.slug) return `#/note/${encodeURIComponent(r.slug)}${qs}`;
  if (r.view && r.view !== 'library') return `#/${r.view}`;
  return `#/${qs}`;
}

export function go(r: Partial<Route> & { tag?: string }) {
  location.hash = href(r);
}

export function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const on = () => setR(parseHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}

// ---------- formatting ----------
export function fmtDuration(s?: number) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function fmtTime(secs: number) {
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtDate(d?: string) {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  if (isNaN(+dt)) return d;
  return dt.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtRelative(d?: string) {
  if (!d) return '';
  const diff = (new Date(d).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function timeLink(url: string | undefined, secs: number) {
  if (!url) return undefined;
  return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(secs)}s`;
}

/** Link into an article at a passage (browser text-fragment syntax); same rules as the server's version. */
export function textFragmentLink(url: string | undefined, text: string) {
  if (!url) return undefined;
  const words = text.replace(/[“”"‘’]/g, (c) => (c === '‘' || c === '’' ? "'" : '')).split(/\s+/).filter(Boolean);
  if (!words.length) return url;
  const enc = (ws: string[]) =>
    encodeURIComponent(ws.join(' ')).replace(/[-,&()!'*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const frag = words.length > 14 ? `${enc(words.slice(0, 6))},${enc(words.slice(-4))}` : enc(words.slice(0, 10));
  return `${url.split('#')[0]}#:~:text=${frag}`;
}

export function fmtReadTime(words?: number) {
  if (!words) return '';
  return `${Math.max(1, Math.round(words / 230))} min read`;
}

export function fmtUsd(n: number | null | undefined, digits?: number) {
  if (n == null) return '—';
  const d = digits ?? (n > 0 && n < 0.01 ? 4 : n < 0.1 ? 3 : 2);
  return `$${n.toFixed(d)}`;
}

export function fmtTokens(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Stable hue per tag so tags keep their colour everywhere. */
export function tagHue(tag: string) {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * A tag's colour: one of the six Harbour colours (house style), chosen from its name so a tag is the
 * same colour wherever it appears. Sets --tc (the full colour, for its square) and --tt (its tint).
 * Your own tags are the house's highlighted tag instead: buttercup ground, ink square.
 */
export function tagStyle(tag: string, mine = false) {
  if (mine) return { '--tc': 'var(--ink)', '--tt': 'var(--buttercup)' } as React.CSSProperties;
  const slot = (tagHue(tag) % 6) + 1;
  return { '--tc': `var(--c${slot})`, '--tt': `var(--t${slot})` } as React.CSSProperties;
}

export function cx(...c: (string | false | undefined | null)[]) {
  return c.filter(Boolean).join(' ');
}
