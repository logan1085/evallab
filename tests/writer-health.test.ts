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
});
