import { describe, expect, it } from 'vitest';
import { buildSplitReport, classify, clusterSplits, compareSeverity, splitsOf, type ItemContext } from '@shared/splits.js';
import { ABSTAIN, DEFAULT_SCALE, type ItemVerdicts, type SplitReportRow } from '@shared/types.js';
import { attentionEstimate, planSample, shuffle } from '@shared/sampling.js';

describe('classify', () => {
  it('calls a unanimous item unanimous', () => {
    expect(classify(['pass', 'pass', 'pass'], DEFAULT_SCALE).kind).toBe('unanimous');
  });

  it('treats a lone verdict plus abstentions as unanimous, not a split', () => {
    expect(classify(['pass', ABSTAIN, ABSTAIN], DEFAULT_SCALE).kind).toBe('unanimous');
  });

  it('separates an adjacent split from a polar one by ordinal distance', () => {
    expect(classify(['pass', 'partial'], DEFAULT_SCALE)).toMatchObject({ kind: 'adjacent', spread: 1 });
    expect(classify(['pass', 'fail'], DEFAULT_SCALE)).toMatchObject({ kind: 'polar', spread: 2 });
  });

  it('calls a three-way disagreement scattered', () => {
    expect(classify(['pass', 'partial', 'fail'], DEFAULT_SCALE)).toMatchObject({ kind: 'scattered', spread: 2 });
  });

  it('orders the distinct verdicts by rank, highest first', () => {
    expect(classify(['fail', 'pass', 'partial'], DEFAULT_SCALE).distinct).toEqual(['pass', 'partial', 'fail']);
  });
});

describe('split report ordering', () => {
  const contexts = (n: number): Map<string, ItemContext> =>
    new Map(
      Array.from({ length: n }, (_, i) => [
        `i${i}`,
        { itemId: `i${i}`, traceId: `t${i}`, title: `Trace ${i}`, arm: 'calibration' as const, resolved: false },
      ]),
    );

  it('puts the widest gaps first and unanimous rows last', () => {
    const items: ItemVerdicts[] = [
      { itemId: 'i0', byGrader: { a: 'pass', b: 'pass' } },
      { itemId: 'i1', byGrader: { a: 'pass', b: 'partial' } },
      { itemId: 'i2', byGrader: { a: 'pass', b: 'fail' } },
    ];
    const rows = buildSplitReport(items, contexts(3), DEFAULT_SCALE);
    expect(rows.map((r) => r.kind)).toEqual(['polar', 'adjacent', 'unanimous']);
  });

  it('sinks resolved splits below unresolved ones', () => {
    const ctx = contexts(2);
    ctx.set('i0', { ...ctx.get('i0')!, resolved: true });
    const items: ItemVerdicts[] = [
      { itemId: 'i0', byGrader: { a: 'pass', b: 'fail' } },
      { itemId: 'i1', byGrader: { a: 'pass', b: 'partial' } },
    ];
    const rows = buildSplitReport(items, ctx, DEFAULT_SCALE);
    expect(rows[0]!.itemId).toBe('i1');
    expect(rows[1]!.resolved).toBe(true);
  });

  it('is a total order — sorting twice is stable', () => {
    const items: ItemVerdicts[] = Array.from({ length: 6 }, (_, i) => ({
      itemId: `i${i}`,
      byGrader: { a: 'pass', b: i % 2 === 0 ? 'fail' : 'partial' },
    }));
    const rows = buildSplitReport(items, contexts(6), DEFAULT_SCALE);
    expect([...rows].sort(compareSeverity).map((r) => r.itemId)).toEqual(rows.map((r) => r.itemId));
  });
});

describe('clusterSplits', () => {
  it('groups splits by the shape of the disagreement and drops unanimous rows', () => {
    const rows = [
      row('i0', ['pass', 'fail'], 'polar'),
      row('i1', ['pass', 'fail'], 'polar'),
      row('i2', ['pass', 'partial'], 'adjacent'),
      row('i3', [], 'unanimous'),
    ];
    const clusters = clusterSplits(rows);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.key).toBe('pass|fail');
    expect(clusters[0]!.rows).toHaveLength(2);
    expect(splitsOf(rows)).toHaveLength(3);
  });
});

