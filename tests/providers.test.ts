/**
 * Key resolution is product behavior: one OpenRouter key must yield the
 * three-family spread, direct keys must win their family, and nothing real
 * must ever be reported when no key exists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { availableFamilies } from '../server/panelists.js';
import { resolveScenarist } from '../server/scenarist.js';

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
  it('no keys: one offline family, not real', () => {
    setKeys({});
    const fams = availableFamilies();
    expect(fams.map((f) => f.family)).toEqual(['offline']);
    expect(fams[0]!.real).toBe(false);
  });

  it('one OpenRouter key yields all three families, all real', () => {
    setKeys({ OPENROUTER_API_KEY: 'or-test' });
    const fams = availableFamilies();
    expect(fams.map((f) => f.family).sort()).toEqual(['anthropic', 'google', 'openai']);
    expect(fams.every((f) => f.real)).toBe(true);
    expect(fams.every((f) => f.model.includes('/'))).toBe(true); // OpenRouter slugs
  });

  it('a direct key wins its family; OpenRouter fills the rest', () => {
    setKeys({ ANTHROPIC_API_KEY: 'sk-test', OPENROUTER_API_KEY: 'or-test' });
    const fams = availableFamilies();
    expect(fams.map((f) => f.family).sort()).toEqual(['anthropic', 'google', 'openai']);
    const anthropic = fams.find((f) => f.family === 'anthropic')!;
    expect(anthropic.model.includes('/')).toBe(false); // direct model id, not a slug
  });

  it('the scenarist is real through OpenRouter alone', () => {
    setKeys({ OPENROUTER_API_KEY: 'or-test' });
    expect(resolveScenarist().real).toBe(true);
    setKeys({});
    expect(resolveScenarist().real).toBe(false);
  });
});
