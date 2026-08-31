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
  /** Per-request deadline. Creator calls set a tighter one than graders. */
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 4;

/** Models observed to refuse json_schema, so the doomed attempt happens once. */
const NO_SCHEMA_SUPPORT = new Set<string>();

/**
 * Forget what has been learned about model capabilities. Process-lifetime
 * memory is right in production and wrong across tests, where one case
 * teaching the gateway about a model would silently change the next.
 */
export function resetLearnedCapabilities(): void {
  NO_SCHEMA_SUPPORT.clear();
}

export function buildRequestBody(pin: Pin, req: ModelCallRequest): object {
  return {
    model: pin.openrouter_model_id,
    messages: req.messages,
    max_tokens: req.max_tokens ?? 1024,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.response_format ? { response_format: req.response_format } : {}),
    // Only lock the provider when the pin names one. Naming a host that does
    // not serve the model is how a request hangs rather than fails; which
    // provider actually answered is recorded per call either way.
    ...(pin.provider_slug ? { provider: { only: [pin.provider_slug], allow_fallbacks: false } } : {}),
  };
}

let counter = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/**
 * OpenRouter's own words for a failure. The shape varies by which layer
 * refused (`error.message`, a bare `message`, or an upstream body carried in
 * `error.metadata.raw`), so all of them are read rather than assuming one.
 */
export function routerErrorMessage(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';
  const body = json as { error?: unknown; message?: unknown };
  const error = body.error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const inner = error as { message?: unknown; metadata?: unknown };
    if (typeof inner.message === 'string') {
      const meta = inner.metadata;
      if (typeof meta === 'object' && meta !== null) {
        const raw = (meta as { raw?: unknown }).raw;
        if (typeof raw === 'string' && raw.length > 0) return `${inner.message} (${raw})`;
      }
      return inner.message;
    }
  }
  if (typeof body.message === 'string') return body.message;
  return '';
}

/** True when this request asked for a schema-enforced reply. */
function usesJsonSchema(req: ModelCallRequest): boolean {
  return (req.response_format as { type?: string } | undefined)?.type === 'json_schema';
}

/**
 * The router saying this model cannot do the format, as opposed to saying our
 * schema is wrong. The distinction matters: the first is worth degrading for,
 * the second is a bug that must stay loud.
 */
function saysFormatUnsupported(detail: string): boolean {
  const text = detail.toLowerCase();
  // "Invalid schema" is our bug, not the model's limitation. Degrading on it
  // would have hidden the outage that started all of this, so it is excluded
  // before anything else is considered.
  if (/invalid schema|schema is invalid|bad schema|schema validation/.test(text)) return false;
  const aboutFormat = /response_format|structured output|json_schema|json schema/.test(text);
  const unsupported = /does ?n[o\u2019']?t support|not supported|unsupported|no endpoints/.test(text);
  return aboutFormat && unsupported;
}

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

  const transport = opts.transport ?? httpTransport(opts.timeoutMs);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // A model that refused json_schema once will refuse it every time, and
  // paying a doomed request before every real one doubles the latency of the
  // whole creator path. Remembered per process, per model.
  const schemaUnsupported = NO_SCHEMA_SUPPORT.has(pin.openrouter_model_id);
  let body = buildRequestBody(
    pin,
    schemaUnsupported && usesJsonSchema(req) ? { ...req, response_format: { type: 'json_object' } } : req,
  );
  // Strict structured outputs are not universal. A six-family panel will meet
  // models that implement plain JSON mode but refuse a json_schema, and that
  // refusal is a 400 on the request, not a bad answer: without this, adding a
  // family to the registry could take out every seat it sits in.
  let degradedFormat = false;

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
      // The router explains its own 4xx, and that explanation is the whole
      // diagnosis: "not a valid model ID" and "invalid schema" are the same
      // status with completely different fixes. Throwing it away left the
      // operator with "the router returned 400" and nothing to act on.
      const detail = routerErrorMessage(json);

      // One step down, once: json_schema to plain JSON mode. Only when the
      // router says the model does not support the format, never when it says
      // our schema is malformed, because masking that is how the last outage
      // stayed invisible for a week.
      if (!degradedFormat && !schemaUnsupported && usesJsonSchema(req) && saysFormatUnsupported(detail)) {
        degradedFormat = true;
        NO_SCHEMA_SUPPORT.add(pin.openrouter_model_id);
        body = buildRequestBody(pin, { ...req, response_format: { type: 'json_object' } });
        lastMessage = detail;
        continue;
      }

      return {
        ...errorResult(
          req,
          pin,
          callId,
          status === 404 ? 'model_deprecated' : 'provider_error',
          `The router returned ${status} for ${pin.openrouter_model_id}${detail ? `: ${detail}` : '.'}`,
        ),
        latency_ms: latency,
      };
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

/**
 * How long one request may take before it is abandoned.
 *
 * fetch has no default timeout: a connection the router accepts and never
 * answers hangs forever, and four attempts of forever is a function that
 * burns its whole wall clock and returns nothing. Every attempt now carries
 * its own deadline, so the worst case is bounded and visible.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.GR_REQUEST_TIMEOUT_MS ?? 45_000);

/** Set GR_LOG_MODEL_CALLS=1 to print every request and reply, server-side. */
const LOG_CALLS = process.env.GR_LOG_MODEL_CALLS === '1';

function httpTransport(timeoutMs = REQUEST_TIMEOUT_MS): GatewayTransport {
  return {
    async post(body, apiKey) {
      const started = Date.now();
      const sent = body as { model?: string; max_tokens?: number };
      if (LOG_CALLS) {
        // The key is never in the body, so this is safe to print whole.
        console.log(`[model] -> ${sent.model} ${JSON.stringify(body).length}B`, JSON.stringify(body).slice(0, 2000));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'x-title': 'The Grading Room',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (LOG_CALLS) {
          console.log(`[model] <- ${sent.model} ${res.status} in ${Date.now() - started}ms`, JSON.stringify(json).slice(0, 2000));
        }
        return { status: res.status, json };
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (LOG_CALLS) console.log(`[model] !! ${sent.model} ${aborted ? 'timeout' : 'network'} after ${Date.now() - started}ms`);
        throw aborted ? new Error(`No answer from the router within ${timeoutMs}ms.`) : error;
      } finally {
        clearTimeout(timer);
      }
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
