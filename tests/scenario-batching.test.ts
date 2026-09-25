/**
 * The scenario write, in parts.
 *
 * Production: one call for twelve scenarios from a frontier model ran past
 * the 25-second creator deadline every time, its retries were doomed, and
 * the Room sat at zero cases. What these pin: the count splits into three
 * parts by kind of ground; each part is its own call with a deadline sized
 * to its output; a part that fails costs its cases and is named, not the
 * whole write; and only when every part fails does the route say so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { testDb } from './helpers.js';
import { scenarioBatches, buildScenarioUserPrompt } from '../shared/scenarios.js';
import { creatorDeadlineMs } from '../server/openrouter.js';
import { resetPinRegistry } from '../server/pins.js';
import type { GatewayTransport } from '../server/gateway.js';

describe('scenarioBatches', () => {
  it('splits the count into up to three parts, one per kind of ground', () => {
    expect(scenarioBatches(12).map((b) => b.count)).toEqual([4, 4, 4]);
    expect(scenarioBatches(5).map((b) => b.count)).toEqual([2, 2, 1]);
    expect(scenarioBatches(4).map((b) => b.count)).toEqual([2, 1, 1]);
    expect(scenarioBatches(undefined).reduce((n, b) => n + b.count, 0)).toBe(12);
    const [first] = scenarioBatches(12);
    expect(buildScenarioUserPrompt({ description: 'A support agent.' }, first)).toMatch(/part 1 of 3.*Write 4 scenarios, all of this kind: clear cases/);
  });
});

describe('creatorDeadlineMs', () => {
  it('scales with the tokens asked for, between the floor and the ceiling', () => {
    expect(creatorDeadlineMs(300)).toBe(25_000);
    expect(creatorDeadlineMs(2048)).toBe(40_960);
    expect(creatorDeadlineMs(8192)).toBe(120_000);
  });
});

describe('POST /projects/:slug/scenarios with a real writer', () => {
  const before = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    resetPinRegistry();
    process.env.OPENROUTER_API_KEY = 'test-key';
  });
  afterEach(() => {
    resetPinRegistry();
    if (before === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before;
  });

  const listFetch = (async () =>
    new Response(
      JSON.stringify({
        data: ['anthropic/claude-opus-5', 'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat-v3-0324', 'mistralai/mistral-small-3.2-24b-instruct'].map((id) => ({ id })),
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  /** Answers each part with as many scenarios as it asked for; fails the parts named. */
  function writer(failParts: number[]) {
    const seen: { part: number; count: number; maxTokens: number }[] = [];
    const transport: GatewayTransport = {
      async post(body) {
        const b = body as { messages: { role: string; content: string }[]; max_tokens: number };
        const user = b.messages.find((m) => m.role === 'user')?.content ?? '';
        const part = Number(/part (\d+) of/.exec(user)?.[1] ?? 0);
        const count = Number(/Write (\d+) scenarios/.exec(user)?.[1] ?? 0);
        seen.push({ part, count, maxTokens: b.max_tokens });
        if (failParts.includes(part)) return { status: 500, json: { error: { message: 'upstream overloaded' } } };
        const scenarios = Array.from({ length: count }, (_, i) => ({ title: `Part ${part} case ${i + 1}`, content: `A situation for part ${part}, number ${i + 1}.`, probe: 'What it finds out.' }));
        return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ scenarios }) } }], usage: { completion_tokens: 200 } } };
      },
    };
    return { transport, seen };
  }

  async function project(transport: GatewayTransport) {
    const app = createApp(await testDb(), { pinFetch: listFetch, creatorGateway: { transport, sleep: async () => undefined } });
    const created = await request(app).post('/api/v1/projects').send({ name: 'Parts', description: 'A support agent for a bike shop.', limits: '' }).expect(201);
    return { app, slug: created.body.project.slug as string, auth: { 'x-gr-token': created.body.project.token as string } };
  }

  it('writes twelve scenarios as three parallel parts of four, each with a deadline sized to its output', async () => {
    const { transport, seen } = writer([]);
    const { app, slug, auth } = await project(transport);
    const res = await request(app).post(`/api/v1/projects/${slug}/scenarios`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(201);
    expect(res.body.scenarios).toHaveLength(12);
    expect(res.body.parts).toBe(3);
    expect(res.body.failed).toEqual([]);
    expect(res.body.provider.real).toBe(true);
    expect(seen.map((s) => s.part).sort()).toEqual([1, 2, 3]);
    expect(seen.every((s) => s.count === 4 && s.maxTokens === 4500)).toBe(true);
  });

  it('keeps the parts that landed when one fails, and names the one that did not', async () => {
    const { transport } = writer([2]);
    const { app, slug, auth } = await project(transport);
    const res = await request(app).post(`/api/v1/projects/${slug}/scenarios`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(201);
    expect(res.body.scenarios).toHaveLength(8);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0]).toMatch(/^part 2 of 3: Model call failed/);
    expect(res.body.scenarios.every((s: { title: string }) => !s.title.startsWith('Part 2'))).toBe(true);
  });

  it('fails the write only when every part fails, in the gateway’s words', async () => {
    const { transport } = writer([1, 2, 3]);
    const { app, slug, auth } = await project(transport);
    const res = await request(app).post(`/api/v1/projects/${slug}/scenarios`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(502);
    expect(res.body.error).toMatch(/Model call failed/);
  });
});
