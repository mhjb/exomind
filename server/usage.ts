import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.ts';
import type { UsageRecord, UsageSummary } from '../shared/types.ts';

// USD per million tokens, from Anthropic's pricing page (September 2026).
// Update here if prices change; unknown models are logged with tokens but no cost.
// OpenAI: cacheRead is the cached-input rate; reasoning tokens are billed as output. GPT-6 Luna doubles
// input prices above 272k input tokens, which Exo-mind avoids by chunking long transcripts well below that.
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function priceFor(model: string) {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + '-'));
  return key ? PRICES[key] : null;
}

export function costOf(model: string, u: { input: number; output: number; cacheWrite?: number; cacheRead?: number }) {
  const p = priceFor(model);
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + (u.cacheWrite || 0) * p.cacheWrite + (u.cacheRead || 0) * p.cacheRead) / 1e6;
}

/** Rough pre-flight estimate for a summary: ~4 characters per token, plus typical output. */
export function estimateSummaryCost(model: string, transcriptChars: number) {
  // Reasoning models spend extra (billed) output tokens thinking before they write.
  const output = /^(gpt|o\d)/i.test(model) ? 9000 : 3500;
  return costOf(model, { input: Math.ceil(transcriptChars / 3.6) + 1500, output });
}

const FILE = () => path.join(DATA_DIR, 'usage.jsonl');
let cache: UsageRecord[] | null = null;

function all(): UsageRecord[] {
  if (cache) return cache;
  cache = [];
  if (fs.existsSync(FILE())) {
    for (const line of fs.readFileSync(FILE(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        cache.push(JSON.parse(line));
      } catch {
        /* skip bad line */
      }
    }
  }
  return cache;
}

export function recordUsage(r: Omit<UsageRecord, 'at' | 'cost'>) {
  const rec: UsageRecord = { at: new Date().toISOString(), ...r, cost: costOf(r.model, r) };
  all().push(rec);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(FILE(), JSON.stringify(rec) + '\n');
  return rec;
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (d: Date) => `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

export function spendThisMonth() {
  const m = monthKey(new Date());
  return all().reduce((s, r) => (monthKey(new Date(r.at)) === m ? s + (r.cost || 0) : s), 0);
}

export function costForSlug(slug: string) {
  let cost = 0;
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const r of all())
    if (r.slug === slug) {
      cost += r.cost || 0;
      input += r.input + (r.cacheRead || 0) + (r.cacheWrite || 0);
      output += r.output;
      calls++;
    }
  return calls ? { cost, input, output, calls } : null;
}

/** Budget check used by the worker before any model call. */
export function budgetState() {
  const budget = getConfig().monthlyBudgetUsd || 0;
  const spent = spendThisMonth();
  return { budget, spent, over: budget > 0 && spent >= budget };
}

export function summary(titles: Map<string, string>): UsageSummary {
  const recs = all();
  const now = new Date();
  const thisMonth = monthKey(now);
  const today = dayKey(now);
  const days: { day: string; cost: number; calls: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({ day: dayKey(d), cost: 0, calls: 0 });
  }
  const dayIdx = new Map(days.map((d, i) => [d.day, i]));
  const months = new Map<string, number>();
  const notes = new Map<string, { slug: string; cost: number; input: number; output: number; calls: number; last: string }>();
  let allTime = 0;
  let month = 0;
  let todayCost = 0;
  let unpriced = 0;
  const models = new Set<string>();
  for (const r of recs) {
    const d = new Date(r.at);
    const c = r.cost || 0;
    if (r.cost == null) unpriced++;
    models.add(r.model);
    allTime += c;
    if (monthKey(d) === thisMonth) month += c;
    if (dayKey(d) === today) todayCost += c;
    months.set(monthKey(d), (months.get(monthKey(d)) || 0) + c);
    const i = dayIdx.get(dayKey(d));
    if (i !== undefined) {
      days[i].cost += c;
      days[i].calls++;
    }
    if (r.slug) {
      const n = notes.get(r.slug) || { slug: r.slug, cost: 0, input: 0, output: 0, calls: 0, last: r.at };
      n.cost += c;
      n.input += r.input + (r.cacheRead || 0) + (r.cacheWrite || 0);
      n.output += r.output;
      n.calls++;
      if (r.at > n.last) n.last = r.at;
      notes.set(r.slug, n);
    }
  }
  const perNote = [...notes.values()].map((n) => ({ ...n, title: titles.get(n.slug) || n.slug, deleted: !titles.has(n.slug) }));
  const ingested = perNote.length;
  return {
    today: todayCost,
    month,
    allTime,
    avgPerNote: ingested ? allTime / ingested : 0,
    budget: getConfig().monthlyBudgetUsd || 0,
    maxPerItem: getConfig().maxCostPerItemUsd || 0,
    days,
    months: [...months.entries()].map(([month, cost]) => ({ month, cost })).sort((a, b) => a.month.localeCompare(b.month)),
    notes: perNote.sort((a, b) => b.last.localeCompare(a.last)),
    calls: recs.length,
    unpriced,
    models: [...models],
    prices: PRICES,
  };
}
