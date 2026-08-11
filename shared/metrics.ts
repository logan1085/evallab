/**
 * Inter-rater agreement.
 *
 * Two numbers get reported side by side everywhere in the product:
 *   - observed agreement, because it is the one people can reason about
 *   - Krippendorff's alpha, because observed agreement is inflated by prevalence
 *
 * Both are refused rather than approximated when the sample is too small to
 * carry them. `caveats` exists so the honesty travels with the number instead of
 * living in documentation nobody reads.
 */

import { ABSTAIN, type AgreementStats, type CoverageStats, type ItemVerdicts, type VerdictLevel } from './types.js';

/** Below this many units, a bootstrap interval is theatre. */
export const MIN_UNITS_FOR_CI = 8;
/** Below this many units, alpha swings wildly enough to mislead. */
export const MIN_UNITS_FOR_ALPHA = 5;
/** The spec's "small N honesty" line: fewer raters than this and we say so out loud. */
export const SMALL_RATER_PANEL = 5;

type Unit = string[]; // the non-abstain verdicts observed on one item

function unitsFrom(items: ItemVerdicts[]): Unit[] {
  return items
    .map((it) => Object.values(it.byGrader).filter((v) => v !== ABSTAIN && v !== ''))
    .filter((vals) => vals.length >= 2);
}

/** Mean pairwise agreement across all units, weighting every unit equally. */
export function observedAgreement(units: Unit[]): number {
  let totalRate = 0;
  let counted = 0;
  for (const vals of units) {
    const m = vals.length;
    if (m < 2) continue;
    let agree = 0;
    let pairs = 0;
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        pairs++;
        if (vals[i] === vals[j]) agree++;
      }
    }
    if (pairs > 0) {
      totalRate += agree / pairs;
      counted++;
    }
  }
  return counted === 0 ? 0 : totalRate / counted;
}

/**
 * Krippendorff's alpha via the coincidence matrix. Handles missing values
 * (raters who did not grade an item simply do not appear in that unit) and both
 * nominal and ordinal difference functions.
 */
export function krippendorffAlpha(
  units: Unit[],
  categories: string[],
  metric: 'nominal' | 'ordinal',
): number | null {
  const usable = units.filter((u) => u.length >= 2);
  if (usable.length === 0) return null;

  const idx = new Map(categories.map((c, i) => [c, i]));
  const K = categories.length;
  if (K < 2) return null;

  // Coincidence matrix: o[c][k] counts ordered pairs within units, scaled by 1/(m_u - 1).
  const o: number[][] = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  for (const vals of usable) {
    const m = vals.length;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) continue;
        const a = idx.get(vals[i]!);
        const b = idx.get(vals[j]!);
        if (a === undefined || b === undefined) continue;
        o[a]![b]! += 1 / (m - 1);
      }
    }
  }

  const nc = new Array<number>(K).fill(0);
  for (let c = 0; c < K; c++) {
    for (let k = 0; k < K; k++) nc[c]! += o[c]![k]!;
  }
  const n = nc.reduce((a, b) => a + b, 0);
  if (n < 2) return null;

  const delta = metric === 'nominal' ? nominalDelta : ordinalDelta(nc);

  let Do = 0;
  for (let c = 0; c < K; c++) {
    for (let k = 0; k < K; k++) Do += o[c]![k]! * delta(c, k);
  }
  Do /= n;

  let De = 0;
  for (let c = 0; c < K; c++) {
    for (let k = 0; k < K; k++) {
      if (c === k) continue;
      De += nc[c]! * nc[k]! * delta(c, k);
    }
  }
  De /= n * (n - 1);

  // Everyone used exactly one category: expected disagreement is zero and alpha
  // is undefined. Reporting 1.0 here would be a lie dressed as perfect agreement.
  if (De === 0) return null;
  return 1 - Do / De;
}

function nominalDelta(c: number, k: number): number {
  return c === k ? 0 : 1;
}

/** Krippendorff's ordinal difference: squared gap in cumulative category mass. */
function ordinalDelta(nc: number[]): (c: number, k: number) => number {
  return (c, k) => {
    if (c === k) return 0;
    const lo = Math.min(c, k);
    const hi = Math.max(c, k);
    let sum = 0;
    for (let g = lo; g <= hi; g++) sum += nc[g]!;
    const d = sum - (nc[lo]! + nc[hi]!) / 2;
    return d * d;
  };
}

