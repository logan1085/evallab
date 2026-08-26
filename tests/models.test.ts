/**
 * Every model call goes through the router, and the panel is genuinely many
 * families. Both claims are load-bearing for the product's pitch, so both are
 * checked here rather than trusted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { testDb } from './helpers.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PIN_REGISTRY, cheapestPin, pinIsVersionSafe, pinsByFamily, resolvePin } from '../server/pins.js';
import { availableFamilies } from '../server/panelists.js';
import { resolveDrafter } from '../server/drafter.js';
import { resolveProvider } from '../server/judge.js';
import { resolveScenarist } from '../server/scenarist.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('one router, no side doors', () => {
  it('has no direct provider SDK or endpoint left in the server', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(`${root}server`).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(`${root}server/${file}`, 'utf8');
      // The gateway is the one place allowed to name a provider host.
      if (file === 'gateway.ts') continue;
      if (/@anthropic-ai\/sdk|api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com/.test(src)) {
        offenders.push(file);
      }
    }
    // A call that skips callModel skips the pin, the model_call row, the spend
    // ceiling and the typed error: the product stops being able to account for
    // itself exactly where it spends money.
    expect(offenders).toEqual([]);
  });

  it('reads only OPENROUTER_API_KEY, never a per-vendor key', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(`${root}server`).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(`${root}server/${file}`, 'utf8');
      if (/ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('falls back to the labeled simulation with no key, and says it is not real', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const families = availableFamilies();
      expect(families.length).toBe(1);
      expect(families[0]!.real).toBe(false);
      expect(families[0]!.model).toBe('simulated');
      expect(resolveDrafter().real).toBe(false);
      expect(resolveProvider().real).toBe(false);
      expect(resolveScenarist().real).toBe(false);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('turns one key into every family, so the panel is not one model six times', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      const families = availableFamilies();
      // Five is the number the panel needs: six seats, and only the sixth
      // repeats a family.
      expect(families.length).toBeGreaterThanOrEqual(5);
      expect(new Set(families.map((f) => f.family)).size).toBe(families.length);
      expect(new Set(families.map((f) => f.model)).size).toBe(families.length);
      expect(families.every((f) => f.real)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

describe('the pin registry', () => {
  it('pins an explicit version for every entry, never a latest-alias', () => {
    for (const pin of PIN_REGISTRY) {
      expect(pinIsVersionSafe(pin), pin.pin_id).toBe(true);
    }
  });

  it('offers at least five live families at the grading tier', () => {
    expect(pinsByFamily('small').size).toBeGreaterThanOrEqual(5);
  });

  it('orders families cheapest first, so the literalist takes the cheapest seat', () => {
    const costs = [...pinsByFamily('small').values()].map((p) => p.cost_hint);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    // The literalist is seat zero, and seat zero takes families[0].
    expect([...pinsByFamily('small').values()][0]!.pin_id).toBe(cheapestPin('small').pin_id);
  });

  it('refuses a model string that is not a pin', () => {
    expect(() => resolvePin('anthropic/claude-3-5-sonnet')).toThrow(/No pin/);
  });
});

describe('seating with a key, without a network', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  it('gives every seat its own family and the literalist the cheapest', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const db = await testDb();
    const app = createApp(db);
    const { project } = (
      await request(app).post('/api/v1/projects').send({
        name: 'Spread',
        description: 'A support agent that answers billing questions and can refund up to $50.',
      }).expect(201)
    ).body;

    // The writer's model call cannot reach a network here, so seating falls
    // back to the generic bench: the point under test is the assignment, and
    // the fallback path is the one a router hiccup takes in production.
    const seated = (
      await request(app)
        .post(`/api/v1/projects/${project.slug}/panel`)
        .set('authorization', `Bearer ${project.token}`)
        .expect(201)
    ).body;

    expect(seated.seats.length).toBe(6);
    expect(seated.seats[0].name).toBe('The literalist');
    // Cheapest family first, and the literalist is seat zero.
    expect(seated.seats[0].model).toBe(cheapestPin('small').openrouter_model_id);
    // Five distinct families over six seats: only the sixth repeats.
    const families = seated.seats.map((s: { family: string }) => s.family);
    expect(new Set(families).size).toBeGreaterThanOrEqual(5);
    expect(seated.seats.every((s: { model: string }) => s.model.includes('/'))).toBe(true);
  }, 20_000);
});
