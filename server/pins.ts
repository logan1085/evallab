/**
 * The pin registry: the load-bearing file behind family diversity.
 *
 * A caller passes a pin_id, never a model string. Every pin carries an
 * explicit versioned OpenRouter model ID, its family, and the single provider
 * slug it is locked to. Adding a fourth family to the panel is a line here,
 * not an integration. Field names match Ploom's registry so the two apps can
 * eventually share one file.
 *
 * The version discipline: never a latest-alias. The exact dated slugs should
 * be verified against openrouter.ai/models before the first live round; a
 * wrong slug fails loudly as a provider_error, which is the correct failure.
 */

export interface Pin {
  pin_id: string;
  family: 'anthropic' | 'openai' | 'google' | string;
  /** Explicit version, never an alias that resolves to latest. */
  openrouter_model_id: string;
  provider_slug: string;
  tier: 'small' | 'mid' | 'frontier';
  status: 'live' | 'deprecated';
}

export const PIN_REGISTRY: Pin[] = [
  {
    pin_id: 'anthropic-small-1',
    family: 'anthropic',
    openrouter_model_id: 'anthropic/claude-haiku-4.5-20251001',
    provider_slug: 'anthropic',
    tier: 'small',
    status: 'live',
  },
  {
    pin_id: 'openai-small-1',
    family: 'openai',
    openrouter_model_id: 'openai/gpt-5-mini-2025-08-07',
    provider_slug: 'openai',
    tier: 'small',
    status: 'live',
  },
  {
    pin_id: 'google-small-1',
    family: 'google',
    openrouter_model_id: 'google/gemini-2.5-flash-001',
    provider_slug: 'google-ai-studio',
    tier: 'small',
    status: 'live',
  },
  {
    pin_id: 'anthropic-frontier-1',
    family: 'anthropic',
    openrouter_model_id: 'anthropic/claude-opus-5-20260129',
    provider_slug: 'anthropic',
    tier: 'frontier',
    status: 'live',
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

export function pinsByFamily(tier: Pin['tier'] = 'small'): Map<string, Pin> {
  const out = new Map<string, Pin>();
  for (const pin of PIN_REGISTRY) {
    if (pin.status !== 'live' || pin.tier !== tier) continue;
    if (!out.has(pin.family)) out.set(pin.family, pin);
  }
  return out;
}
