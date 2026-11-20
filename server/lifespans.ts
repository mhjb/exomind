// When the people in the people graph lived, so the graph can be arranged by era.
//
// Dates come from the model's own knowledge, asked in batches with a little context (the notes each
// person comes up in) so it can tell which "John Smith" is meant. They are kept in the vault as
// `.exo/people-dates.json`, filled once per person, and can be corrected by hand in the app.
// Hand-corrected entries are never overwritten.

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.ts';
import { complete } from './models.ts';
import { peopleGraph } from './people.ts';
import { allEntries, dirs } from './vault.ts';
import { personKey } from './names.ts';
import type { PeopleDates, PersonDates } from '../shared/types.ts';

const BATCH = 80;
const PARALLEL = 4;

const file = () => path.join(dirs().exo, 'people-dates.json');
let cache: { file: string; dates: Record<string, PersonDates> } | null = null;

function read(): Record<string, PersonDates> {
  const f = file();
  if (cache?.file === f) return cache.dates;
  let dates: Record<string, PersonDates> = {};
  try {
    dates = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    /* none yet */
  }
  cache = { file: f, dates };
  return dates;
}

function write() {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(read(), null, 1));
  fs.renameSync(tmp, f);
}

const job: PeopleDates['job'] = { running: false, done: 0, total: 0 };

/** The dates known so far, keyed by the people graph's person id. */
export function peopleDates(): PeopleDates {
  const dates = read();
  const missing = peopleGraph().people.filter((p) => !dates[p.id]).length;
  return { dates, job: { ...job }, missing };
}

/** A year as written by a person or a model: "-384", "384 BC", "c. 1564", "AD 30". Null if there isn't one. */
export function parseYear(s: string | number | null | undefined): number | null {
  if (typeof s === 'number') return Number.isFinite(s) && s !== 0 ? Math.round(s) : null;
  const t = String(s ?? '').trim();
  const m = t.match(/(-?\d{1,4})\s*(BCE?|B\.C\.E?\.?|AD|A\.D\.|CE|C\.E\.)?/i);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  if (m[2] && /^B/i.test(m[2])) y = -Math.abs(y);
  return y === 0 ? null : y;
}

/** The year to place someone at: when they were active, or the best stand-in for it. */
export function activeYear(d: PersonDates): number | null {
  if (d.active != null) return d.active;
  if (d.born != null) return Math.min(d.born + 40, d.died ?? new Date().getFullYear());
  if (d.died != null) return d.died - 15;
  return null;
}

/** Correct someone's dates by hand. Empty fields clear; the entry is then left alone by the filler. */
export function setPersonDates(id: string, name: string, input: { born?: string; died?: string; active?: string }): PersonDates {
  const key = personKey(id) || personKey(name);
  if (!key) throw new Error('A name is needed');
  const born = parseYear(input.born);
  const diedText = String(input.died ?? '').trim();
  const living = /^(living|alive|-|–)$/i.test(diedText);
  const died = living ? null : parseYear(diedText);
  const active = parseYear(input.active);
  if (born != null && died != null && died < born) throw new Error('Died is before born');
  const d: PersonDates = { name, born, died, living: living || undefined, active, confidence: born != null || active != null ? 'high' : 'none', edited: true };
  read()[key] = d;
  write();
  return d;
}

/** When two names are merged, the person keeps the dates already found for either name. */
export function moveDates(fromKey: string, toKey: string, name: string) {
  const dates = read();
  const from = dates[fromKey];
  if (!from || fromKey === toKey) return;
  const to = dates[toKey];
  // Keep the better-founded entry: one set by hand, then a firmer one.
  const rank = (d?: PersonDates) => (!d ? -1 : d.edited ? 9 : { high: 3, medium: 2, low: 1, none: 0 }[d.confidence]);
  if (rank(from) > rank(to)) dates[toKey] = { ...from, name };
  delete dates[fromKey];
  write();
}

// ---------------- filling in ----------------

const SYSTEM = [
  'You place people on a historical timeline, from your own general knowledge.',
  'Each person comes with the notes they appear in, only so you can tell which person of that name is meant.',
  'Be honest about uncertainty through the confidence field rather than by leaving dates out.',
].join(' ');

