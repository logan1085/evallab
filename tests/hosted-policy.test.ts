import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { configuredModelKey, liveModelsEnabled } from '../server/model-policy.js';
import { callModel } from '../server/gateway.js';
import { createApp } from '../server/app.js';
import { testDb } from './helpers.js';
import { sealSecret } from '../server/secrets.js';
const keys = ['VERCEL', 'OPENROUTER_API_KEY', 'GR_ENABLE_LIVE_MODE', 'GR_ROUND_COST_CEILING_CREDITS', 'GR_DAILY_COST_CEILING_CREDITS', 'GR_SECRET'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.VERCEL = '1'; process.env.OPENROUTER_API_KEY = 'fake-key';
});
afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
describe('hosted safe defaults', () => {
  it('keeps an existing server key dormant until live mode and both ceilings are explicit', () => {
    expect(configuredModelKey()).toBeUndefined();
    process.env.GR_ENABLE_LIVE_MODE = 'true';
    expect(liveModelsEnabled()).toBe(false);
    process.env.GR_DAILY_COST_CEILING_CREDITS = '5';
    process.env.GR_ROUND_COST_CEILING_CREDITS = '1';
    expect(configuredModelKey()).toBe('fake-key');
    process.env.GR_DAILY_COST_CEILING_CREDITS = 'Infinity';
    expect(liveModelsEnabled()).toBe(false);
  });
  it('blocks arbitrary endpoints and direct calls before any transport can run', async () => {
    let calls = 0;
    const transport = { post: async () => { calls++; throw new Error('Should not call'); } };
    const base = { pin_id: 'mistral-small-1', messages: [{ role: 'user' as const, content: 'test' }], caller: { kind: 'grader' as const } };
    const normal = await callModel(base, { apiKey: 'fake-key', transport });
    expect(normal.error?.kind).toBe('auth');
    const own = await callModel({ ...base, endpoint: { id: 'x', name: 'x', base_url: 'http://127.0.0.1', model: 'x', api_key: null } }, { transport });
    expect(own.error?.message).toMatch(/self-hosted/);
    expect(calls).toBe(0);
  });
  it('rejects custom endpoint registration and checking on the hosted API', async () => {
    const app = createApp(await testDb());
    const { project } = (await request(app).post('/api/projects').send({ name: 'Fictional QA' }).expect(201)).body;
    await request(app).post(`/api/projects/${project.slug}/endpoints`).set('x-gr-token', project.token).send({ name: 'internal', base_url: 'http://localhost', model: 'x' }).expect(403);
    await request(app).post(`/api/projects/${project.slug}/endpoints/any/check`).set('x-gr-token', project.token).expect(403);
  });
  it('will not encrypt credentials with a public development phrase in production', () => {
    expect(() => sealSecret('fake-secret')).toThrow(/GR_SECRET/);
  });
});
