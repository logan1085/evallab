/**
 * The pin registry: the load-bearing file behind family diversity.
 *
 * A caller passes a pin_id, never a model string. Every pin carries an
 * explicit versioned OpenRouter model ID, its family, and the single provider
 * slug it is locked to. Adding a family to the panel is a line here, not an
 * integration. Field names match Ploom's registry so the two apps can
 * eventually share one file.
 *
 * Why families rather than models: a panel of six seats backed by one model is
 * one judge wearing six hats, and it agrees with itself for reasons that have
 * nothing to do with the rubric (PoLL, arXiv 2404.18796; self-preference,
 * arXiv 2404.13076). Six families is the cheapest way to make disagreement
 * mean something. OpenRouter is the whole point: one key buys all of them.
 *
 * The version discipline, corrected by production: pin the canonical
 * OpenRouter id, and never a floating alias. Adding a provider's dated suffix
 * does NOT make a pin more specific: openrouter.ai/api/v1/models lists
 * `anthropic/claude-opus-5`, and `anthropic/claude-opus-5-20260129` is simply
 * not a model, so the router answers "not a valid model ID" with a 400. What
 * makes a pin a pin here is that it names one exact id from that list and
 * never an alias that drifts. Validated at boot and by `npm run pins:check`.
 */

export interface Pin {
  pin_id: string;
  family: string;
  /** Explicit version, never an alias that resolves to latest. */
  openrouter_model_id: string;
  /**
   * Lock to a single upstream provider, or null to let the router choose.
   * First-party models have exactly one provider, so locking costs nothing
   * and buys determinism. Open-weight models are served by many hosts, and
   * naming one that does not carry it is how a request hangs instead of
   * failing; for those the actual provider is recorded per call in
   * model_call, which keeps the round auditable without pretending.
   */
  provider_slug: string | null;
  tier: 'small' | 'mid' | 'frontier';
  status: 'live' | 'deprecated';
  /**
   * Rough blended cost per million tokens, in credits, used only to order
   * seats by price. Not billing: real spend is read off the router per call
   * and stored in model_call. This exists so "give the literalist the cheapest
   * seat" is a fact in the registry rather than a guess at the call site.
   */
  cost_hint: number;
}

export const PIN_REGISTRY: Pin[] = [
  {
    pin_id: 'anthropic-small-1',
    family: 'anthropic',
    openrouter_model_id: 'anthropic/claude-haiku-4.5',
    provider_slug: 'anthropic',
    tier: 'small',
    status: 'live',
    cost_hint: 1.6,
  },
  {
    pin_id: 'openai-small-1',
    family: 'openai',
    openrouter_model_id: 'openai/gpt-5-mini',
    provider_slug: 'openai',
    tier: 'small',
    status: 'live',
    cost_hint: 1.0,
  },
  {
    pin_id: 'google-small-1',
    family: 'google',
    openrouter_model_id: 'google/gemini-2.5-flash',
    provider_slug: 'google-ai-studio',
    tier: 'small',
    status: 'live',
    cost_hint: 0.9,
  },
  {
    pin_id: 'meta-small-1',
    family: 'meta',
    openrouter_model_id: 'meta-llama/llama-3.3-70b-instruct',
    provider_slug: null,
    tier: 'small',
    status: 'live',
    cost_hint: 0.5,
  },
  {
    pin_id: 'deepseek-small-1',
    family: 'deepseek',
    openrouter_model_id: 'deepseek/deepseek-chat-v3-0324',
    provider_slug: null,
    tier: 'small',
    status: 'live',
    cost_hint: 0.4,
  },
  {
    pin_id: 'mistral-small-1',
    family: 'mistral',
    openrouter_model_id: 'mistralai/mistral-small-3.1-24b-instruct-2503',
    provider_slug: null,
    tier: 'small',
    status: 'live',
    cost_hint: 0.3,
  },
  {
    pin_id: 'anthropic-frontier-1',
    family: 'anthropic',
    openrouter_model_id: 'anthropic/claude-opus-5',
    provider_slug: 'anthropic',
    tier: 'frontier',
    status: 'live',
    cost_hint: 30,
  },
];

/** Aliases that resolve to "whatever is newest": banned from the registry. */
const LATEST_ALIASES = [/:latest$/i, /:free$/i, /\bauto\b/i, /:floor$/i, /:nitro$/i];

export function pinIsVersionSafe(pin: Pin): boolean {
  return !LATEST_ALIASES.some((re) => re.test(pin.openrouter_model_id)) && pin.openrouter_model_id.includes('/');
}

/**
 * Check every live pin against the router's own model list.
 *
 * This is the check that would have caught the outage: the dated ids read as
 * careful pinning and were not models at all. Returns one line per problem,
 * each naming a replacement where the namespace still exists, so a stale pin
 * is a one-line edit rather than a search.
 */
export async function validatePins(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; problems: string[]; checked: number }> {
  const unsafe = PIN_REGISTRY.filter((p) => !pinIsVersionSafe(p)).map(
    (p) => `${p.pin_id}: "${p.openrouter_model_id}" is an alias or not a namespaced id`,
  );

  let known: Set<string>;
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/models');
    if (!res.ok) return { ok: false, problems: [...unsafe, `could not read the model list: HTTP ${res.status}`], checked: 0 };
    const body = (await res.json()) as { data: { id: string }[] };
    known = new Set(body.data.map((m) => m.id));
  } catch (error) {
    return {
      ok: false,
      problems: [...unsafe, `could not read the model list: ${error instanceof Error ? error.message : 'unreachable'}`],
      checked: 0,
    };
  }

  const live = PIN_REGISTRY.filter((p) => p.status === 'live');
  const problems = [...unsafe];
  for (const pin of live) {
    if (known.has(pin.openrouter_model_id)) continue;
    const namespace = pin.openrouter_model_id.split('/')[0]!;
    const candidates = [...known].filter((id) => id.startsWith(`${namespace}/`)).sort().slice(0, 6);
    problems.push(
      `${pin.pin_id}: "${pin.openrouter_model_id}" is not a model the router lists.` +
        (candidates.length > 0 ? ` Live under ${namespace}/: ${candidates.join(', ')}` : ` Nothing lives under ${namespace}/.`),
    );
  }
  return { ok: problems.length === 0, problems, checked: live.length };
}

export class PinError extends Error {
  constructor(
    readonly kind: 'unknown_pin' | 'model_deprecated',
    message: string,
  ) {
    super(message);
  }
}

export function resolvePin(pinId: string): Pin {
  const pin = PIN_REGISTRY.find((p) => p.pin_id === pinId);
  if (!pin) throw new PinError('unknown_pin', `No pin "${pinId}" in the registry. Model strings never reach the network; add a pin.`);
  return pin;
}

/** One pin per family at a tier, cheapest first, so seat order is priced. */
export function pinsByFamily(tier: Pin['tier'] = 'small'): Map<string, Pin> {
  const out = new Map<string, Pin>();
  for (const pin of [...PIN_REGISTRY].sort((a, b) => a.cost_hint - b.cost_hint)) {
    if (pin.status !== 'live' || pin.tier !== tier) continue;
    if (!out.has(pin.family)) out.set(pin.family, pin);
  }
  return out;
}

/** The cheapest live pin at a tier: the literalist's seat. */
export function cheapestPin(tier: Pin['tier'] = 'small'): Pin {
  const live = PIN_REGISTRY.filter((p) => p.status === 'live' && p.tier === tier);
  return live.reduce((a, b) => (b.cost_hint < a.cost_hint ? b : a));
}