const FORMAT = `Reply with exactly one line per person, in the same order, and nothing else:
<number> | <born> | <died> | <active> | <confidence>

- Years are plain integers. BC years are negative (Aristotle: 3 | -384 | -322 | -340 | high). There is no year 0.
- died: "living" if they are alive today; "?" if unknown.
- active: the year they were most active or best known (roughly mid-career). For figures known through tradition (Moses, Homer, Isaiah, the Buddha) give the traditional date, with confidence low or medium.
- confidence: high (identified, dates well established), medium (identified, dates approximate), low (a guess).
- Anyone who speaks in a recent video or wrote a recent article was alive then. If you don't know who they are, answer: <n> | ? | living | <year of that note> | low
- If the name is not one real or traditional human person who can be placed in time (a deity, a fictional character, a group, an institution, a garbled name), answer: <n> | ? | ? | none | none`;

type Ctx = { title: string; channel?: string; year?: string; speaks: boolean };

function contextLine(name: string, ctx: Ctx[]): string {
  const bits = ctx
    .slice(0, 3)
    .map((c) => `${c.speaks ? 'speaks in' : 'mentioned in'} “${c.title.slice(0, 90)}”${c.channel || c.year ? ` (${[c.channel, c.year].filter(Boolean).join(', ')})` : ''}`);
  return `${name} — ${bits.join('; ')}`;
}

function parseReply(text: string, n: number): Map<number, PersonDates> {
  const out = new Map<number, PersonDates>();
  for (const line of text.split('\n')) {
    const f = line.replace(/^[\s*-]+/, '').split('|').map((x) => x.trim());
    if (f.length < 5) continue;
    const i = parseInt(f[0], 10);
    if (!(i >= 1 && i <= n)) continue;
    const conf = f[4].toLowerCase();
    const confidence: PersonDates['confidence'] = conf.startsWith('h') ? 'high' : conf.startsWith('m') ? 'medium' : conf.startsWith('l') ? 'low' : 'none';
    const living = /living|alive/i.test(f[2]);
    const d: PersonDates = {
      name: '',
      born: parseYear(f[1]),
      died: living ? null : parseYear(f[2]),
      living: living || undefined,
      active: /none/i.test(f[3]) ? null : parseYear(f[3]),
      confidence,
    };
    if (d.active == null && confidence !== 'none') d.active = activeYear(d);
    if (d.active == null) d.confidence = 'none';
    out.set(i, d);
  }
  return out;
}

async function dateBatch(people: { id: string; name: string; ctx: Ctx[] }[]) {
  const model = getConfig().connectModel || getConfig().model;
  const list = people.map((p, i) => `${i + 1}. ${contextLine(p.name, p.ctx)}`).join('\n');
  const res = await complete({
    model,
    maxTokens: 16000,
    system: SYSTEM,
    user: `<people>\n${list}\n</people>\n\n${FORMAT}`,
    kind: 'people-dates',
    ctx: {},
  });
  const got = parseReply(res.text, people.length);
  const dates = read();
  people.forEach((p, i) => {
    if (dates[p.id]?.edited) return;
    // Anyone the model skipped is recorded as unplaced, so they aren't asked about again and again.
    dates[p.id] = { ...(got.get(i + 1) || { born: null, died: null, active: null, confidence: 'none' as const }), name: p.name };
  });
  write();
}

/** Start dating everyone in the people graph who has no dates yet, most-mentioned first. Returns at once. */
export function fillPeopleDates(): PeopleDates {
  if (job.running) return peopleDates();
  const dates = read();
  const graph = peopleGraph();
  const todo = graph.people.filter((p) => !dates[p.id]);
  if (!todo.length) return peopleDates();

  const meta = new Map(allEntries().map((e) => [e.slug, e.meta]));
  const ctxOf = (slug: string, speaks: boolean): Ctx | null => {
    const m = meta.get(slug);
    if (!m) return null;
    return { title: m.title, channel: m.channel, year: (m.published || m.added || '').slice(0, 4) || undefined, speaks };
  };
  const work = todo.map((p) => ({
    id: p.id,
    name: p.name,
    ctx: [...p.appears.map((s) => ctxOf(s, true)), ...p.mentioned.map((s) => ctxOf(s, false))].filter((c): c is Ctx => !!c),
  }));

  Object.assign(job, { running: true, done: 0, total: work.length, error: undefined });
  const batches: (typeof work)[] = [];
  for (let i = 0; i < work.length; i += BATCH) batches.push(work.slice(i, i + BATCH));

  (async () => {
    let next = 0;
    let failures = 0;
    const worker = async () => {
      while (next < batches.length && failures < 3) {
        const b = batches[next++];
        try {
          await dateBatch(b);
        } catch (e) {
          failures++;
          job.error = (e as Error).message;
          console.error('[people-dates]', job.error);
        }
        job.done += b.length;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    job.running = false;
  })();
  return peopleDates();
}
