/**
 * The scenario-writer outage, reproduced and fenced.
 *
 * Every creator call sends `strict: true`, and strict structured outputs take
 * only a subset of JSON Schema. All three creator schemas used minItems and
 * maxItems, which strict rejects with a 400 before a model sees the request.
 * It surfaced as "Write the scenarios" failing on every retry; panel seating
 * looked healthy only because it silently falls back to the generic bench.
 *
 * Two guards, because the bug had two halves. The schemas are checked against
 * the strict subset directly, and a stand-in router applies the same rules to
 * whatever the product actually puts on the wire, so a schema that regresses
 * fails here rather than in production.
 */
import { describe, expect, it } from 'vitest';
import { strictSchemaProblems } from '../shared/schema.js';
import { scenarioJsonSchema } from '../shared/scenarios.js';
import { panelJsonSchema } from '../shared/panel.js';
import { draftJsonSchema } from '../shared/drafting.js';
import { SEAT_VERDICT_SCHEMA } from '../shared/panel.js';
import { judgeJsonSchema } from '../shared/rubric.js';
import { ABSTAIN, DEFAULT_SCALE } from '../shared/types.js';
import { callModel, type GatewayTransport } from '../server/gateway.js';
import { CREATOR_PIN } from '../server/openrouter.js';

const SCHEMAS: [string, unknown][] = [
  ['scenario', scenarioJsonSchema(6)],
  ['panel', panelJsonSchema(5)],
  ['draft', draftJsonSchema()],
  ['seat verdict', SEAT_VERDICT_SCHEMA],
  ['judge', judgeJsonSchema(DEFAULT_SCALE.map((l) => l.id), ABSTAIN)],
];

describe('every schema the product sends survives strict mode', () => {
  for (const [name, schema] of SCHEMAS) {
    it(`${name}: no unsupported keyword, every object closed and fully required`, () => {
      expect(strictSchemaProblems(schema)).toEqual([]);
    });
  }

  it('catches the exact shape that broke scenario writing', () => {
    // The schema as it was: a bounded array. Strict refuses it.
    const asItWas = {
      type: 'object',
      properties: {
        scenarios: {
          type: 'array',
          minItems: 4,
          maxItems: 6,
          items: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['scenarios'],
      additionalProperties: false,
    };
    const problems = strictSchemaProblems(asItWas);
    expect(problems.some((p) => p.includes('minItems'))).toBe(true);
    expect(problems.some((p) => p.includes('maxItems'))).toBe(true);
  });

  it('catches the panel schema\'s open objects too', () => {
    const asItWas = {
      type: 'object',
      properties: {
        seats: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
      required: ['seats'],
    };
    expect(strictSchemaProblems(asItWas).filter((p) => p.includes('additionalProperties')).length).toBe(2);
  });
});

/**
 * A router that refuses what OpenRouter refuses. It reads the request the
 * product actually built, so this covers the wiring as well as the schema.
 */
function strictRouter(seen: { body: unknown }): GatewayTransport {
  return {
    async post(body) {
      seen.body = body;
      const sent = body as { response_format?: { json_schema?: { strict?: boolean; schema?: unknown } } };
      const format = sent.response_format?.json_schema;
      if (format?.strict) {
        const problems = strictSchemaProblems(format.schema);
        if (problems.length > 0) {
          return {
            status: 400,
            json: { error: { message: 'Invalid schema for response_format', metadata: { raw: problems[0] } } },
          };
        }
      }
      return {
        status: 200,
        json: {
          id: 'gen-strict',
          choices: [{ message: { content: '{"scenarios":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
        },
      };
    },
  };
}

describe('the creator call against a router that enforces strict', () => {
  const call = (schema: unknown, seen: { body: unknown }) =>
    callModel(
      {
        pin_id: CREATOR_PIN,
        messages: [{ role: 'user', content: 'write six scenarios' }],
        max_tokens: 8192,
        response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
        caller: { kind: 'creator' },
      },
      { apiKey: 'sk-or-test', transport: strictRouter(seen), sleep: async () => undefined },
    );

  it('is accepted with the schemas the product ships today', async () => {
    const seen = { body: null as unknown };
    const result = await call(scenarioJsonSchema(6), seen);
    expect(result.error).toBeUndefined();
    // And the body is what we expect on the wire: pinned model, one provider,
    // no fallbacks.
    const body = seen.body as { model: string; provider: { only: string[]; allow_fallbacks: boolean } };
    expect(body.model).toContain('/');
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.provider.only.length).toBe(1);
  });

  it('reports the router\'s own reason on a 400 rather than just the status', async () => {
    const seen = { body: null as unknown };
    const result = await call(
      { type: 'object', properties: { a: { type: 'array', minItems: 1 } }, required: ['a'], additionalProperties: false },
      seen,
    );
    expect(result.error?.kind).toBe('provider_error');
    // The whole point: the message has to name the cause and the model.
    expect(result.error?.message).toContain('400');
    expect(result.error?.message).toContain('Invalid schema');
    expect(result.error?.message).toContain('minItems');
  });

  it('does not burn four attempts on a request that is malformed', async () => {
    const attempts: number[] = [];
    const seen = { body: null as unknown };
    await callModel(
      {
        pin_id: CREATOR_PIN,
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 128,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', strict: true, schema: { type: 'object', properties: { a: { type: 'array', maxItems: 2 } }, required: ['a'], additionalProperties: false } },
        },
        caller: { kind: 'creator' },
      },
      {
        apiKey: 'sk-or-test',
        transport: strictRouter(seen),
        sleep: async () => undefined,
        recorder: async (row) => {
          attempts.push(row.attempt_no);
        },
      },
    );
    // A 400 is a bug in the request, not weather: retrying it is pure waste.
    expect(attempts).toEqual([1]);
  });
});
