/**
 * The model gateway: one call site in front of OpenRouter.
 *
 * Non-negotiables, from the build doc:
 * - callers pass a pin_id, never a model string; the registry resolves it
 * - every request carries provider: { only: [one slug], allow_fallbacks: false },
 *   because the router load-balances by default and two seats on the same pin
 *   graded by different providers would poison comparability
 * - the models fallback array is never sent
 * - usage is read off the router's response, never recomputed locally
 * - a deprecated pin is a typed result, never a substitution
 * - the user's key arrives per call and is never persisted or logged
 * - retries on 429/5xx with jittered backoff, max 4 attempts, every attempt
 *   recorded through the recorder hook
 */

import { PinError, resolvePin, type Pin } from './pins.js';

export type CallerKind = 'creator' | 'grader' | 'clusterer';

export interface ModelCallRequest {
  pin_id: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  max_tokens?: number;
  temperature?: number;
  response_format?: object;
  caller: { kind: CallerKind; round_id?: string; panelist_id?: string; case_id?: string };
}

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_credits: number;
  upstream_inference_cost?: number;
}

export type ModelErrorKind = 'auth' | 'rate_limited' | 'provider_error' | 'timeout' | 'schema' | 'model_deprecated' | 'budget_exceeded' | 'unknown_pin';

export interface ModelCallResult {
  text: string;
  raw: object;
  usage: ModelUsage;
  pin_id: string;
  model_id: string;
  model_family: string;
  provider_slug: string | null;
  generation_id: string | null;
  latency_ms: number;
  call_id: string;
  error?: { kind: ModelErrorKind; message: string };
}

/** One row per attempt, written before the result returns. Never carries a key. */
export interface ModelCallAttempt {
  call_id: string;
  attempt_no: number;
  caller_kind: CallerKind;
  round_id: string | null;
  panelist_id: string | null;
  case_id: string | null;
  pin_id: string;
  model_family: string;
  openrouter_model_id: string;
  provider_slug: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_credits: number;
  upstream_inference_cost: number | null;
  generation_id: string | null;
  latency_ms: number;
  http_status: number | null;
  error_kind: string | null;
}

export interface GatewayTransport {
  /** POSTs one request body; returns status and parsed JSON. The only place a key is used. */
  post(body: object, apiKey: string): Promise<{ status: number; json: unknown }>;
}

export interface SpendGuard {
  /** Typed refusal before the request goes out; null means proceed. */
  check(caller: ModelCallRequest['caller']): Promise<{ kind: 'budget_exceeded'; message: string } | null>;
}

