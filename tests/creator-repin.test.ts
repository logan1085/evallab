/**
 * The writer pin repins itself from the router's list.
 *
 * Production found the creator pin's id unlisted, and onboarding failed
 * until a person found a valid slug. What these pin: an unlisted creator
 * pin moves to the newest id in its namespace, chosen from the list the
 * router served; a seat pin never moves, it stands down; with nothing in
 * the namespace the creator falls back to the best live pin; and the
 * first onboarding call on a cold instance runs the check before writing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { testDb } from './helpers.js';
import { pickReplacement, resetPinRegistry, resolvePin, validatePins } from '../server/pins.js';
import { resolveCreatorPin, writerCheck } from '../server/openrouter.js';
import type { GatewayTransport } from '../server/gateway.js';

const listing = (ids: string[]) =>
  (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

const SEATS = ['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat-v3-0324', 'mistralai/mistral-small-3.2-24b-instruct'];

describe('pickReplacement', () => {
  it('takes the newest version in the namespace, opus over sonnet at a tie, skipping variants and free tiers', () => {
    expect(
      pickReplacement(['anthropic/claude-opus-4.1', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.5:thinking', 'anthropic/claude-haiku-4.5', 'anthropic/claude-3.5-sonnet']),
    ).toBe('anthropic/claude-sonnet-4.5');
    expect(pickReplacement(['anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.5'])).toBe('anthropic/claude-opus-4.5');
    expect(pickReplacement(['anthropic/claude-opus-5:free'])).toBeNull();
    expect(pickReplacement([])).toBeNull();
  });
});

describe('validatePins with repinCreators', () => {
  beforeEach(() => resetPinRegistry());
  afterEach(() => resetPinRegistry());

  it('moves an unlisted creator pin to the newest listed id in its namespace and reports it', async () => {
    const result = await validatePins(listing([...SEATS, 'anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.1']), { disableInvalid: true, repinCreators: true });
    expect(result.ok).toBe(true);
    expect(result.disabled).toEqual([]);
    expect(result.repinned).toEqual([{ pin_id: 'anthropic-frontier-1', from: 'anthropic/claude-opus-5', to: 'anthropic/claude-sonnet-4.5' }]);
    expect(resolvePin('anthropic-frontier-1').openrouter_model_id).toBe('anthropic/claude-sonnet-4.5');
    expect(resolvePin('anthropic-frontier-1').status).toBe('live');
    expect(resolveCreatorPin().pin_id).toBe('anthropic-frontier-1');
  });

  it('never moves a seat pin: an unlisted seat stands down and is named', async () => {
    const result = await validatePins(listing([...SEATS.filter((id) => !id.startsWith('mistralai/')), 'mistralai/mistral-medium-3', 'anthropic/claude-opus-5']), { disableInvalid: true, repinCreators: true });
    expect(result.ok).toBe(false);
    expect(result.repinned).toEqual([]);
    expect(result.disabled).toEqual(['mistral-small-1']);
    expect(resolvePin('mistral-small-1').openrouter_model_id).toBe('mistralai/mistral-small-3.2-24b-instruct');
  });

  it('falls back to the best live pin when nothing in the namespace is listed', async () => {
    const result = await validatePins(listing(SEATS.filter((id) => !id.startsWith('anthropic/'))), { disableInvalid: true, repinCreators: true });
    expect(result.disabled).toEqual(expect.arrayContaining(['anthropic-frontier-1', 'anthropic-small-1']));
    const creator = resolveCreatorPin();
    expect(creator.status).toBe('live');
    expect(creator.pin_id).not.toBe('anthropic-frontier-1');
    const good: GatewayTransport = { post: async () => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] } }) };
    const w = await writerCheck({ apiKey: 'k', transport: good });
    expect(w.ok).toBe(true);
    expect(w.pin_id).toBe(creator.pin_id);
  });
});

describe('the first creator call on a cold instance', () => {
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

  it('checks the list and repins before writing, and health reports the repin', async () => {
    let listed = 0;
    const pinFetch = (async () => {
      listed++;
      return new Response(JSON.stringify({ data: [...SEATS, 'anthropic/claude-sonnet-4.5'].map((id) => ({ id })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const good: GatewayTransport = { post: async () => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] } }) };
    const app = createApp(await testDb(), { pinFetch, writerGateway: { transport: good } });
    const created = await request(app).post('/api/v1/projects').send({ name: 'Cold', description: 'A support agent.', limits: '' }).expect(201);
    const { slug, token } = created.body.project;
    // Seating the panel is a creator call. It may fail for want of a real
    // transport; what matters is that the list was consulted first.
    await request(app).post(`/api/v1/projects/${slug}/panel`).set({ 'x-gr-token': token });
    expect(listed).toBe(1);
    expect(resolvePin('anthropic-frontier-1').openrouter_model_id).toBe('anthropic/claude-sonnet-4.5');
    const health = await request(app).get('/api/v1/health');
    expect(listed).toBe(1);
    expect(health.body.pins.repinned).toEqual([{ pin_id: 'anthropic-frontier-1', from: 'anthropic/claude-opus-5', to: 'anthropic/claude-sonnet-4.5' }]);
    expect(health.body.writer.model).toBe('anthropic/claude-sonnet-4.5');
  });
});
