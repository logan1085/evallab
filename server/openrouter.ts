/**
 * OpenRouter: three model families through one key.
 *
 * Family diversity is the product (spec 4.3), and this is the cheapest honest
 * way to get it: one OPENROUTER_API_KEY reaches Anthropic, OpenAI, and Google
 * models through one OpenAI-compatible endpoint. Direct provider keys take
 * precedence per family when both are present, so routing through OpenRouter
 * is a default, never a lock-in.
 */

import { DrafterError } from './drafter.js';

const BASE = 'https://openrouter.ai/api/v1/chat/completions';

export const OPENROUTER_MODELS: Record<string, string> = {
  anthropic: process.env.GR_OR_MODEL_ANTHROPIC ?? 'anthropic/claude-haiku-4.5',
  openai: process.env.GR_OR_MODEL_OPENAI ?? 'openai/gpt-5-mini',
  google: process.env.GR_OR_MODEL_GOOGLE ?? 'google/gemini-2.5-flash',
};

export function openrouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

/**
 * One chat call, JSON out. Structured outputs are requested via json_schema
 * where the routed model supports it; the fallback parse is strict either
 * way, and a response that is not the expected JSON throws rather than being
 * repaired into something that looks like judgment.
 */
export async function openrouterJson<T>(args: {
  model: string;
  system: string;
  user: string;
  schema?: object;
  maxTokens?: number;
}): Promise<T> {
  const key = openrouterKey();
  if (!key) throw new DrafterError('auth', 'OPENROUTER_API_KEY is not set.');

  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-title': 'The Grading Room',
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens ?? 2048,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      response_format: args.schema
        ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: args.schema } }
        : { type: 'json_object' },
    }),
  });
  if (res.status === 429) throw new DrafterError('rate_limited', 'OpenRouter rate limited this call. Wait a moment.');
  if (res.status === 401 || res.status === 403) throw new DrafterError('auth', 'OPENROUTER_API_KEY was rejected.');
  if (!res.ok) throw new DrafterError('api', `OpenRouter returned ${res.status}.`);

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? '';
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DrafterError('parse', 'OpenRouter returned output that was not the expected JSON.');
  }
}
