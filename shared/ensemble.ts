/**
 * The ensemble verdict: what the mixture says about one case, as one word.
 *
 * Weighted majority over the votes that survived paraphrase, with seat
 * weights (fit to the owner's adjudications) as the weights. Ties go to the
 * lower verdict on the standard's scale: when the panel cannot agree that an
 * answer passes, it does not pass. Abstentions carry no weight.
 */

import { ABSTAIN, type VerdictLevel } from './types.js';

export interface EnsembleVote {
  verdict: string;
  weight: number;
  stable?: boolean;
}

export interface EnsembleResult {
  verdict: string | null;
  /** Share of the counted weight behind the verdict. 1 is unanimous. */
  support: number;
  counted: number;
  setAside: number;
}

export function ensembleVerdict(votes: EnsembleVote[], scale: VerdictLevel[]): EnsembleResult {
  const counted = votes.filter((v) => v.verdict !== ABSTAIN && v.stable !== false && v.weight > 0);
  const setAside = votes.length - counted.length;
  // One vote is an opinion, not an ensemble: a case with fewer than two
  // stable votes has no verdict, which keeps a gate from turning on a single
  // seat that happened to hold still.
  if (counted.length < 2) return { verdict: null, support: 0, counted: counted.length, setAside };
  const weight = new Map<string, number>();
  for (const v of counted) weight.set(v.verdict, (weight.get(v.verdict) ?? 0) + v.weight);
  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  const rank = (id: string) => scale.find((s) => s.id === id)?.rank ?? Number.MAX_SAFE_INTEGER;
  const [best, bestWeight] = [...weight.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))[0]!;
  return { verdict: best, support: total === 0 ? 0 : bestWeight / total, counted: counted.length, setAside };
}

export interface GateSpec {
  pass_rate_min?: number;
  max_new_splits?: number;
}

export interface GateResult {
  spec: GateSpec;
  passed: boolean;
  reasons: string[];
}

/** A gate with nothing in it passes; a gate with a number in it is checked. */
export function evaluateGate(spec: GateSpec, observed: { passRate: number | null; newSplits: number }): GateResult {
  const reasons: string[] = [];
  if (typeof spec.pass_rate_min === 'number') {
    if (observed.passRate === null) reasons.push('pass rate could not be computed: no case had an ensemble verdict');
    else if (observed.passRate < spec.pass_rate_min) {
      reasons.push(`pass rate ${(observed.passRate * 100).toFixed(0)}% is under the gate of ${(spec.pass_rate_min * 100).toFixed(0)}%`);
    }
  }
  if (typeof spec.max_new_splits === 'number' && observed.newSplits > spec.max_new_splits) {
    reasons.push(`${observed.newSplits} new split${observed.newSplits === 1 ? '' : 's'} against a gate of ${spec.max_new_splits}`);
  }
  return { spec, passed: reasons.length === 0, reasons };
}

/** "pass-rate:0.92,new-splits:0" as the CLI writes it. */
export function parseGate(text: string | undefined): GateSpec {
  const spec: GateSpec = {};
  if (!text) return spec;
  for (const part of text.split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (!k || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (k === 'pass-rate' || k === 'pass_rate_min') spec.pass_rate_min = n;
    if (k === 'new-splits' || k === 'max_new_splits') spec.max_new_splits = n;
  }
  return spec;
}
