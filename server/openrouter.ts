/**
 * OpenRouter through the gateway: one JSON-out helper for the creator paths.
 *
 * Everything model-shaped in this codebase now flows through callModel, which
 * is what enforces pinning, provider locking, retries, telemetry, and the
 * spend guard in exactly one place. This module keeps the creator-facing
 * JSON contract and resolves which pin a generation task uses.
 */

import { callModel, type GatewayOptions } from './gateway.js';
import { pinsByFamily } from './pins.js';
import { DrafterError } from './drafter.js';

export function openrouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

/** Generation quality wants the frontier pin; graders use the small tier. */
export const CREATOR_PIN = process.env.GR_CREATOR_PIN ?? 'anthropic-frontier-1';

export const OPENROUTER_MODELS: Record<string, string> = Object.fromEntries(
  [...pinsByFamily('small').entries()].map(([family, pin]) => [family, pin.openrouter_model_id]),
);

export async function openrouterJson<T>(args: {
  model?: string;
  pinId?: string;
  system: string;
  user: string;
  schema?: object;
  maxTokens?: number;
  gateway?: GatewayOptions;
}): Promise<T> {
  const result = await callModel(
    {
      pin_id: args.pinId ?? CREATOR_PIN,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      max_tokens: args.maxTokens ?? 2048,
      response_format: args.schema
        ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: args.schema } }
        : { type: 'json_object' },
      caller: { kind: 'creator' },
    },
    args.gateway ?? {},
  );
  if (result.error) {
    const kind = result.error.kind === 'rate_limited' ? 'rate_limited' : result.error.kind === 'auth' ? 'auth' : 'api';
    throw new DrafterError(kind, result.error.message);
  }
  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new DrafterError('parse', 'The router returned output that was not the expected JSON.');
  }
}