/** Deterministic PRNG so a reported confidence interval is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap over units, which is the resampling unit that matters here. */
export function bootstrapCI(
  units: Unit[],
  iterations = 2000,
  seed = 0x5eed,
): [number, number] | null {
  if (units.length < MIN_UNITS_FOR_CI) return null;
  const rand = mulberry32(seed);
  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const draw: Unit[] = [];
    for (let i = 0; i < units.length; i++) {
      draw.push(units[Math.floor(rand() * units.length)]!);
    }
    samples.push(observedAgreement(draw));
  }
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(0.025 * samples.length)]!;
  const hi = samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))]!;
  return [lo, hi];
}

export function agreementStats(
  items: ItemVerdicts[],
  scale: VerdictLevel[],
  graderIds: string[],
): AgreementStats {
  const units = unitsFrom(items);
  const categories = [...scale].sort((a, b) => a.rank - b.rank).map((s) => s.id);
  const observed = observedAgreement(units);

  const alphaNominal =
    units.length >= MIN_UNITS_FOR_ALPHA ? krippendorffAlpha(units, categories, 'nominal') : null;
  const alphaOrdinal =
    units.length >= MIN_UNITS_FOR_ALPHA ? krippendorffAlpha(units, categories, 'ordinal') : null;

  const pairwise: AgreementStats['pairwise'] = {};
  for (let i = 0; i < graderIds.length; i++) {
    for (let j = i + 1; j < graderIds.length; j++) {
      const a = graderIds[i]!;
      const b = graderIds[j]!;
      let agreed = 0;
      let compared = 0;
      for (const item of items) {
        const va = item.byGrader[a];
        const vb = item.byGrader[b];
        if (!va || !vb || va === ABSTAIN || vb === ABSTAIN) continue;
        compared++;
        if (va === vb) agreed++;
      }
      pairwise[`${a}|${b}`] = { agreed, compared, rate: compared === 0 ? 0 : agreed / compared };
    }
  }

  const caveats: string[] = [];
  if (units.length === 0) {
    caveats.push('No item has two independent verdicts yet. Nothing here is measurable.');
  } else if (units.length < MIN_UNITS_FOR_ALPHA) {
    caveats.push(
      `Only ${units.length} comparable item${units.length === 1 ? '' : 's'}. Chance-corrected agreement is withheld below ${MIN_UNITS_FOR_ALPHA}.`,
    );
  }
  if (units.length > 0 && units.length < MIN_UNITS_FOR_CI) {
    caveats.push(
      `Fewer than ${MIN_UNITS_FOR_CI} comparable items, so no interval is shown. Treat the point estimate as a direction, not a measurement.`,
    );
  }
  if (graderIds.length > 0 && graderIds.length < SMALL_RATER_PANEL) {
    caveats.push(
      `${graderIds.length} grader${graderIds.length === 1 ? '' : 's'} on this round. A panel this size can move the number several points by itself.`,
    );
  }
  if (alphaNominal === null && units.length >= MIN_UNITS_FOR_ALPHA) {
    caveats.push(
      'Every grader used a single verdict, so expected disagreement is zero and alpha is undefined. Observed agreement is the only number available.',
    );
  }

  return {
    units: units.length,
    raters: graderIds.length,
    observed,
    alphaNominal,
    alphaOrdinal,
    observedCI: bootstrapCI(units),
    pairwise,
    caveats,
  };
}

/**
 * Coverage sits next to agreement everywhere, because a rubric can buy agreement
 * by saying less. If agreement climbs while coverage falls, the metric is eating
 * the product.
 */
export function coverageStats(
  items: ItemVerdicts[],
  graderIds: string[],
  clauseCoveredItemIds: Set<string> = new Set(),
): CoverageStats {
  const expected = items.length * graderIds.length;
  let filled = 0;
  let abstentions = 0;
  let undecidable = 0;

  for (const item of items) {
    const values = graderIds.map((g) => item.byGrader[g]).filter((v): v is string => !!v);
    filled += values.length;
    const abs = values.filter((v) => v === ABSTAIN).length;
    abstentions += abs;
    if (values.length > 0 && abs === values.length) undecidable++;
  }

  return {
    items: items.length,
    participation: expected === 0 ? 0 : filled / expected,
    abstentionRate: filled === 0 ? 0 : abstentions / filled,
    undecidableRate: items.length === 0 ? 0 : undecidable / items.length,
    clauseCoverage: items.length === 0 ? 0 : clauseCoveredItemIds.size / items.length,
  };
}
