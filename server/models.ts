import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getConfig } from './config.ts';
import { recordUsage } from './usage.ts';
import type { UsageRecord } from '../shared/types.ts';

// One text-in/text-out call, whichever provider the chosen model belongs to.
// Everything else in the app works on plain text, so switching models is a setting, not a code change.

export type Provider = 'anthropic' | 'openai';

export function providerOf(model: string): Provider {
  return /^(gpt|o\d|chatgpt)/i.test(model) ? 'openai' : 'anthropic';
}

export interface CallCtx {
  slug?: string;
}

export interface CompleteOpts {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  kind: UsageRecord['kind'];
  ctx: CallCtx;
}

export async function complete(o: CompleteOpts): Promise<{ text: string; truncated: boolean }> {
  return providerOf(o.model) === 'openai' ? completeOpenAI(o) : completeAnthropic(o);
}

async function completeAnthropic(o: CompleteOpts) {
  const key = getConfig().anthropicApiKey;
  if (!key) throw new Error(`No Anthropic API key set, but the model is ${o.model}. Add a key in Settings.`);
  const client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 10 * 60 * 1000 });
  const res = await client.messages.create({
    model: o.model,
    max_tokens: o.maxTokens,
    system: o.system,
    messages: [{ role: 'user', content: o.user }],
  });
  const u = res.usage;
  recordUsage({
    model: res.model || o.model,
    kind: o.kind,
    slug: o.ctx.slug,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  });
  return { text: res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), truncated: res.stop_reason === 'max_tokens' };
}

async function completeOpenAI(o: CompleteOpts) {
  const cfg = getConfig();
  const key = cfg.openaiApiKey;
  if (!key) throw new Error(`No OpenAI API key set, but the model is ${o.model}. Add a key in Settings.`);
  const client = new OpenAI({ apiKey: key, maxRetries: 3, timeout: 10 * 60 * 1000 });
  const effort = cfg.reasoningEffort || 'medium';
  const res = await client.responses.create({
    model: o.model,
    instructions: o.system,
    input: o.user,
    // Reasoning tokens count towards this limit, so leave generous headroom above the visible output.
    max_output_tokens: o.maxTokens + (effort === 'none' ? 0 : 24_000),
    reasoning: { effort: effort as OpenAI.ReasoningEffort },
    store: false,
  });
  const u = res.usage;
  const cached = u?.input_tokens_details?.cached_tokens || 0;
  recordUsage({
    model: res.model || o.model,
    kind: o.kind,
    slug: o.ctx.slug,
    input: (u?.input_tokens || 0) - cached,
    output: u?.output_tokens || 0, // includes reasoning tokens, which are billed as output
    cacheRead: cached,
    reasoning: u?.output_tokens_details?.reasoning_tokens || 0,
  });
  if (res.status === 'incomplete' && !res.output_text) {
    throw new Error(`OpenAI returned no text (${res.incomplete_details?.reason || 'incomplete'})`);
  }
  return { text: res.output_text || '', truncated: res.status === 'incomplete' };
}