export interface GatewayOptions {
  apiKey?: string;
  transport?: GatewayTransport;
  recorder?: (attempt: ModelCallAttempt) => Promise<void>;
  guard?: SpendGuard;
  /** Round context for callers that route through adapters. */
  roundId?: string;
  /** Injectable for tests; defaults to jittered backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 4;

export function buildRequestBody(pin: Pin, req: ModelCallRequest): object {
  return {
    model: pin.openrouter_model_id,
    messages: req.messages,
    max_tokens: req.max_tokens ?? 1024,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.response_format ? { response_format: req.response_format } : {}),
    provider: { only: [pin.provider_slug], allow_fallbacks: false },
  };
}

let counter = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(counter++).toString(36)}`;

function readUsage(json: unknown): { usage: ModelUsage; generationId: string | null } {
  const body = json as {
    id?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
      cost_details?: { upstream_inference_cost?: number };
    };
  };
  const u = body.usage ?? {};
  return {
    usage: {
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      cost_credits: u.cost ?? 0,
      ...(u.cost_details?.upstream_inference_cost !== undefined
        ? { upstream_inference_cost: u.cost_details.upstream_inference_cost }
        : {}),
    },
    generationId: body.id ?? null,
  };
}

function errorResult(
  req: ModelCallRequest,
  pin: Pin | null,
  callId: string,
  kind: ModelErrorKind,
  message: string,
): ModelCallResult {
  return {
    text: '',
    raw: {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_credits: 0 },
    pin_id: req.pin_id,
    model_id: pin?.openrouter_model_id ?? '',
    model_family: pin?.family ?? '',
    provider_slug: pin?.provider_slug ?? null,
    generation_id: null,
    latency_ms: 0,
    call_id: callId,
    error: { kind, message },
  };
}

export async function callModel(req: ModelCallRequest, opts: GatewayOptions = {}): Promise<ModelCallResult> {
  const callId = newCallId();

  let pin: Pin;
  try {
    pin = resolvePin(req.pin_id);
  } catch (err) {
    if (err instanceof PinError) return errorResult(req, null, callId, err.kind, err.message);
    throw err;
  }
  if (pin.status === 'deprecated') {
    // Policy: a deprecated pin freezes the form. Substitution would make every
    // historical comparison on this pin worthless.
    return errorResult(req, pin, callId, 'model_deprecated', `Pin ${pin.pin_id} is deprecated. Choose a live pin; nothing is substituted silently.`);
  }

  if (opts.guard) {
    const refusal = await opts.guard.check(req.caller);
    if (refusal) return errorResult(req, pin, callId, refusal.kind, refusal.message);
  }

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return errorResult(req, pin, callId, 'auth', 'No OpenRouter key on this request and none in the environment.');

  const transport = opts.transport ?? httpTransport();
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const body = buildRequestBody(pin, req);

  const record = async (attempt: Omit<ModelCallAttempt, 'call_id' | 'caller_kind' | 'round_id' | 'panelist_id' | 'case_id' | 'pin_id' | 'model_family' | 'openrouter_model_id' | 'provider_slug' | 'attempt_no'> & { attempt_no: number; provider_slug?: string | null }) => {
    if (!opts.recorder) return;
    await opts.recorder({
      call_id: callId,
      caller_kind: req.caller.kind,
      round_id: req.caller.round_id ?? null,
      panelist_id: req.caller.panelist_id ?? null,
      case_id: req.caller.case_id ?? null,
      pin_id: pin.pin_id,
      model_family: pin.family,
      openrouter_model_id: pin.openrouter_model_id,
      provider_slug: attempt.provider_slug ?? pin.provider_slug,
      ...attempt,
    });
  };

  let lastMessage = 'The router could not be reached.';
  for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
    const started = Date.now();
    let status: number | null = null;
    let json: unknown = null;
    let failed: string | null = null;
    try {
      const res = await transport.post(body, apiKey);
      status = res.status;
      json = res.json;
    } catch (err) {
      failed = err instanceof Error ? err.message : 'network error';
    }
    const latency = Date.now() - started;

    if (failed !== null || status === 429 || (status !== null && status >= 500)) {
      lastMessage = failed ?? `The router returned ${status}.`;
      await record({
        attempt_no: attemptNo,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cost_credits: 0,
        upstream_inference_cost: null,
        generation_id: null,
        latency_ms: latency,
        http_status: status,
        error_kind: failed !== null ? 'timeout' : status === 429 ? 'rate_limited' : 'provider_error',
      });
      if (attemptNo < MAX_ATTEMPTS) {
        await sleep(250 * 2 ** (attemptNo - 1) * (0.6 + Math.random() * 0.8));
        continue;
      }
      return { ...errorResult(req, pin, callId, status === 429 ? 'rate_limited' : failed !== null ? 'timeout' : 'provider_error', lastMessage), latency_ms: latency };
    }

    if (status === 401 || status === 403) {
      await record({
        attempt_no: attemptNo,
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_credits: 0,
        upstream_inference_cost: null, generation_id: null,
        latency_ms: latency, http_status: status, error_kind: 'auth',
      });
      return { ...errorResult(req, pin, callId, 'auth', 'The OpenRouter key was rejected.'), latency_ms: latency };
    }
    if (status !== 200) {
      await record({
        attempt_no: attemptNo,
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_credits: 0,
        upstream_inference_cost: null, generation_id: null,
        latency_ms: latency, http_status: status, error_kind: 'provider_error',
      });
      return { ...errorResult(req, pin, callId, 'provider_error', `The router returned ${status}.`), latency_ms: latency };
    }

    const parsed = json as { choices?: { message?: { content?: string } }[] };
    const text = parsed.choices?.[0]?.message?.content ?? '';
    const { usage, generationId } = readUsage(json);
    await record({
      attempt_no: attemptNo,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cost_credits: usage.cost_credits,
      upstream_inference_cost: usage.upstream_inference_cost ?? null,
      generation_id: generationId,
      latency_ms: latency,
      http_status: status,
      error_kind: null,
    });
    return {
      text,
      raw: (json ?? {}) as object,
      usage,
      pin_id: pin.pin_id,
      model_id: pin.openrouter_model_id,
      model_family: pin.family,
      provider_slug: pin.provider_slug,
      generation_id: generationId,
      latency_ms: latency,
      call_id: callId,
    };
  }
  return errorResult(req, pin, callId, 'provider_error', lastMessage);
}

function httpTransport(): GatewayTransport {
  return {
    async post(body, apiKey) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'x-title': 'The Grading Room',
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
  };
}

/* ---- Fake transport, fixture-driven --------------------------------------- */

export interface FakeFixture {
  pin_id: string;
  /** Substring matched against the last user message; omit to match any. */
  match?: string;
  text?: string;
  usage?: Partial<ModelUsage>;
  status?: number;
  /** Fail this many attempts before succeeding (for retry tests). */
  failFirst?: number;
  latency_ms?: number;
}

/** Every test in this repo, forever, runs on this. */
export function fakeTransport(fixtures: FakeFixture[]): GatewayTransport {
  const failures = new Map<FakeFixture, number>();
  return {
    async post(body) {
      const parsed = body as { model: string; messages: { role: string; content: string }[] };
      const last = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const fixture = fixtures.find(
        (f) => resolvePin(f.pin_id).openrouter_model_id === parsed.model && (!f.match || last.includes(f.match)),
      );
      if (!fixture) return { status: 500, json: { error: 'no fixture matched' } };
      if (fixture.failFirst) {
        const used = failures.get(fixture) ?? 0;
        if (used < fixture.failFirst) {
          failures.set(fixture, used + 1);
          return { status: fixture.status ?? 429, json: { error: 'scripted failure' } };
        }
      } else if (fixture.status && fixture.status !== 200) {
        return { status: fixture.status, json: { error: 'scripted failure' } };
      }
      return {
        status: 200,
        json: {
          id: `gen-fake-${fixtures.indexOf(fixture)}`,
          choices: [{ message: { content: fixture.text ?? '{}' } }],
          usage: {
            prompt_tokens: fixture.usage?.prompt_tokens ?? 100,
            completion_tokens: fixture.usage?.completion_tokens ?? 20,
            total_tokens: fixture.usage?.total_tokens ?? 120,
            cost: fixture.usage?.cost_credits ?? 0.0004,
            cost_details: { upstream_inference_cost: fixture.usage?.upstream_inference_cost ?? 0.0003 },
          },
        },
      };
    },
  };
}
