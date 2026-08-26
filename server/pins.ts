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
 * The version discipline: never a latest-alias. The exact slugs must be
 * verified against openrouter.ai/models before the first live round, which is
 * what `npm run pins:check` does; a wrong slug fails loudly as a provider
 * error, which is the correct failure.
 */

export interface Pin {
  pin_id: string;
  family: string;
  /** Explicit version, never an alias that resolves to latest. */
  openrouter_model_id: string;
  provider_slug: string;
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
    openrouter_model_id: 'anthropic/claude-haiku-4.5-20251001',
    provider_slug: 'anthropic',
    tier: 'small',
    status: 'live',
    cost_hint: 1.6,
  },
  {
    pin_id: 'openai-small-1',
    family: 'openai',
    openrouter_model_id: 'openai/gpt-5-mini-2025-08-07',
    provider_slug: 'openai',
    tier: 'small',
    status: 'live',
    cost_hint: 1.0,
  },
  {
    pin_id: 'google-small-1',
    family: 'google',
    openrouter_model_id: 'google/gemini-2.5-flash-001',
    provider_slug: 'google-ai-studio',
    tier: 'small',
    status: 'live',
    cost_hint: 0.9,
  },
  {
    pin_id: 'meta-small-1',
    family: 'meta',
    openrouter_model_id: 'meta-llama/llama-3.3-70b-instruct',
    provider_slug: 'together',
    tier: 'small',
    status: 'live',
    cost_hint: 0.5,
  },
  {
    pin_id: 'deepseek-small-1',
    family: 'deepseek',
    openrouter_model_id: 'deepseek/deepseek-chat-v3-0324',
    provider_slug: 'deepseek',
    tier: 'small',
    status: 'live',
    cost_hint: 0.4,
  },
  {
    pin_id: 'mistral-small-1',
    family: 'mistral',
    openrouter_model_id: 'mistralai/mistral-small-3.1-24b-instruct-2503',
    provider_slug: 'mistral',
    tier: 'small',
    status: 'live',
    cost_hint: 0.3,
  },
  {
    pin_id: 'anthropic-frontier-1',
    family: 'anthropic',
    openrouter_model_id: 'anthropic/claude-opus-5-20260129',
    provider_slug: 'anthropic',
    tier: 'frontier',
    status: 'live',
    cost_hint: 30,
  },
];

/** Aliases that resolve to "whatever is newest": banned from the registry. */
const LATEST_ALIASES = [/:latest$/i, /:free$/i, /\bauto\b/i, /:floor$/i, /:nitro$/i];

export function pinIsVersionSafe(pin: Pin): boolean {
  return !LATEST_ALIASES.some((re) => re.test(pin.openrouter_model_id)) && pin.provider_slug.length > 0;
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
