// Helpers for the people named in notes, shared by the server and the web UI: splitting stored
// lists, reading role markers, and a matching key so "C.S. Lewis" and "C. S. Lewis" count as one person.

const ROLES = '(?:speaks|speaker|speaking|host|co-?host|guest|interviewer|interviewee|lecturer|presenter|panell?ist|narrator|moderator|appears|featured|writes)';
// "Jane Smith (speaks)", "Jane Smith (guest, author)", "Daniel Tutt — host"
const ROLE_RE = new RegExp(`\\s*(?:\\(\\s*${ROLES}\\b[^)]*(?:\\)|$)|\\s[—–-]\\s*(?:the\\s+)?${ROLES}\\b.*)$`, 'i');

// Stand-ins a model sometimes writes instead of a name: "(full name not given)", "Unnamed caller".
const PLACEHOLDER = /^\(|\b(?:not given|unnamed|unknown|anonymous|unidentified)\b/i;

/** Split on a separator, but not inside brackets: "Jane Smith (host, author)" stays one entry. */
function splitOutsideParens(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Flatten a stored people list. Some older notes hold the whole list as one comma- or semicolon-joined string. */
export function peopleList(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
  return arr
    .flatMap((p) => {
      const s = String(p ?? '').trim();
      if (s.includes(';')) return splitOutsideParens(s, ';');
      const commas = splitOutsideParens(s, ',');
      if (commas.length >= 3 || (arr.length === 1 && commas.length === 2)) return commas;
      return [s];
    })
    // "Nick Srnicek and Alex Williams" → two people (only when both sides look like full names).
    .flatMap((s) => {
      const parts = s.split(/\s+(?:and|&)\s+/);
      return parts.length === 2 && parts.every((x) => /^\p{Lu}\S*\s+\p{Lu}/u.test(x.trim())) ? parts : [s];
    })
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s) && !/^(?:jr|sr|ii|iii|iv)\.?$/i.test(s) && !PLACEHOLDER.test(s));
}

/** Split one entry into a clean name and whether it is marked as someone who speaks in the source. */
export function parsePersonEntry(raw: string): { name: string; speaks: boolean } {
  let s = raw.replace(/\*\*/g, '').trim();
  let speaks = false;
  const m = s.match(ROLE_RE);
  if (m && m.index! > 0) {
    speaks = true;
    s = s.slice(0, m.index).trim();
  }
  s = s
    .replace(/\s*\([^)]*\)?\s*$/, '') // other descriptions, e.g. "(philosopher)", even if left unclosed
    .replace(/[.;,:]+$/, '')
    .trim();
  return { name: s, speaks };
}

const TITLES = /^(?:dr|prof|professor|rev|revd|reverend|fr|father|sir|mr|mrs|ms|dame|lord)\b\.?\s+/;

/** A matching key: accents, punctuation, honorifics and spacing between initials don't matter. */
export function personKey(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .toLowerCase()
    .trim();
  s = s.replace(TITLES, '');
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "c s lewis" → "cs lewis", "j r r tolkien" → "jrr tolkien"
  s = s.replace(/\b[a-z](?: [a-z])+\b/g, (run) => run.replace(/ /g, ''));
  return s;
}

/** The key without middle initials: "jordan b peterson" → "jordan peterson". */
export function withoutInitials(key: string): string {
  return key
    .split(' ')
    .filter((w) => w.length > 1)
    .join(' ');
}
