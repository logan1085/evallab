/** Operator canaries are explicit; the public health endpoint never spends credits. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { writerCheck } from '../server/openrouter.js';
import type { GatewayTransport } from '../server/gateway.js';

const reply = (json: unknown): GatewayTransport => ({ post: async () => ({ status: 200, json }) });
const good = reply({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { completion_tokens: 4 } });
const dead = reply({ error: { message: 'No endpoints found for anthropic/claude-opus-5', code: 404 } });
const html = reply({ non_json_body: '<html>upstream connect error</html>', content_type: 'text/html' });

/** A model list that carries every registry id, so the list check passes. */
const listFetch = (async () =>
  new Response(
    JSON.stringify({
      data: [
        'anthropic/claude-opus-5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini',
        'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat-v3-0324',
        'mistralai/mistral-small-3.2-24b-instruct',
      ].map((id) => ({ id })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;

describe('writerCheck', () => {
  it('reports a working writer with its pins named', async () => {
    const w = await writerCheck({ apiKey: 'k', transport: good });
    expect(w.ok).toBe(true);
    expect(w.error).toBeNull();
    expect(w.model).toBe('anthropic/claude-opus-5');
    expect(w.repair_model).toBeTruthy();
  });

  it('reports a dead writer in the router’s words', async () => {
    const w = await writerCheck({ apiKey: 'k', transport: dead });
    expect(w.ok).toBe(false);
    expect(w.error).toContain('No endpoints found');
  });

  it('reports a non-JSON body as what it was', async () => {
    const w = await writerCheck({ apiKey: 'k', transport: html });
    expect(w.ok).toBe(false);
    expect(w.error).toContain('not JSON (text/html)');
    expect(w.error).toContain('upstream connect error');
  });
});

describe('/api/health is read-only', () => {
  let db: DB;
  const before = process.env.OPENROUTER_API_KEY;
  beforeEach(async () => { db = await testDb(); process.env.OPENROUTER_API_KEY = 'test-key'; });
  afterEach(() => {
    if (before === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before;
  });
  it('does not call a writer or model-list endpoint, even across repeated probes', async () => {
    let calls = 0;
    const transport: GatewayTransport = { post: async () => { calls++; throw new Error('Must not call a model'); } };
    const pinFetch = (async () => { calls++; throw new Error('Must not fetch pins'); }) as typeof fetch;
    const app = createApp(db, { pinFetch, writerGateway: { transport } });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/v1/health').expect(200);
      expect(res.body.modelProbe).toBe('not-run');
      expect(res.body.mode).toBe('live');
      expect(res.body.writer).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it('says why a hosted deployment is simulated, variable by variable, and what a visitor can do', async () => {
    const saved = { VERCEL: process.env.VERCEL, GR_ENABLE_LIVE_MODE: process.env.GR_ENABLE_LIVE_MODE };
    process.env.VERCEL = '1';
    delete process.env.GR_ENABLE_LIVE_MODE;
    try {
      // 503 here: a hosted deployment with no DATABASE_URL is not ok, and
      // this test's database is the in-memory one. The mode report is the
      // point, and it is there either way.
      const res = await request(createApp(db)).get('/api/v1/health').expect(503);
      expect(res.body.mode).toBe('simulated');
      expect(res.body.live).toEqual({
        hosted: true,
        enabled: false,
        reasons: ['GR_ENABLE_LIVE_MODE is not "true"', 'GR_DAILY_COST_CEILING_CREDITS is not a positive number', 'GR_ROUND_COST_CEILING_CREDITS is not a positive number'],
      });
      expect(res.body.capabilities).toEqual({ liveModels: false, ownEndpoints: false });
      // A probe on a simulated deployment is a no-op, never a model call.
      const probed = await request(createApp(db)).get('/api/v1/health?probe=writer').expect(503);
      expect(probed.body.modelProbe).toBe('not-run');
    } finally {
      if (saved.VERCEL === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = saved.VERCEL;
      if (saved.GR_ENABLE_LIVE_MODE === undefined) delete process.env.GR_ENABLE_LIVE_MODE;
      else process.env.GR_ENABLE_LIVE_MODE = saved.GR_ENABLE_LIVE_MODE;
    }
  });

  it('runs the free pin check on ?probe=pins and the paid writer canary only on ?probe=writer, in live mode', async () => {
    let posts = 0;
    let lists = 0;
    const transport: GatewayTransport = {
      post: async () => {
        posts++;
        return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { completion_tokens: 4 } } };
      },
    };
    const pinFetch = (async (...args: Parameters<typeof fetch>) => {
      lists++;
      return listFetch(...args);
    }) as typeof fetch;
    const app = createApp(db, { pinFetch, writerGateway: { transport } });

    const pins = await request(app).get('/api/v1/health?probe=pins').expect(200);
    expect(pins.body.modelProbe).toBe('pins');
    expect(pins.body.pins.ok).toBe(true);
    expect(pins.body.writer).toBeUndefined();
    expect([lists, posts]).toEqual([1, 0]);

    const writer = await request(app).get('/api/v1/health?probe=writer').expect(200);
    expect(writer.body.modelProbe).toBe('writer');
    expect(writer.body.writer.ok).toBe(true);
    expect(writer.body.writer.model).toBe('anthropic/claude-opus-5');
    expect([lists, posts]).toEqual([1, 1]);

    // Cached: a second writer probe inside the window costs nothing.
    await request(app).get('/api/v1/health?probe=writer').expect(200);
    expect(posts).toBe(1);
    // The plain probe is still silent.
    const plain = await request(app).get('/api/v1/health').expect(200);
    expect(plain.body.modelProbe).toBe('not-run');
    expect(plain.body.live).toEqual({ hosted: false, enabled: true, reasons: [] });
  });

  it('fails health on ?probe=writer when the writer cannot answer, in the router’s words', async () => {
    const app = createApp(db, { pinFetch: listFetch, writerGateway: { transport: dead } });
    const res = await request(app).get('/api/v1/health?probe=writer').expect(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.writer.error).toContain('No endpoints found');
  });
});
