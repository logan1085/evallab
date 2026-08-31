/**
 * OpenRouter through the gateway: one JSON-out helper for the creator paths.
 *
 * Everything model-shaped in this codebase now flows through callModel, which
 * is what enforces pinning, provider locking, retries, telemetry, and the
 * spend guard in exactly one place. This module keeps the creator-facing
 * JSON contract and resolves which pin a generation task uses.
 */

import { callModel, type GatewayOptions } from './gateway.js';
import { DrafterError } from './drafter.js';
import { parseModelJson } from '../shared/schema.js';

export function openrouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

/** Generation quality wants the frontier pin; graders use the small tier. */
export const CREATOR_PIN = process.env.GR_CREATOR_PIN ?? 'anthropic-frontier-1';

/**
 * A creator call is one model call, and a failure must not become four.
 *
 * The budget: one request, then local repair (free), then at most one nudge
 * request. Two model calls total, each under its own deadline, so the worst
 * case a user waits for a writer failure is bounded and roughly the same as
 * the best case for a success.
 */
const CREATOR_TIMEOUT_MS = Number(process.env.GR_CREATOR_TIMEOUT_MS ?? 25_000);

export async function openrouterJson<T>(args: {
  /** Which pin runs this task. Defaults to the creator pin. */
  pinId?: string;
  system: string;
  user: string;
  schema?: object;
  maxTokens?: number;
  gateway?: GatewayOptions;
}): Promise<T> {
  const pinId = args.pinId ?? CREATOR_PIN;
  const responseFormat = args.schema
    ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: args.schema } }
    : { type: 'json_object' };
  const gateway: GatewayOptions = { timeoutMs: CREATOR_TIMEOUT_MS, ...(args.gateway ?? {}) };

  const ask = (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) =>
    callModel(
      {
        pin_id: pinId,
        messages,
        max_tokens: args.maxTokens ?? 2048,
        response_format: responseFormat,
        caller: { kind: 'creator' },
      },
      gateway,
    );

  const base: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
  ];

  const first = await ask(base);
  if (first.error) throw asDrafterError(first.error);

  // Free repair before paid repair: fences and throat-clearing are the common
  // failures and cost nothing to undo.
  const parsed = parseModelJson<T>(first.text);
  if (parsed.ok) return parsed.value;

  // One nudge, carrying the model's own reply back so it can see what it did.
  const retry = await ask([
    ...base,
    { role: 'assistant', content: first.text.slice(0, 4000) },
    {
      role: 'user',
      content:
        'That reply could not be parsed as JSON. Reply again with only the JSON value, no prose before or after it and no code fences.',
    },
  ]);
  if (retry.error) throw asDrafterError(retry.error);

  const repaired = parseModelJson<T>(retry.text);
  if (repaired.ok) return repaired.value;

  // Fail clean, and say what actually came back: "not the expected JSON" with
  // nothing else is unactionable, which is how this cost an evening.
  const sample = retry.text.trim().slice(0, 160).replace(/\s+/g, ' ');
  throw new DrafterError(
    'parse',
    `The writer did not return JSON after two attempts (${repaired.reason}). It answered: ${sample || '(nothing)'}`,
  );
}

function asDrafterError(error: { kind: string; message: string }): DrafterError {
  const kind = error.kind === 'rate_limited' ? 'rate_limited' : error.kind === 'auth' ? 'auth' : 'api';
  return new DrafterError(kind, error.message);
}
