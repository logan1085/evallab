/**
 * One call through the gateway, printed. Dry by default (fake transport);
 * --live sends one real request through OpenRouter on the cheapest pin and
 * prints the usage the router reported, so the recorded numbers can be
 * checked against the dashboard for that generation.
 *
 *   npx tsx scripts/model-smoke.ts
 *   OPENROUTER_API_KEY=... npx tsx scripts/model-smoke.ts --live
 */
import { callModel, fakeTransport } from '../server/gateway.js';

const live = process.argv.includes('--live');
const result = await callModel(
  {
    pin_id: 'anthropic-small-1',
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    max_tokens: 10,
    caller: { kind: 'creator' },
  },
  live ? {} : { apiKey: 'fake-key-for-fake-transport', transport: fakeTransport([{ pin_id: 'anthropic-small-1', text: 'ready' }]) },
);
console.log(JSON.stringify({
  mode: live ? 'live' : 'fake',
  text: result.text,
  model: result.model_id,
  family: result.model_family,
  usage: result.usage,
  generation_id: result.generation_id,
  error: result.error ?? null,
}, null, 2));
