/**
 * The product's own benchmark, in the suite: delete a clause, run the round,
 * and the decision point the clause settled must resurface with a grounded
 * patch, twice, identically.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURES, runRecovery } from '../scripts/recovery-test.js';

describe('the recovery test', () => {
  it('recovers every fixture with zero stability flips', async () => {
    const results = await runRecovery();
    expect(results).toHaveLength(FIXTURES.length);
    for (const r of results) {
      expect(r.recovered, r.fixture).toBe(true);
      expect(r.stabilityFlips, r.fixture).toBe(0);
    }
  }, 60_000);
});
