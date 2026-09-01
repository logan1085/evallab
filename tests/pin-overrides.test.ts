/**
 * A stale pin is an env var away from fixed.
 *
 * Production found a Mistral slug unlisted after a deploy; the fix should be
 * a variable and a redeploy, not a code change waiting on a review. These
 * pin down what the override may and may not do: move the model id, keep
 * the seat, refuse aliases.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PIN_REGISTRY, applyPinOverrides, pinEnvKey, resolvePin } from '../server/pins.js';

const snapshot = PIN_REGISTRY.map((p) => ({ ...p }));

afterEach(() => {
  for (const [i, pin] of PIN_REGISTRY.entries()) Object.assign(pin, snapshot[i]);
});

describe('pin overrides from the environment', () => {
  it('names the key after the pin id', () => {
    expect(pinEnvKey('mistral-small-1')).toBe('GR_PIN_MISTRAL_SMALL_1');
    expect(pinEnvKey('anthropic-frontier-1')).toBe('GR_PIN_ANTHROPIC_FRONTIER_1');
  });

  it('moves the model id and nothing else, and reports what it did', () => {
    const before = { ...resolvePin('mistral-small-1') };
    const applied = applyPinOverrides({ GR_PIN_MISTRAL_SMALL_1: 'mistralai/mistral-nemo' });
    const after = resolvePin('mistral-small-1');
    expect(applied).toEqual([{ pin_id: 'mistral-small-1', from: before.openrouter_model_id, to: 'mistralai/mistral-nemo' }]);
    expect(after.openrouter_model_id).toBe('mistralai/mistral-nemo');
    expect(after.family).toBe(before.family);
    expect(after.tier).toBe(before.tier);
    expect(after.provider_slug).toBe(before.provider_slug);
    expect(after.cost_hint).toBe(before.cost_hint);
  });

  it('brings a stood-down seat back, since the point is to replace a dead id', () => {
    resolvePin('mistral-small-1').status = 'deprecated';
    applyPinOverrides({ GR_PIN_MISTRAL_SMALL_1: 'mistralai/mistral-nemo' });
    expect(resolvePin('mistral-small-1').status).toBe('live');
  });

  it('refuses aliases and bare names, and leaves the pin alone', () => {
    const before = resolvePin('mistral-small-1').openrouter_model_id;
    expect(applyPinOverrides({ GR_PIN_MISTRAL_SMALL_1: 'mistralai/mistral-small:latest' })).toEqual([]);
    expect(applyPinOverrides({ GR_PIN_MISTRAL_SMALL_1: 'mistral-nemo' })).toEqual([]);
    expect(resolvePin('mistral-small-1').openrouter_model_id).toBe(before);
  });

  it('is a no-op for unset, blank, or identical values', () => {
    const current = resolvePin('openai-small-1').openrouter_model_id;
    expect(applyPinOverrides({})).toEqual([]);
    expect(applyPinOverrides({ GR_PIN_OPENAI_SMALL_1: '  ' })).toEqual([]);
    expect(applyPinOverrides({ GR_PIN_OPENAI_SMALL_1: current })).toEqual([]);
  });
});
