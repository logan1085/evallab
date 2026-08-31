/**
 * The writer's output contract, and what happens when a model ignores it.
 *
 * Production returned 502 "not the expected JSON" after 45 seconds: the model
 * was answering, the answer was not bare JSON, and the failure cost two full
 * model calls to reach with nothing useful in the message. Repair is free and
 * happens first; the network is the last resort; the error says what came back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseModelJson } from '../shared/schema.js';
import { openrouterJson, CREATOR_PIN } from '../server/openrouter.js';
import { DrafterError } from '../server/drafter.js';
import { resolvePin, validatePins, PIN_REGISTRY } from '../server/pins.js';
import type { GatewayTransport } from '../server/gateway.js';

describe('reading what a model actually sends back', () => {
  it('takes bare JSON', () => {
    expect(parseModelJson<{ a: number }>('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('unwraps a fenced block, which is the common failure', () => {
    const reply = '```json\n{"scenarios":[{"title":"One"}]}\n```';
    const parsed = parseModelJson<{ scenarios: unknown[] }>(reply);
    expect(parsed.ok && parsed.value.scenarios.length).toBe(1);
  });

  it('ignores throat-clearing before and after', () => {
    const reply = 'Here are the scenarios you asked for:\n\n{"scenarios":[]}\n\nLet me know if you want more.';
    expect(parseModelJson<{ scenarios: unknown[] }>(reply).ok).toBe(true);
  });

  it('handles braces inside strings without losing the object', () => {
    const parsed = parseModelJson<{ note: string }>('prose {"note":"a } brace and a \\" quote"} more prose');
    expect(parsed.ok && parsed.value.note).toBe('a } brace and a " quote');
  });

  it('reports genuinely broken output as broken rather than guessing', () => {
    expect(parseModelJson('{"a": ').ok).toBe(false);
    expect(parseModelJson('').ok).toBe(false);
  });
});

/** A model that answers well but wraps it, and one that never complies. */
function replier(replies: string[]): { transport: GatewayTransport; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    transport: {
      async post() {
        const text = replies[Math.min(state.calls, replies.length - 1)]!;
        state.calls++;
        return {
          status: 200,
          json: {
            id: 'gen',
            choices: [{ message: { content: text } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
          },
        };
      },
    },
  };
}

describe('the creator call', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  const ask = (transport: GatewayTransport) =>
    openrouterJson<{ scenarios: unknown[] }>({
      system: 'write scenarios',
      user: 'six of them',
      gateway: { apiKey: 'sk-or-test', transport, sleep: async () => undefined },
    });

  it('repairs a fenced reply without spending another call', async () => {
    const r = replier(['```json\n{"scenarios":[1,2]}\n```']);
    const value = await ask(r.transport);
    expect(value.scenarios.length).toBe(2);
    // The whole point: repair is local, so this cost one call, not two.
    expect(r.calls).toBe(1);
  });

  it('nudges once when the reply is truly unparseable, then succeeds', async () => {
    const r = replier(['I would rather explain it in prose.', '{"scenarios":[1]}']);
    const value = await ask(r.transport);
    expect(value.scenarios.length).toBe(1);
    expect(r.calls).toBe(2);
  });

  it('gives up after two calls and quotes what came back', async () => {
    const r = replier(['still prose, sorry']);
    const error = await ask(r.transport).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrafterError);
    expect((error as DrafterError).code).toBe('parse');
    // Unactionable errors are how this cost an evening.
    expect((error as DrafterError).message).toContain('still prose');
    // Two calls, never a retry storm.
    expect(r.calls).toBe(2);
  });
});

describe('a pin the router stops listing', () => {
  it('stands the seat down rather than substituting a different model', async () => {
    const before = PIN_REGISTRY.filter((p) => p.status === 'live').map((p) => p.pin_id);
    const target = resolvePin('mistral-small-1');
    const original = target.status;

    const listAll = async () =>
      new Response(
        JSON.stringify({
          data: PIN_REGISTRY.filter((p) => p.pin_id !== 'mistral-small-1').map((p) => ({
            id: p.openrouter_model_id,
            supported_parameters: ['response_format'],
          })),
        }),
        { status: 200 },
      );

    try {
      const result = await validatePins(listAll as unknown as typeof fetch, { disableInvalid: true });
      expect(result.ok).toBe(false);
      expect(result.disabled).toContain('mistral-small-1');
      expect(target.status).toBe('deprecated');
      // The model id is untouched: disabled, never quietly pointed elsewhere.
      expect(target.openrouter_model_id).toContain('mistralai/');
      // And the rest of the panel is still seated.
      expect(PIN_REGISTRY.filter((p) => p.status === 'live').length).toBe(before.length - 1);
    } finally {
      target.status = original;
    }
  });

  it('changes nothing when the list itself is unreachable', async () => {
    const target = resolvePin('mistral-small-1');
    const original = target.status;
    const dead = async () => {
      throw new Error('network down');
    };
    const result = await validatePins(dead as unknown as typeof fetch, { disableInvalid: true });
    expect(result.ok).toBe(false);
    expect(result.disabled).toEqual([]);
    // A blip must not disband the panel.
    expect(target.status).toBe(original);
  });
});
