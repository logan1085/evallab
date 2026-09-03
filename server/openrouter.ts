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
import { cheapestPin } from './pins.js';

export function openrouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

/** Generation quality wants the frontier pin; graders use the small tier. */
export const CREATOR_PIN = process.env.GR_CREATOR_PIN ?? 'anthropic-frontier-1';

/**
 * A creator call is one model call, and a failure must not become four.
 *
 * The budget: one request, then local repair (free), then at most one repair
 * request. Two model calls total, each under its own deadline.
 *
 * The repair request is deliberately not a rerun. The expensive work, writing
 * the scenarios or the seats, already happened; what failed is the packaging.
 * Reformatting existing text into JSON is a small-model job that takes a few
 * seconds, so the repair goes to the cheapest live pin with a tight deadline
 * instead of asking the frontier model to think everything through again.
 * That is the difference between a failure that costs forty-five seconds and
 * one that costs the original call plus single digits.
 */
const CREATOR_TIMEOUT_MS = Number(process.env.GR_CREATOR_TIMEOUT_MS ?? 25_000);
const REPAIR_TIMEOUT_MS = Number(process.env.GR_REPAIR_TIMEOUT_MS ?? 8_000);

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

  // Two stages, named in every failure: the call (did the router hand back an
  // answer) and the parse (was that answer the JSON asked for). "The writer
  // did not return JSON" covered both and pointed at neither, which is how a
  // router-side error read as a prompt problem for a week.
  const first = await ask(base);
  if (first.error) throw asDrafterError(first.error, 'call');
  if (first.truncated) {
    throw new DrafterError(
      'api',
      `Model call failed: the reply from ${first.model_id} was cut off at max_tokens=${args.maxTokens ?? 2048} after ${first.usage.completion_tokens} tokens. Raise the limit or ask for less.`,
    );
  }

  // Free repair before paid repair: fences and throat-clearing are the common
  // failures and cost nothing to undo.
  const parsed = parseModelJson<T>(first.text);
  if (parsed.ok) return parsed.value;
  console.warn(`[writer] parse failed on ${first.model_id} (${parsed.reason}); raw reply: ${JSON.stringify(first.text.slice(0, 800))}`);

  // The paid repair. The gateway now turns a 200 with no text into a call
  // error, so an empty string here is the model genuinely answering nothing;
  // that one case re-asks the original question once. Anything else goes to
  // the cheapest seat as a pure reformatting job, schema in hand.
  const retry =
    first.text.trim() === ''
      ? await ask(base)
      : await callModel(
          {
            pin_id: cheapestPin('small').pin_id,
            messages: [
              {
                role: 'system',
                content:
                  'You convert a reply into valid JSON. Output only the JSON value: no prose before or after it, no code fences. Preserve the reply’s content exactly; invent nothing.',
              },
              {
                role: 'user',
                content: [
                  'Convert this reply into valid JSON.',
                  args.schema ? `It must match this JSON schema:\n${JSON.stringify(args.schema).slice(0, 2500)}` : '',
                  `The reply:\n${first.text.slice(0, 6000)}`,
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ],
            max_tokens: args.maxTokens ?? 2048,
            response_format: responseFormat,
            caller: { kind: 'creator' },
          },
          { ...gateway, timeoutMs: REPAIR_TIMEOUT_MS },
        );
  if (retry.error) throw asDrafterError(retry.error, 'call');

  const repaired = parseModelJson<T>(retry.text);
  if (repaired.ok) return repaired.value;
  console.warn(`[writer] repair parse failed on ${retry.model_id} (${repaired.reason}); raw reply: ${JSON.stringify(retry.text.slice(0, 800))}`);

  // Fail clean, and say what actually came back: "not the expected JSON" with
  // nothing else is unactionable, which is how this cost an evening.
  const sample = retry.text.trim().slice(0, 160).replace(/\s+/g, ' ');
  throw new DrafterError(
    'parse',
    `Parse failed: ${retry.model_id} answered, but not with the JSON asked for, twice (${repaired.reason}). It said: ${sample || '(nothing)'}`,
  );
}

function asDrafterError(error: { kind: string; message: string }, stage: 'call' | 'parse'): DrafterError {
  const kind = error.kind === 'rate_limited' ? 'rate_limited' : error.kind === 'auth' ? 'auth' : 'api';
  return new DrafterError(kind, `${stage === 'call' ? 'Model call failed' : 'Parse failed'}: ${error.message}`);
}
