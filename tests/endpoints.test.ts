/**
 * A company's own model in a seat.
 *
 * What these pin: the key is sealed and never comes back; a check is one
 * real call to the endpoint's own URL with its own key; a seat moved onto
 * the endpoint grades through the same gateway with the same rows; the
 * pinned model map names the endpoint; and an endpoint in use cannot be
 * removed out from under its seat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { callModel, resetLearnedCapabilities, type GatewayTransport } from '../server/gateway.js';
import { openSecret, sealSecret, SealError, keyHint } from '../server/secrets.js';

interface Seen {
  url: string | undefined;
  apiKey: string;
  body: Record<string, unknown>;
}

/** An OpenAI-shaped endpoint that answers every request with one JSON reply. */
function endpointTransport(reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const transport: GatewayTransport = {
    async post(body, apiKey, url) {
      seen.push({ url, apiKey, body: body as Record<string, unknown> });
      return reply(body as Record<string, unknown>);
    },
  };
  return { transport, seen };
}

const okReply = (content: string) => ({
  status: 200,
  json: { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
});

describe('sealed secrets', () => {
  const before = process.env.GR_SECRET;
  afterEach(() => {
    if (before === undefined) delete process.env.GR_SECRET;
    else process.env.GR_SECRET = before;
  });

  it('round-trips under one secret and refuses under another', () => {
    process.env.GR_SECRET = 'first';
    const sealed = sealSecret('sk-live-abcd1234');
    expect(sealed).not.toContain('abcd1234');
    expect(openSecret(sealed)).toBe('sk-live-abcd1234');
    expect(keyHint('sk-live-abcd1234')).toBe('…1234');
    process.env.GR_SECRET = 'second';
    expect(() => openSecret(sealed)).toThrow(SealError);
  });
});

describe('the gateway with an endpoint of the company’s own', () => {
  beforeEach(() => resetLearnedCapabilities());

  const endpoint = { id: 'ep1', name: 'our fine-tune', base_url: 'https://llm.example.com/v1/', model: 'acme-7b', api_key: 'sk-own-9999' };

  it('posts to the endpoint’s URL with its key, no provider lock, and records the call under a byo pin', async () => {
    const { transport, seen } = endpointTransport(() => okReply('{"ok":true}'));
    const attempts: { pin_id: string; model_family: string; openrouter_model_id: string }[] = [];
    const result = await callModel(
      { pin_id: 'byo:ep1', endpoint, messages: [{ role: 'user', content: 'hi' }], caller: { kind: 'grader' } },
      { transport, recorder: async (a) => void attempts.push(a) },
    );
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('{"ok":true}');
    expect(seen[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(seen[0]!.apiKey).toBe('sk-own-9999');
    expect(seen[0]!.body.model).toBe('acme-7b');
    expect(seen[0]!.body).not.toHaveProperty('provider');
    expect(attempts[0]).toMatchObject({ pin_id: 'byo:ep1', model_family: 'endpoint:ep1', openrouter_model_id: 'acme-7b' });
  });

  it('sends no authorization when the endpoint has no key', async () => {
    const { transport, seen } = endpointTransport(() => okReply('x'));
    await callModel({ pin_id: 'byo:ep1', endpoint: { ...endpoint, api_key: null }, messages: [{ role: 'user', content: 'hi' }], caller: { kind: 'grader' } }, { transport });
    expect(seen[0]!.apiKey).toBe('');
  });

  it('steps down from json_schema to plain JSON on the endpoint’s first 400, once', async () => {
    const { transport, seen } = endpointTransport((body) => {
      const fmt = (body.response_format as { type?: string } | undefined)?.type;
      return fmt === 'json_schema' ? { status: 400, json: { error: { message: 'unknown field response_format.json_schema' } } } : okReply('{"verdict":"pass"}');
    });
    const result = await callModel(
      {
        pin_id: 'byo:ep1',
        endpoint,
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'v', strict: true, schema: { type: 'object' } } },
        caller: { kind: 'grader' },
      },
      { transport },
    );
    expect(result.error).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect((seen[1]!.body.response_format as { type: string }).type).toBe('json_object');
  });

  it('names the endpoint, not the router, when it rejects the key', async () => {
    const { transport } = endpointTransport(() => ({ status: 401, json: { error: 'bad key' } }));
    const result = await callModel({ pin_id: 'byo:ep1', endpoint, messages: [{ role: 'user', content: 'hi' }], caller: { kind: 'grader' } }, { transport });
    expect(result.error?.kind).toBe('auth');
    expect(result.error?.message).toContain('our fine-tune');
  });
});

describe('endpoints on a project', () => {
  let app: Express;
  let db: DB;
  let slug: string;
  let auth: Record<string, string>;
  let seen: Seen[];

  beforeEach(async () => {
    resetLearnedCapabilities();
    db = await testDb();
    const t = endpointTransport((body) => {
      const user = (body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')?.content ?? '';
      return user.includes('{"ok": true}')
        ? okReply('{"ok": true}')
        : okReply(JSON.stringify({ verdict: user.includes('$90') ? 'fail' : 'pass', reason: 'Our model read the refund cap as written.' }));
    });
    seen = t.seen;
    app = createApp(db, { endpointGateway: { transport: t.transport } });
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Own Model Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    slug = created.body.project.slug;
    auth = { 'x-gr-token': created.body.project.token };
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
  });

  const body = { name: 'our fine-tune', base_url: 'https://llm.example.com/v1', model: 'acme-support-7b', api_key: 'sk-own-abcd1234' };

  it('registers an endpoint, seals the key, and never returns it', async () => {
    const res = await request(app).post(`/api/v1/projects/${slug}/endpoints`).set(auth).send(body).expect(201);
    expect(res.body.endpoint.keyHint).toBe('…1234');
    expect(res.body.endpoint.hasKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('sk-own');
    const list = await request(app).get(`/api/v1/projects/${slug}/endpoints`).set(auth).expect(200);
    expect(list.body.endpoints).toHaveLength(1);
    expect(list.body.secrets).toMatch(/^(env|dev-default)$/);
    expect(JSON.stringify(list.body)).not.toContain('sk-own');
    // A plain http host that is not localhost is refused; a duplicate name is refused.
    await request(app).post(`/api/v1/projects/${slug}/endpoints`).set(auth).send({ ...body, name: 'plain', base_url: 'http://llm.example.com/v1' }).expect(400);
    await request(app).post(`/api/v1/projects/${slug}/endpoints`).set(auth).send(body).expect(409);
    await request(app).post(`/api/v1/projects/${slug}/endpoints`).send(body).expect(401);
  });

  it('checks an endpoint with one real call to its own URL', async () => {
    const created = await request(app).post(`/api/v1/projects/${slug}/endpoints`).set(auth).send(body).expect(201);
    const res = await request(app).post(`/api/v1/projects/${slug}/endpoints/${created.body.endpoint.id}/check`).set(auth).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.model).toBe('acme-support-7b');
    expect(seen.at(-1)!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(seen.at(-1)!.apiKey).toBe('sk-own-abcd1234');
  });

  it('moves a seat onto the endpoint, grades through it, pins it, and moves the seat back', async () => {
    const created = await request(app).post(`/api/v1/projects/${slug}/endpoints`).set(auth).send(body).expect(201);
    const endpointId = created.body.endpoint.id as string;
    const seats = (await request(app).get(`/api/v1/projects/${slug}`).set(auth).expect(200)).body.graders.filter(
      (g: { kind: string }) => g.kind === 'panelist',
    ) as { id: string; name: string; family: string }[];
    const seat = seats.find((s) => !/literalist/i.test(s.name))!;

    const moved = await request(app).patch(`/api/v1/projects/${slug}/panel/seats/${seat.id}`).set(auth).send({ endpointId }).expect(200);
    expect(moved.body.seat.family).toBe(`endpoint:${endpointId}`);
    expect(moved.body.seat.model).toBe('acme-support-7b');
    expect((await request(app).get(`/api/v1/projects/${slug}/endpoints`).set(auth)).body.endpoints[0].seats).toEqual([seat.name]);
    // In use: cannot be removed.
    await request(app).delete(`/api/v1/projects/${slug}/endpoints/${endpointId}`).set(auth).expect(409);

    await request(app)
      .post(`/api/v1/projects/${slug}/traces`)
      .set(auth)
      .send({ traces: [
        { title: 'Refund under the cap', content: 'USER: refund my $30 order. ASSISTANT: Done, $30 refunded.' },
        { title: 'Refund over the cap', content: 'USER: refund my $90 order. ASSISTANT: I have refunded $90.' },
      ] })
      .expect(201);
    const round = await request(app).post(`/api/v1/projects/${slug}/panel-rounds`).set(auth).expect(201);
    const roundId = round.body.round.id as string;
    const callsBefore = seen.length;
    await request(app).post(`/api/v1/rounds/${roundId}/panel-run`).set(auth).send({ seatId: seat.id }).expect(200);
    // Two cases, plus the self-consistency re-ask the round makes of every seat.
    expect(seen.length - callsBefore).toBeGreaterThanOrEqual(2);
    for (const call of seen.slice(callsBefore)) {
      expect(call.url).toBe('https://llm.example.com/v1/chat/completions');
      expect(call.body.model).toBe('acme-support-7b');
    }
    for (const s of seats.filter((x) => x.id !== seat.id)) {
      await request(app).post(`/api/v1/rounds/${roundId}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    }
    const map = await request(app).get(`/api/v1/rounds/${roundId}/map`).set(auth).expect(200);
    expect(map.body.pinnedModels[seat.name]).toBe(`endpoint:${endpointId}:acme-support-7b`);
    // One real seat among simulated ones: the map is no longer the pure simulation.
    expect(map.body.simulated).toBe(false);
    const over = map.body.cases.find((c: { title: string }) => c.title === 'Refund over the cap');
    expect(over.votes.find((v: { seatName: string }) => v.seatName === seat.name).verdict).toBe('fail');

    const back = await request(app).patch(`/api/v1/projects/${slug}/panel/seats/${seat.id}`).set(auth).send({ endpointId: null }).expect(200);
    expect(back.body.seat.family).not.toMatch(/^endpoint:/);
    await request(app).delete(`/api/v1/projects/${slug}/endpoints/${endpointId}`).set(auth).expect(204);
    expect((await request(app).get(`/api/v1/projects/${slug}/endpoints`).set(auth)).body.endpoints).toEqual([]);
  });

  it('reports a bad key from the endpoint in the endpoint’s name, and a wrong seat or endpoint as 404', async () => {
    await request(app).post(`/api/v1/projects/${slug}/endpoints/nope/check`).set(auth).expect(404);
    const seats = (await request(app).get(`/api/v1/projects/${slug}`).set(auth)).body.graders as { id: string }[];
    await request(app).patch(`/api/v1/projects/${slug}/panel/seats/${seats[0]!.id}`).set(auth).send({ endpointId: 'nope' }).expect(404);
  });
});
