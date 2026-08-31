/**
 * The gateway's done-when list, from the build doc: pin resolution, the
 * request-body contract, usage parsing, retry behavior, the deprecated-pin
 * policy, and the proof that a user key never lands in a recorded object.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRequestBody,
  callModel,
  fakeTransport,
  type ModelCallAttempt,
  type ModelCallRequest,
} from '../server/gateway.js';
import { PIN_REGISTRY, pinIsVersionSafe, resolvePin } from '../server/pins.js';
import { createSpendGuard, DAILY_CEILING_ENV, ROUND_CEILING_ENV } from '../server/spend.js';
import { createApp } from '../server/app.js';
import * as store from '../server/store.js';
import { testDb } from './helpers.js';
import type { DB } from '../server/db.js';

const KEY = 'sk-or-test-never-logged';
const req = (over: Partial<ModelCallRequest> = {}): ModelCallRequest => ({
  pin_id: 'anthropic-small-1',
  messages: [{ role: 'user', content: 'Case: hello' }],
  caller: { kind: 'grader', round_id: 'r1', panelist_id: 'p1', case_id: 'c1' },
  ...over,
});
const noSleep = async () => undefined;

describe('the pin registry', () => {
  it('holds only versioned ids with a single provider slug', () => {
    for (const pin of PIN_REGISTRY) {
      expect(pinIsVersionSafe(pin), pin.pin_id).toBe(true);
      expect(pin.openrouter_model_id).toContain('/');
    }
  });

  it('resolves a pin to its family and slug, and refuses unknown pins as typed results', async () => {
    const pin = resolvePin('openai-small-1');
    expect(pin.family).toBe('openai');
    expect(pin.provider_slug).toBe('openai');

    const result = await callModel(req({ pin_id: 'not-a-pin' }), { apiKey: KEY, transport: fakeTransport([]) });
    expect(result.error?.kind).toBe('unknown_pin');
  });
});

describe('the request body contract', () => {
  it('locks one provider and forbids fallbacks, and never carries a models array', () => {
    const body = buildRequestBody(resolvePin('google-small-1'), req()) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'google/gemini-2.5-flash',
      provider: { only: ['google-ai-studio'], allow_fallbacks: false },
    });
    expect((body.provider as { only: string[] }).only).toHaveLength(1);
    expect('models' in body).toBe(false);
  });

  it('omits the provider block entirely for a pin that locks no provider', () => {
    // Open-weight models are served by many hosts. Naming one that does not
    // carry the model is how a request hangs instead of failing, so those
    // pins let the router choose and record which provider answered.
    const body = buildRequestBody(resolvePin('meta-small-1'), req()) as Record<string, unknown>;
    expect('provider' in body).toBe(false);
    expect('models' in body).toBe(false);
    expect(body.model).toBe('meta-llama/llama-3.3-70b-instruct');
  });
});

describe('calls through the fake transport', () => {
  it('parses usage off the response including cost details and the generation id', async () => {
    const result = await callModel(req(), {
      apiKey: KEY,
      transport: fakeTransport([
        { pin_id: 'anthropic-small-1', text: 'hi', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost_credits: 0.002, upstream_inference_cost: 0.0015 } },
      ]),
    });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('hi');
    expect(result.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost_credits: 0.002, upstream_inference_cost: 0.0015 });
    expect(result.generation_id).toMatch(/^gen-fake/);
    expect(result.model_family).toBe('anthropic');
  });

  it('retries a 429 with every attempt recorded, then succeeds', async () => {
    const attempts: ModelCallAttempt[] = [];
    const result = await callModel(req(), {
      apiKey: KEY,
      sleep: noSleep,
      recorder: async (a) => { attempts.push(a); },
      transport: fakeTransport([{ pin_id: 'anthropic-small-1', text: 'ok', failFirst: 2 }]),
    });
    expect(result.error).toBeUndefined();
    expect(attempts).toHaveLength(3);
    expect(attempts[0]!.error_kind).toBe('rate_limited');
    expect(attempts[2]!.error_kind).toBeNull();
    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2, 3]);
  });

  it('gives up after four attempts with a typed error', async () => {
    const attempts: ModelCallAttempt[] = [];
    const result = await callModel(req(), {
      apiKey: KEY,
      sleep: noSleep,
      recorder: async (a) => { attempts.push(a); },
      transport: fakeTransport([{ pin_id: 'anthropic-small-1', status: 500 }]),
    });
    expect(result.error?.kind).toBe('provider_error');
    expect(attempts).toHaveLength(4);
  });

  it('returns model_deprecated as a typed result, never a substitution', async () => {
    const original = PIN_REGISTRY.find((p) => p.pin_id === 'openai-small-1')!;
    original.status = 'deprecated';
    try {
      const result = await callModel(req({ pin_id: 'openai-small-1' }), { apiKey: KEY, transport: fakeTransport([]) });
      expect(result.error?.kind).toBe('model_deprecated');
      expect(result.model_id).toBe(original.openrouter_model_id);
    } finally {
      original.status = 'live';
    }
  });

  it('never lets the key into a result or a recorded attempt', async () => {
    const attempts: ModelCallAttempt[] = [];
    const result = await callModel(req(), {
      apiKey: KEY,
      recorder: async (a) => { attempts.push(a); },
      transport: fakeTransport([{ pin_id: 'anthropic-small-1', text: 'ok' }]),
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(attempts)).not.toContain(KEY);
  });
});

describe('telemetry and the spend guard', () => {
  let db: DB;

  beforeEach(async () => {
    db = await testDb();
    createApp(db);
    delete process.env[ROUND_CEILING_ENV];
    delete process.env[DAILY_CEILING_ENV];
  });

  it('persists one row per attempt and sums cost per round and per seat', async () => {
    const recorder = async (a: ModelCallAttempt) => store.recordModelCall(db, a);
    await callModel(req(), {
      apiKey: KEY, sleep: noSleep, recorder,
      transport: fakeTransport([{ pin_id: 'anthropic-small-1', text: 'ok', failFirst: 1, usage: { cost_credits: 0.003, total_tokens: 50 } }]),
    });
    await callModel(req({ pin_id: 'google-small-1', caller: { kind: 'grader', round_id: 'r1', panelist_id: 'p2' } }), {
      apiKey: KEY, sleep: noSleep, recorder,
      transport: fakeTransport([{ pin_id: 'google-small-1', text: 'ok', usage: { cost_credits: 0.001, total_tokens: 30 } }]),
    });

    const round = await store.costForRound(db, 'r1');
    expect(round.attempts).toBe(3); // failed attempt + success + second seat
    expect(round.totalCredits).toBeCloseTo(0.004, 6);
    expect(round.byPin.map((p) => p.pinId).sort()).toEqual(['anthropic-small-1', 'google-small-1']);

    const seat = await store.costForPanelist(db, 'r1', 'p2');
    expect(seat.totalCredits).toBeCloseTo(0.001, 6);
  });

  it('blocks the call that would cross a ceiling with a typed refusal', async () => {
    const recorder = async (a: ModelCallAttempt) => store.recordModelCall(db, a);
    await callModel(req(), {
      apiKey: KEY, recorder,
      transport: fakeTransport([{ pin_id: 'anthropic-small-1', text: 'ok', usage: { cost_credits: 0.02 } }]),
    });
    process.env[ROUND_CEILING_ENV] = '0.01';
    const result = await callModel(req(), {
      apiKey: KEY, recorder, guard: createSpendGuard(db),
      transport: fakeTransport([{ pin_id: 'anthropic-small-1', text: 'never reached' }]),
    });
    expect(result.error?.kind).toBe('budget_exceeded');
    expect(result.error?.message).toContain('ceiling');
  });
});
