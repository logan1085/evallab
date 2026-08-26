/**
 * Key resolution is product behavior: one OpenRouter key must yield the whole
 * family spread, and nothing may report itself as real when no key exists.
 *
 * There is deliberately no per-vendor key path any more. A direct call skips
 * callModel, and skipping callModel means no version pin, no model_call row,
 * no spend ceiling and no typed error, so the more keys were set the less the
 * product could account for itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { availableFamilies } from '../server/panelists.js';
import { resolveScenarist } from '../server/scenarist.js';
import { resolveDrafter } from '../server/drafter.js';
import { resolveProvider } from '../server/judge.js';

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

function setKeys(keys: Partial<Record<string, string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(keys)) process.env[k] = v;
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('family resolution', () => {
  it('no key: one offline family, not real', () => {
    setKeys({});
    const fams = availableFamilies();
    expect(fams.map((f) => f.family)).toEqual(['offline']);
    expect(fams[0]!.real).toBe(false);
  });

  it('one OpenRouter key yields every family, all real, all distinct models', () => {
    setKeys({ OPENROUTER_API_KEY: 'or-test' });
    const fams = availableFamilies();
    expect(fams.length).toBeGreaterThanOrEqual(5);
    expect(fams.every((f) => f.real)).toBe(true);
    expect(new Set(fams.map((f) => f.family)).size).toBe(fams.length);
    expect(fams.every((f) => f.model.includes('/'))).toBe(true); // OpenRouter slugs
  });

  it('a stray vendor key changes nothing, because there is no direct path to win', () => {
    setKeys({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(availableFamilies().map((f) => f.family)).toEqual(['offline']);

    setKeys({ ANTHROPIC_API_KEY: 'sk-test', OPENROUTER_API_KEY: 'or-test' });
    const fams = availableFamilies();
    // Every seat still runs on a pinned OpenRouter slug, telemetry and all.
    expect(fams.every((f) => f.model.includes('/'))).toBe(true);
  });

  it('every creator path is real through OpenRouter alone, and honest without it', () => {
    setKeys({ OPENROUTER_API_KEY: 'or-test' });
    expect(resolveScenarist().real).toBe(true);
    expect(resolveDrafter().real).toBe(true);
    expect(resolveProvider().real).toBe(true);

    setKeys({});
    expect(resolveScenarist().real).toBe(false);
    expect(resolveDrafter().real).toBe(false);
    expect(resolveProvider().real).toBe(false);
  });
});
