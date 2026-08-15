/**
 * Sampling.
 *
 * The spec is blunt about this and so is the code: round one is random, round
 * two draws from round one's splits, and neither of those is clever. The
 * sampler is seeded so a round's contents can be re-derived and audited later,
 * and `explain()` returns the sentence the UI shows the user, so the product
 * never implies more sophistication than it has.
 */

import type { ItemArm, SamplingStrategy } from './types.js';

/** Deterministic PRNG. Same seed, same sample, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shuffle<T>(input: readonly T[], seed: string): T[] {
  const rand = mulberry32(seedFrom(seed));
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface SamplePlanInput {
  /** Every trace available in the project. */
  pool: string[];
  strategy: SamplingStrategy;
  /** Trace ids that split in the source round. Only meaningful for from_splits. */
  priorSplitTraceIds?: string[];
  calibrationSize: number;
  heldoutSize: number;
  /** When set, the held-out arm reuses these exact traces so before/after is measured on the same cases. */
  reuseHeldoutTraceIds?: string[];
  seed: string;
}

export interface SamplePlan {
  calibration: string[];
  heldout: string[];
  /** Plain-language description of what the sampler actually did. Rendered verbatim in the UI. */
  explanation: string;
  /** How many calibration slots came from prior splits rather than random fill. */
  fromPriorSplits: number;
}

export function planSample(input: SamplePlanInput): SamplePlan {
  const {
    pool,
    strategy,
    priorSplitTraceIds = [],
    calibrationSize,
    heldoutSize,
    reuseHeldoutTraceIds,
    seed,
  } = input;

  const poolSet = new Set(pool);
  const taken = new Set<string>();

  // Held-out is reserved first so calibration can never eat the measurement set.
  let heldout: string[];
  if (reuseHeldoutTraceIds && reuseHeldoutTraceIds.length > 0) {
    heldout = reuseHeldoutTraceIds.filter((id) => poolSet.has(id));
  } else {
    heldout = shuffle(pool, seed + ':heldout').slice(0, Math.max(0, heldoutSize));
  }
  for (const id of heldout) taken.add(id);

  const available = pool.filter((id) => !taken.has(id));

  let calibration: string[] = [];
  let fromPriorSplits = 0;

  if (strategy === 'from_splits') {
    const carried = shuffle(
      priorSplitTraceIds.filter((id) => poolSet.has(id) && !taken.has(id)),
      seed + ':carry',
    );
    calibration = carried.slice(0, calibrationSize);
    fromPriorSplits = calibration.length;
    for (const id of calibration) taken.add(id);
  }

  if (calibration.length < calibrationSize) {
    const filler = shuffle(
      available.filter((id) => !taken.has(id)),
      seed + ':fill',
    ).slice(0, calibrationSize - calibration.length);
    calibration = [...calibration, ...filler];
  }

  return {
    calibration,
    heldout,
    fromPriorSplits,
    explanation: explain(strategy, fromPriorSplits, calibration.length, heldout.length, !!reuseHeldoutTraceIds?.length),
  };
}

export function explain(
  strategy: SamplingStrategy,
  fromPriorSplits: number,
  calibrationCount: number,
  heldoutCount: number,
  reusedHeldout: boolean,
): string {
  const parts: string[] = [];
  if (strategy === 'random') {
    parts.push(
      `${calibrationCount} scenarios drawn at random for discussion. There is no cleverness here. The sampler cannot know where your standard's edge is until people have voted.`,
    );
  } else if (fromPriorSplits === 0) {
    parts.push(
      `The previous poll produced no disagreements to carry, so all ${calibrationCount} discussion scenarios were drawn at random.`,
    );
  } else if (fromPriorSplits < calibrationCount) {
    parts.push(
      `${fromPriorSplits} scenarios carried over from the previous poll's disagreements; the remaining ${calibrationCount - fromPriorSplits} drawn at random to fill.`,
    );
  } else {
    parts.push(`All ${calibrationCount} discussion scenarios carried over from the previous poll's disagreements.`);
  }
  if (heldoutCount > 0) {
    parts.push(
      reusedHeldout
        ? `${heldoutCount} held-back scenarios reused from the previous poll, so before-and-after agreement is measured on the same cases.`
        : `${heldoutCount} scenarios held back. Everyone votes on them but they are never discussed. They are how the next poll measures whether agreement is actually improving.`,
    );
  }
  return parts.join(' ');
}

/**
 * The binding constraint from the spec: past ~30 minutes per grader, a second
 * round does not happen. This turns a proposed sample size into that budget.
 */
export const SECONDS_PER_TRACE = 75;
export const ATTENTION_BUDGET_MINUTES = 30;

export function attentionEstimate(totalItems: number, secondsPerTrace = SECONDS_PER_TRACE) {
  const minutes = (totalItems * secondsPerTrace) / 60;
  return {
    minutes,
    overBudget: minutes > ATTENTION_BUDGET_MINUTES,
    budget: ATTENTION_BUDGET_MINUTES,
    /** Largest sample that fits the budget. */
    maxItems: Math.floor((ATTENTION_BUDGET_MINUTES * 60) / secondsPerTrace),
  };
}

export function armLabel(arm: ItemArm): string {
  return arm === 'calibration' ? 'calibration' : 'held out';
}
