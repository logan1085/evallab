/**
 * Drift: what the same eval says about the same workflow over time.
 *
 * A run is one reading. Drift is the series: pass rate, splits, and the
 * cases that flipped between one run and the next, against one version of
 * the standard. The report compares the latest run with a baseline (the
 * oldest run inside the window) and says, in one word and a few reasons,
 * whether the workflow has moved. A scheduled run plus this report is the
 * retainer: the eval keeps reading, and someone is told when the reading
 * changes.
 */

export interface RunPoint {
  id: string;
  name: string;
  at: string;
  standards_version: number;
  cases: number;
  decided: number;
  pass_rate: number | null;
  splits: number;
  new_splits: number;
  unstable_votes: number;
  /** Cases whose ensemble verdict differs from the previous run of the same standard. */
  flipped: number;
}

export interface DriftSpec {
  /** Fail when the pass rate fell by more than this (0..1) from the baseline. */
  max_pass_rate_drop?: number;
  /** Fail when the latest run flipped more cases than this against the run before it. */
  max_flips?: number;
  /** Fail when the latest run added more new splits than this. */
  max_new_splits?: number;
  /** How many most-recent runs the report covers. Default 5. */
  window?: number;
}

export type Trend = 'steady' | 'improving' | 'degrading' | 'insufficient';

export interface DriftReport {
  spec: DriftSpec;
  standards_version: number | null;
  series: RunPoint[];
  baseline: RunPoint | null;
  latest: RunPoint | null;
  delta: { pass_rate: number | null; splits: number | null };
  trend: Trend;
  drifted: boolean;
  reasons: string[];
}

const DEFAULT_WINDOW = 5;

/**
 * Points arrive oldest first. Only the latest standard version is read
 * unless one is named, because a pass rate against v1 and one against v2
 * are two different instruments.
 */
export function driftReport(points: RunPoint[], spec: DriftSpec = {}, standardsVersion?: number): DriftReport {
  const version = standardsVersion ?? points.at(-1)?.standards_version ?? null;
  const window = Math.max(2, spec.window ?? DEFAULT_WINDOW);
  const series = points.filter((p) => version === null || p.standards_version === version).slice(-window);
  const latest = series.at(-1) ?? null;
  const baseline = series.length >= 2 ? series[0]! : null;
  const reasons: string[] = [];

  const delta = {
    pass_rate: latest && baseline && latest.pass_rate !== null && baseline.pass_rate !== null ? latest.pass_rate - baseline.pass_rate : null,
    splits: latest && baseline ? latest.splits - baseline.splits : null,
  };

  let trend: Trend = 'insufficient';
  if (delta.pass_rate !== null) {
    // Two points of a decimal are noise on a small case set; the trend
    // needs a whole point of pass rate to say anything.
    trend = delta.pass_rate > 0.01 ? 'improving' : delta.pass_rate < -0.01 ? 'degrading' : 'steady';
  }

  if (latest && baseline) {
    if (typeof spec.max_pass_rate_drop === 'number' && delta.pass_rate !== null && -delta.pass_rate > spec.max_pass_rate_drop) {
      reasons.push(
        `pass rate fell ${(-delta.pass_rate * 100).toFixed(0)} points from ${baseline.name} (${pct(baseline.pass_rate)}) to ${latest.name} (${pct(latest.pass_rate)}), more than the ${(spec.max_pass_rate_drop * 100).toFixed(0)} allowed`,
      );
    }
    if (typeof spec.max_flips === 'number' && latest.flipped > spec.max_flips) {
      reasons.push(`${latest.flipped} case${latest.flipped === 1 ? '' : 's'} flipped verdict in ${latest.name} against a limit of ${spec.max_flips}`);
    }
    if (typeof spec.max_new_splits === 'number' && latest.new_splits > spec.max_new_splits) {
      reasons.push(`${latest.new_splits} new split${latest.new_splits === 1 ? '' : 's'} in ${latest.name} against a limit of ${spec.max_new_splits}`);
    }
  }

  return { spec, standards_version: version, series, baseline, latest, delta, trend, drifted: reasons.length > 0, reasons };
}

export function parseDriftSpec(text: string | undefined): DriftSpec {
  const spec: DriftSpec = {};
  if (!text) return spec;
  for (const part of text.split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (!k || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (k === 'pass-rate-drop' || k === 'max_pass_rate_drop') spec.max_pass_rate_drop = n;
    if (k === 'flips' || k === 'max_flips') spec.max_flips = n;
    if (k === 'new-splits' || k === 'max_new_splits') spec.max_new_splits = n;
    if (k === 'window') spec.window = n;
  }
  return spec;
}

export const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
