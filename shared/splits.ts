/**
 * Split detection.
 *
 * The split report is the product, so this file decides what the user sees
 * first. Splits are ordered by how far apart the graders landed, not by trace
 * order, and clustered by the *kind* of disagreement so that five instances of
 * "pass versus fail on a stale source" read as one rubric gap rather than five
 * separate arguments.
 */

import { ABSTAIN, type ItemVerdicts, type SplitKind, type SplitReportRow, type VerdictLevel } from './types.js';

export interface ItemContext {
  itemId: string;
  traceId: string;
  title: string;
  arm: 'calibration' | 'heldout';
  resolved: boolean;
}

export function classify(
  verdicts: string[],
  scale: VerdictLevel[],
): { kind: SplitKind; spread: number; distinct: string[] } {
  const rankOf = new Map(scale.map((s) => [s.id, s.rank]));
  const real = verdicts.filter((v) => v !== ABSTAIN && v !== '');
  const distinct = [...new Set(real)].sort((a, b) => (rankOf.get(b) ?? 0) - (rankOf.get(a) ?? 0));

  if (distinct.length <= 1) return { kind: 'unanimous', spread: 0, distinct };

  const ranks = distinct.map((v) => rankOf.get(v) ?? 0);
  const spread = Math.max(...ranks) - Math.min(...ranks);

  if (distinct.length >= 3) return { kind: 'scattered', spread, distinct };
  return { kind: spread <= 1 ? 'adjacent' : 'polar', spread, distinct };
}

export function buildSplitReport(
  items: ItemVerdicts[],
  contexts: Map<string, ItemContext>,
  scale: VerdictLevel[],
): SplitReportRow[] {
  const rows: SplitReportRow[] = [];

  for (const item of items) {
    const ctx = contexts.get(item.itemId);
    if (!ctx) continue;
    const values = Object.values(item.byGrader);
    const { kind, spread, distinct } = classify(values, scale);

    rows.push({
      itemId: item.itemId,
      traceId: ctx.traceId,
      title: ctx.title,
      arm: ctx.arm,
      kind,
      verdicts: distinct,
      spread,
      byGrader: item.byGrader,
      abstentions: values.filter((v) => v === ABSTAIN).length,
      gradedBy: values.length,
      clusterKey: kind === 'unanimous' ? 'agreed' : distinct.join('|'),
      resolved: ctx.resolved,
    });
  }

  return rows.sort(compareSeverity);
}

/** Widest gap first, then most scattered, then most abstentions. Unresolved before resolved. */
export function compareSeverity(a: SplitReportRow, b: SplitReportRow): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  if (b.spread !== a.spread) return b.spread - a.spread;
  if (b.verdicts.length !== a.verdicts.length) return b.verdicts.length - a.verdicts.length;
  if (b.abstentions !== a.abstentions) return b.abstentions - a.abstentions;
  return a.title.localeCompare(b.title);
}

export interface SplitCluster {
  key: string;
  verdicts: string[];
  kind: SplitKind;
  rows: SplitReportRow[];
}

/** Group splits by the shape of the disagreement, biggest cluster first. */
export function clusterSplits(rows: SplitReportRow[]): SplitCluster[] {
  const clusters = new Map<string, SplitCluster>();
  for (const row of rows) {
    if (row.kind === 'unanimous') continue;
    let cluster = clusters.get(row.clusterKey);
    if (!cluster) {
      cluster = { key: row.clusterKey, verdicts: row.verdicts, kind: row.kind, rows: [] };
      clusters.set(row.clusterKey, cluster);
    }
    cluster.rows.push(row);
  }
  return [...clusters.values()].sort((a, b) => {
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
    return compareSeverity(a.rows[0]!, b.rows[0]!);
  });
}

export function splitsOf(rows: SplitReportRow[]): SplitReportRow[] {
  return rows.filter((r) => r.kind !== 'unanimous');
}
