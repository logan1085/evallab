/**
 * /api/health said pins.ok=true while onboarding failed. A pin on the
 * router's list is not a writer that answers, so health now makes one real
 * call through the writer pin and reports that. These pin the canary and
 * the health contract around it.
 */
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

describe('/api/health validates the writer, not just the list', () => {
  let db: DB;
  const before = process.env.OPENROUTER_API_KEY;

  beforeEach(async () => {
    db = await testDb();
    process.env.OPENROUTER_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before;
  });

  const health = (app: Express) => request(app).get('/api/v1/health');

  it('is ok when the list resolves and the writer answers', async () => {
    const app = createApp(db, { pinFetch: listFetch, writerGateway: { transport: good } });
    const res = await health(app).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pins.ok).toBe(true);
    expect(res.body.writer.ok).toBe(true);
    expect(res.body.writer.model).toBe('anthropic/claude-opus-5');
  });

  it('fails when the writer pin is listed but cannot answer', async () => {
    const app = createApp(db, { pinFetch: listFetch, writerGateway: { transport: dead } });
    const res = await health(app).expect(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.pins.ok).toBe(true);
    expect(res.body.writer.ok).toBe(false);
    expect(res.body.writer.error).toContain('No endpoints found');
  });

  it('lists the live same-namespace ids so a replacement is a verified choice', async () => {
    const app = createApp(db, { pinFetch: listFetch, writerGateway: { transport: dead } });
    const res = await health(app);
    expect(res.body.pins.siblings['anthropic-frontier-1']).toEqual([
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-4.5',
    ]);
  });

  it('makes one canary call per probe burst, not one per request', async () => {
    let calls = 0;
    const counting: GatewayTransport = {
      post: async () => {
        calls++;
        return { status: 200, json: { choices: [{ message: { content: '{"ok":true}' } }] } };
      },
    };
    const app = createApp(db, { pinFetch: listFetch, writerGateway: { transport: counting } });
    await Promise.all([health(app), health(app), health(app)]);
    await health(app);
    expect(calls).toBe(1);
  });
});
