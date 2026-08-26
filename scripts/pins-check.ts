/**
 * Verify every live pin against OpenRouter's own model list.
 *
 * The registry pins exact versioned slugs, which is the right discipline and
 * also the thing most likely to be wrong: a slug that was correct when it was
 * written goes stale, and the failure lands mid-round as a provider error.
 * This checks all of them in one unauthenticated request before that happens.
 *
 *   npm run pins:check
 */
import { PIN_REGISTRY, pinIsVersionSafe } from '../server/pins.js';

const unsafe = PIN_REGISTRY.filter((p) => !pinIsVersionSafe(p));
for (const pin of unsafe) {
  console.log(`UNSAFE ${pin.pin_id}: "${pin.openrouter_model_id}" resolves to whatever is newest.`);
}

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) {
  console.error(`Could not read the model list: HTTP ${res.status}.`);
  process.exit(2);
}
const body = (await res.json()) as { data: { id: string }[] };
const known = new Set(body.data.map((m) => m.id));

let bad = 0;
for (const pin of PIN_REGISTRY) {
  if (pin.status !== 'live') continue;
  const ok = known.has(pin.openrouter_model_id);
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'GONE'} ${pin.pin_id.padEnd(22)} ${pin.openrouter_model_id}`);
}

console.log(`\n${PIN_REGISTRY.length - bad}/${PIN_REGISTRY.length} pins resolve against openrouter.ai.`);
if (bad > 0) {
  console.log('A GONE pin must be repinned to a slug that exists, or marked deprecated, before the next live round.');
}
process.exit(bad > 0 || unsafe.length > 0 ? 1 : 0);