function row(itemId: string, verdicts: string[], kind: SplitReportRow['kind']): SplitReportRow {
  return {
    itemId,
    traceId: `t-${itemId}`,
    title: itemId,
    arm: 'calibration',
    kind,
    verdicts,
    spread: verdicts.length > 1 ? 2 : 0,
    byGrader: {},
    abstentions: 0,
    gradedBy: 2,
    clusterKey: kind === 'unanimous' ? 'agreed' : verdicts.join('|'),
    resolved: false,
  };
}

describe('planSample', () => {
  const pool = Array.from({ length: 20 }, (_, i) => `t${i}`);

  it('is reproducible for a given seed and different across seeds', () => {
    const a = planSample({ pool, strategy: 'random', calibrationSize: 5, heldoutSize: 3, seed: 'x' });
    const b = planSample({ pool, strategy: 'random', calibrationSize: 5, heldoutSize: 3, seed: 'x' });
    const c = planSample({ pool, strategy: 'random', calibrationSize: 5, heldoutSize: 3, seed: 'y' });
    expect(a.calibration).toEqual(b.calibration);
    expect(a.calibration).not.toEqual(c.calibration);
  });

  it('never puts the same trace in both arms', () => {
    const plan = planSample({ pool, strategy: 'random', calibrationSize: 10, heldoutSize: 10, seed: 's' });
    expect(new Set([...plan.calibration, ...plan.heldout]).size).toBe(20);
  });

  it('carries prior splits into calibration and fills the rest at random', () => {
    const plan = planSample({
      pool,
      strategy: 'from_splits',
      priorSplitTraceIds: ['t1', 't2', 't3'],
      calibrationSize: 6,
      heldoutSize: 0,
      seed: 's',
    });
    expect(plan.fromPriorSplits).toBe(3);
    expect(plan.calibration).toHaveLength(6);
    for (const id of ['t1', 't2', 't3']) expect(plan.calibration).toContain(id);
    expect(plan.explanation).toMatch(/3 scenarios carried over/);
  });

  it('reuses the held-out set so before and after are measured on the same cases', () => {
    const first = planSample({ pool, strategy: 'random', calibrationSize: 5, heldoutSize: 4, seed: 'r1' });
    const second = planSample({
      pool,
      strategy: 'from_splits',
      priorSplitTraceIds: first.calibration.slice(0, 2),
      calibrationSize: 5,
      heldoutSize: 4,
      reuseHeldoutTraceIds: first.heldout,
      seed: 'r2',
    });
    expect(second.heldout).toEqual(first.heldout);
    expect(second.explanation).toMatch(/reused from the previous poll/);
  });

  it('says plainly that round-one sampling is not clever', () => {
    const plan = planSample({ pool, strategy: 'random', calibrationSize: 5, heldoutSize: 0, seed: 's' });
    expect(plan.explanation).toMatch(/no cleverness here/);
  });

  it('degrades to the available pool rather than inventing traces', () => {
    const plan = planSample({ pool: ['a', 'b'], strategy: 'random', calibrationSize: 5, heldoutSize: 0, seed: 's' });
    expect(plan.calibration).toHaveLength(2);
  });
});

describe('attentionEstimate', () => {
  it('flags a sample that busts the thirty-minute budget', () => {
    expect(attentionEstimate(10).overBudget).toBe(false);
    expect(attentionEstimate(40).overBudget).toBe(true);
    expect(attentionEstimate(1).maxItems).toBe(24);
  });
});

describe('shuffle', () => {
  it('is a permutation, not a filter', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    expect([...shuffle(input, 'seed')].sort((a, b) => a - b)).toEqual(input);
  });
});
