/**
 * The scenario write as a job.
 *
 * Production cut the scenario request off at the edge with no response, so
 * a write that took twenty seconds lost everything. What these pin: the
 * job is created in one fast request; the run streams a heartbeat and a
 * line per part, and persists each part the moment it lands; the job can
 * be read by polling; a part that fails is named and a second run reruns
 * only that part; and a finished job answers without running again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { testDb } from './helpers.js';
import { resetPinRegistry } from '../server/pins.js';
import type { GatewayTransport } from '../server/gateway.js';

const listFetch = (async () =>
  new Response(
    JSON.stringify({
      data: ['anthropic/claude-opus-5', 'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat-v3-0324', 'mistralai/mistral-small-3.2-24b-instruct'].map((id) => ({ id })),
    }),
    { status: 200 },
  )) as unknown as typeof fetch;

/**
 * Answers each part with its count; fails the parts named for their first
 * four calls (the gateway's whole retry budget) so the part fails once,
 * then succeeds, unless `always`.
 */
function writer(failParts: number[], always = false) {
  const calls = new Map<number, number>();
  const transport: GatewayTransport = {
    async post(body) {
      const b = body as { messages: { role: string; content: string }[] };
      const user = b.messages.find((m) => m.role === 'user')?.content ?? '';
      const part = Number(/part (\d+) of/.exec(user)?.[1] ?? 0);
      const count = Number(/Write (\d+) scenarios/.exec(user)?.[1] ?? 0);
      const n = (calls.get(part) ?? 0) + 1;
      calls.set(part, n);
      if (failParts.includes(part) && (always || n <= 4)) {
        return { status: 500, json: { error: { message: 'upstream overloaded' } } };
      }
      const scenarios = Array.from({ length: count }, (_, i) => ({ title: `Part ${part} case ${i + 1}`, content: `A situation for part ${part}, number ${i + 1}.`, probe: 'What it finds out.' }));
      return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ scenarios }) } }], usage: { completion_tokens: 200 } } };
    },
  };
  return transport;
}

const lines = (text: string) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

/** supertest does not buffer x-ndjson on its own; collect the stream as text. */
const ndjsonText = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: string) => void) => {
  let data = '';
  res.on('data', (chunk: Buffer | string) => (data += chunk.toString()));
  res.on('end', () => cb(null, data));
};

describe('scenario jobs', () => {
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

  async function project(transport: GatewayTransport) {
    const app = createApp(await testDb(), { pinFetch: listFetch, creatorGateway: { transport, sleep: async () => undefined } });
    const created = await request(app).post('/api/v1/projects').send({ name: 'Jobs', description: 'A support agent for a bike shop.', limits: '' }).expect(201);
    return { app, slug: created.body.project.slug as string, auth: { 'x-gr-token': created.body.project.token as string } };
  }

  it('creates fast, streams parts as they land, and persists each part', async () => {
    const { app, slug, auth } = await project(writer([]));
    const created = await request(app).post(`/api/v1/projects/${slug}/scenario-jobs`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(202);
    const job = created.body.job;
    expect(job.status).toBe('pending');
    expect(job.parts.map((p: { count: number }) => p.count)).toEqual([4, 4, 4]);
    expect(created.body.provider.real).toBe(true);

    const run = await request(app).post(`/api/v1/projects/${slug}/scenario-jobs/${job.id}/run`).set(auth).buffer(true).parse(ndjsonText as unknown as (str: string) => unknown).expect(200);
    expect(run.headers['content-type']).toMatch(/x-ndjson/);
    const out = lines(run.body as string);
    expect(out.filter((l) => l.part)).toHaveLength(3);
    const last = out.at(-1)!;
    expect(last.done).toBe(true);
    const finished = last.job as { status: string; scenarios: number; failed: string[] };
    expect(finished.status).toBe('done');
    expect(finished.scenarios).toBe(12);
    expect(finished.failed).toEqual([]);

    const read = await request(app).get(`/api/v1/projects/${slug}/scenario-jobs/${job.id}`).set(auth).expect(200);
    expect(read.body.job.status).toBe('done');
    const view = await request(app).get(`/api/v1/projects/${slug}/traces`).set(auth).expect(200);
    expect(view.body.traces).toHaveLength(12);
    expect(view.body.traces.every((t: { meta: { job: string } }) => t.meta.job === job.id)).toBe(true);

    // Running a finished job answers at once, as JSON, without writing again.
    const again = await request(app).post(`/api/v1/projects/${slug}/scenario-jobs/${job.id}/run`).set(auth).expect(200);
    expect(again.body.done).toBe(true);
    expect((await request(app).get(`/api/v1/projects/${slug}/traces`).set(auth)).body.traces).toHaveLength(12);
  });

  it('names a failed part, keeps the others, and a second run reruns only the failed one', async () => {
    const { app, slug, auth } = await project(writer([2]));
    const job = (await request(app).post(`/api/v1/projects/${slug}/scenario-jobs`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(202)).body.job;
    const first = lines((await request(app).post(`/api/v1/projects/${slug}/scenario-jobs/${job.id}/run?mode=json`).set(auth).expect(200)).text);
    const j1 = first[0]!.job as { status: string; scenarios: number; failed: string[]; parts: { status: string }[] };
    expect(j1.status).toBe('failed');
    expect(j1.scenarios).toBe(8);
    expect(j1.failed).toEqual([expect.stringMatching(/^part 2 of 3: Model call failed/)]);
    expect((await request(app).get(`/api/v1/projects/${slug}/traces`).set(auth)).body.traces).toHaveLength(8);

    const second = await request(app).post(`/api/v1/projects/${slug}/scenario-jobs/${job.id}/run?mode=json`).set(auth).expect(200);
    expect(second.body.job.status).toBe('done');
    expect(second.body.job.scenarios).toBe(12);
    expect(second.body.job.failed).toEqual([]);
    // Parts 1 and 3 were not written again.
    expect((await request(app).get(`/api/v1/projects/${slug}/traces`).set(auth)).body.traces).toHaveLength(12);
  });

  it('answers 502 in JSON mode when every part fails, and 404 for a job on another project', async () => {
    const { app, slug, auth } = await project(writer([1, 2, 3], true));
    const job = (await request(app).post(`/api/v1/projects/${slug}/scenario-jobs`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(202)).body.job;
    const run = await request(app).post(`/api/v1/projects/${slug}/scenario-jobs/${job.id}/run?mode=json`).set(auth).expect(502);
    expect(run.body.job.failed).toHaveLength(3);
    await request(app).get(`/api/v1/projects/${slug}/scenario-jobs/nope`).set(auth).expect(404);
    await request(app).post(`/api/v1/projects/${slug}/scenario-jobs`).send({ description: 'A support agent for a bike shop.' }).expect(401);
  });

  it('runs the simulation the same way with no key', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { app, slug, auth } = await project(writer([]));
    const job = (await request(app).post(`/api/v1/projects/${slug}/scenario-jobs`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.', count: 6 }).expect(202)).body.job;
    const run = await request(app).post(`/api/v1/projects/${slug}/scenario-jobs/${job.id}/run?mode=json`).set(auth).expect(200);
    expect(run.body.job.status).toBe('done');
    expect(run.body.job.scenarios).toBeGreaterThanOrEqual(4);
  });
});
