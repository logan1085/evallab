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
const body = (await res.json()) as { data: { id: string; supported_parameters?: string[] }[] };
const known = new Set(body.data.map((m) => m.id));
const byId = new Map(body.data.map((m) => [m.id, m]));

let bad = 0;
let live = 0;
for (const pin of PIN_REGISTRY) {
  if (pin.status !== 'live') continue;
  live++;
  const ok = known.has(pin.openrouter_model_id);
  if (!ok) bad++;
  const params = byId.get(pin.openrouter_model_id)?.supported_parameters ?? [];
  // Not every model implements schema-enforced replies. The gateway steps
  // down to plain JSON mode when the router says so, but knowing which seats
  // will take that path beats finding out mid-round.
  const structured = params.includes('structured_outputs') || params.includes('response_format');
  console.log(
    `${ok ? 'OK  ' : 'GONE'} ${pin.pin_id.padEnd(22)} ${pin.openrouter_model_id.padEnd(46)}` +
      (ok ? (structured ? 'structured outputs' : 'plain JSON mode (gateway steps down)') : ''),
  );
  if (!ok) {
    // A stale pin is only half a diagnosis; the other half is what to put in
    // its place. The prefix before the slash is the vendor namespace, so the
    // same-family slugs that do exist are the shortlist.
    const namespace = pin.openrouter_model_id.split('/')[0];
    const candidates = body.data
      .map((m) => m.id)
      .filter((id) => id.startsWith(`${namespace}/`))
      .sort();
    if (candidates.length > 0) {
      console.log(`     live ${namespace} models to repin to:`);
      for (const id of candidates.slice(0, 12)) console.log(`       ${id}`);
      if (candidates.length > 12) console.log(`       … and ${candidates.length - 12} more`);
    } else {
      console.log(`     no live models under "${namespace}/": the whole namespace may have moved.`);
    }
  }
}

console.log(`\n${live - bad}/${live} live pins resolve against openrouter.ai.`);
if (bad > 0) {
  console.log('Repin each GONE entry in server/pins.ts to a slug above, then run this again.');
  console.log('Nothing else needs changing: callers pass pin ids, never model strings.');
}
process.exit(bad > 0 || unsafe.length > 0 ? 1 : 0);
