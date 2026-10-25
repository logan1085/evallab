/**
 * The simulated writer: what a visitor to the free demo gets instead of six
 * generic stubs. What these pin: twelve scenarios per write, balanced four
 * to a ground; a dialect chosen from the description, with concrete cases
 * in it; the same description writes the same set twice; and a single
 * ground asked for returns only that ground.
 */
import { describe, expect, it } from 'vitest';
import { offlineScenarist } from '../server/scenarist.js';

const write = (description: string, extra: { count?: number; ground?: 'clear' | 'boundary' | 'unimagined' } = {}) =>
  offlineScenarist().write({ description, ...extra });

describe('the simulated scenario writer', () => {
  it('writes twelve, four to a ground, in the dialect of the description', async () => {
    const support = await write('A support agent for an outdoor gear shop that answers order and return questions.');
    expect(support.scenarios).toHaveLength(12);
    const grounds = support.scenarios.map((s) => s.ground);
    expect(grounds.filter((g) => g === 'clear')).toHaveLength(4);
    expect(grounds.filter((g) => g === 'boundary')).toHaveLength(4);
    expect(grounds.filter((g) => g === 'unimagined')).toHaveLength(4);
    expect(support.scenarios.some((s) => /refund/i.test(s.content))).toBe(true);
    expect(new Set(support.scenarios.map((s) => s.title)).size).toBe(12);
    // Every one is judgeable: a transcript or a concrete situation, with a probe.
    for (const s of support.scenarios) {
      expect(s.content.length).toBeGreaterThan(60);
      expect(s.probe.length).toBeGreaterThan(10);
    }
  });

  it('picks the dialect from the description and falls back to the general case', async () => {
    const code = await write('An assistant that reviews pull requests and fixes failing tests in our repo.');
    expect(code.scenarios.some((s) => /test|diff|PR/i.test(s.content))).toBe(true);
    const money = await write('A banking assistant that answers questions about loan payments and disputes.');
    expect(money.scenarios.some((s) => /dispute|balance|\$/.test(s.content))).toBe(true);
    const clinic = await write('A clinic assistant that books and reschedules appointments.');
    expect(clinic.scenarios.some((s) => /appointment|Booked/i.test(s.content))).toBe(true);
    const general = await write('A helper for our internal wiki.');
    expect(general.scenarios.some((s) => s.title === 'Prompt injection in the material')).toBe(true);
  });

  it('is deterministic, honours the count, and serves one ground alone', async () => {
    const a = await write('A support agent for a bike shop.');
    const b = await write('A support agent for a bike shop.');
    expect(a.scenarios).toEqual(b.scenarios);
    expect((await write('A support agent for a bike shop.', { count: 5 })).scenarios).toHaveLength(5);
    const boundary = await write('A support agent for a bike shop.', { count: 4, ground: 'boundary' });
    expect(boundary.scenarios).toHaveLength(4);
    expect(boundary.scenarios.every((s) => s.ground === 'boundary')).toBe(true);
  });
});
