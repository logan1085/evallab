import { describe, expect, it } from 'vitest';
import {
  agreementStats,
  bootstrapCI,
  ac1Explained,
  alphaExplained,
  coverageStats,
  gwetAC1,
  gwetAC1Variance,
  krippendorffAlpha,
  lengthPassCorrelation,
  observedAgreement,
} from '@shared/metrics.js';
import { ABSTAIN, DEFAULT_SCALE, type ItemVerdicts } from '@shared/types.js';

const CATS = ['fail', 'recoverable', 'pass'];

function items(rows: Record<string, string>[]): ItemVerdicts[] {
  return rows.map((byGrader, i) => ({ itemId: `i${i}`, byGrader }));
}

describe('observedAgreement', () => {
  it('is 1 when every rater matches on every unit', () => {
    expect(observedAgreement([['pass', 'pass', 'pass'], ['fail', 'fail']])).toBe(1);
  });

  it('is 0 when no pair ever matches', () => {
    expect(observedAgreement([['pass', 'fail'], ['recoverable', 'pass']])).toBe(0);
  });

  it('weights each unit equally regardless of how many raters saw it', () => {
    // Unit A: 1 of 3 pairs agree. Unit B: 0 of 1 pairs agree. Mean = (1/3 + 0) / 2.
    // A three-rater unit does not get more say than a two-rater unit.
    const rate = observedAgreement([['pass', 'pass', 'fail'], ['pass', 'fail']]);
    expect(rate).toBeCloseTo((1 / 3 + 0) / 2, 10);
  });

  it('ignores units with fewer than two verdicts', () => {
    expect(observedAgreement([['pass'], ['fail', 'fail']])).toBe(1);
  });
});

describe('krippendorffAlpha', () => {
  it('returns 1 for perfect agreement across both categories', () => {
    const units = [
      ['pass', 'pass', 'pass'],
      ['fail', 'fail', 'fail'],
      ['pass', 'pass', 'pass'],
      ['fail', 'fail', 'fail'],
      ['recoverable', 'recoverable', 'recoverable'],
    ];
    expect(krippendorffAlpha(units, CATS, 'nominal')).toBeCloseTo(1, 10);
  });

  it('matches the closed form for systematic two-rater disagreement', () => {
    // Every unit is {pass, fail}. Analytically alpha = (1 - N) / N.
    const N = 10;
    const units = Array.from({ length: N }, () => ['pass', 'fail']);
    expect(krippendorffAlpha(units, CATS, 'nominal')).toBeCloseTo((1 - N) / N, 10);
  });

  it('returns null when expected disagreement is zero', () => {
    // Only one category was ever used: alpha is undefined, not 1.
    const units = Array.from({ length: 6 }, () => ['pass', 'pass']);
    expect(krippendorffAlpha(units, CATS, 'nominal')).toBeNull();
  });

  it('penalises a far miss more than a near miss under the ordinal metric', () => {
    const base = [
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['recoverable', 'recoverable'],
      ['pass', 'pass'],
      ['fail', 'fail'],
    ];
    const near = krippendorffAlpha([...base, ['pass', 'recoverable']], CATS, 'ordinal')!;
    const far = krippendorffAlpha([...base, ['pass', 'fail']], CATS, 'ordinal')!;
    expect(near).toBeGreaterThan(far);
  });

  it('is blind to the ordering of the scale under the nominal metric', () => {
    // Nominal alpha depends on the marginals, not on where categories sit on the
    // scale. Reversing the scale must not move it. Ordinal alpha must move.
    // Marginals must be unbalanced for this to bite: with equal category counts
    // the ordinal metric is accidentally permutation-invariant too.
    const units = [
      ['pass', 'recoverable'],
      ['pass', 'pass'],
      ['pass', 'pass'],
      ['pass', 'fail'],
      ['recoverable', 'fail'],
      ['fail', 'fail'],
    ];
    const forward = krippendorffAlpha(units, CATS, 'nominal')!;
    const reversed = krippendorffAlpha(units, [...CATS].reverse(), 'nominal')!;
    expect(forward).toBeCloseTo(reversed, 10);

    // Moving 'recoverable' off the middle of the scale changes what counts as a near miss.
    const ordForward = krippendorffAlpha(units, CATS, 'ordinal')!;
    const ordShuffled = krippendorffAlpha(units, ['recoverable', 'fail', 'pass'], 'ordinal')!;
    expect(ordForward).toBeGreaterThan(ordShuffled);
  });

  it('handles missing data by scaling each unit by 1/(m-1)', () => {
    const ragged = [
      ['pass', 'pass', 'pass'],
      ['fail', 'fail'],
      ['pass', 'pass', 'pass', 'pass'],
      ['fail', 'fail', 'fail'],
      ['recoverable', 'recoverable'],
    ];
    expect(krippendorffAlpha(ragged, CATS, 'nominal')).toBeCloseTo(1, 10);
  });

  it('returns null with no usable units', () => {
    expect(krippendorffAlpha([], CATS, 'nominal')).toBeNull();
  });
});

describe('bootstrapCI', () => {
  it('withholds an interval below the minimum unit count', () => {
    expect(bootstrapCI([['pass', 'pass'], ['fail', 'fail']])).toBeNull();
  });

  it('brackets the point estimate and is deterministic', () => {
    const units = [
      ['pass', 'pass'],
      ['pass', 'fail'],
      ['fail', 'fail'],
      ['pass', 'pass'],
      ['recoverable', 'pass'],
      ['fail', 'fail'],
      ['pass', 'pass'],
      ['fail', 'recoverable'],
      ['pass', 'pass'],
      ['fail', 'fail'],
    ];
    const a = bootstrapCI(units, 500)!;
    const b = bootstrapCI(units, 500)!;
    expect(a).toEqual(b);
    const point = observedAgreement(units);
    expect(a[0]).toBeLessThanOrEqual(point);
    expect(a[1]).toBeGreaterThanOrEqual(point);
  });
});

describe('agreementStats', () => {
  const graders = ['a', 'b', 'c'];

  it('excludes abstentions from agreement entirely', () => {
    const stats = agreementStats(
      items([
        { a: 'pass', b: 'pass', c: ABSTAIN },
        { a: 'fail', b: 'fail', c: ABSTAIN },
      ]),
      DEFAULT_SCALE,
      graders,
    );
    expect(stats.observed).toBe(1);
    expect(stats.units).toBe(2);
  });

  it('drops items where only one grader produced a usable verdict', () => {
    const stats = agreementStats(
      items([{ a: 'pass', b: ABSTAIN, c: ABSTAIN }, { a: 'pass', b: 'pass', c: 'pass' }]),
      DEFAULT_SCALE,
      graders,
    );
    expect(stats.units).toBe(1);
  });

  it('reproduces the split pattern from the spec table', () => {
    // Six traces, three graders, three of them split. Mean pairwise agreement
    // over the three unanimous rows is 1; the splits contribute 1/3, 0 and 1/3.
    const stats = agreementStats(
      items([
        { a: 'pass', b: 'pass', c: 'pass' },
        { a: 'pass', b: 'fail', c: 'pass' },
        { a: 'fail', b: 'fail', c: 'fail' },
        { a: 'recoverable', b: 'fail', c: 'pass' },
        { a: 'pass', b: 'fail', c: 'fail' },
        { a: 'fail', b: 'fail', c: 'fail' },
      ]),
      DEFAULT_SCALE,
      graders,
    );
    expect(stats.observed).toBeCloseTo((1 + 1 / 3 + 1 + 0 + 1 / 3 + 1) / 6, 10);
    expect(stats.raters).toBe(3);
  });

  it('reports the small-panel caveat for three graders', () => {
    const stats = agreementStats(items([{ a: 'pass', b: 'pass', c: 'pass' }]), DEFAULT_SCALE, graders);
    expect(stats.caveats.join(' ')).toMatch(/3 graders/);
  });

  it('withholds alpha and the interval on a tiny sample', () => {
    const stats = agreementStats(items([{ a: 'pass', b: 'fail' }]), DEFAULT_SCALE, ['a', 'b']);
    expect(stats.alphaNominal).toBeNull();
    expect(stats.observedCI).toBeNull();
    expect(stats.caveats.length).toBeGreaterThan(0);
  });

  it('computes pairwise rates that identify the outlier grader', () => {
    const stats = agreementStats(
      items([
        { a: 'pass', b: 'fail', c: 'pass' },
        { a: 'pass', b: 'fail', c: 'pass' },
      ]),
      DEFAULT_SCALE,
      graders,
    );
    expect(stats.pairwise['a|c']!.rate).toBe(1);
    expect(stats.pairwise['a|b']!.rate).toBe(0);
    expect(stats.pairwise['b|c']!.rate).toBe(0);
  });
});

describe('coverageStats', () => {
  it('tracks participation against the full grader x item grid', () => {
    const cov = coverageStats(items([{ a: 'pass', b: 'pass' }, { a: 'fail' }]), ['a', 'b']);
    expect(cov.participation).toBeCloseTo(3 / 4, 10);
  });

  it('separates abstention rate from undecidable items', () => {
    const cov = coverageStats(
      items([
        { a: ABSTAIN, b: ABSTAIN },
        { a: 'pass', b: ABSTAIN },
        { a: 'pass', b: 'pass' },
      ]),
      ['a', 'b'],
    );
    expect(cov.abstentionRate).toBeCloseTo(3 / 6, 10);
    expect(cov.undecidableRate).toBeCloseTo(1 / 3, 10);
  });

  it('reports clause coverage over items', () => {
    const cov = coverageStats(items([{ a: 'pass' }, { a: 'fail' }]), ['a'], new Set(['i0']));
    expect(cov.clauseCoverage).toBeCloseTo(1 / 2, 10);
  });
});

describe("Gwet's AC1", () => {
  // The reason AC1 ships: a skewed but agreeing room. Nine units where both
  // raters say pass, one where they split. Alpha reads this near zero because
  // the marginals are one-sided; AC1 reads it as the high agreement it is.
  it('stays high under skewed prevalence where alpha collapses', () => {
    const units: string[][] = [
      ...Array.from({ length: 9 }, () => ['pass', 'pass']),
      ['pass', 'fail'],
    ];
    const cats = ['fail', 'recoverable', 'pass'];
    const ac1 = gwetAC1(units, cats)!;
    const alpha = krippendorffAlpha(units, cats, 'nominal')!;
    expect(ac1).toBeGreaterThan(0.8);
    expect(alpha).toBeLessThan(0.5);
    expect(ac1).toBeGreaterThan(alpha);
  });

  it('is 1 under perfect agreement and null below the minimum unit count', () => {
    const perfect = Array.from({ length: 6 }, () => ['pass', 'pass', 'pass']);
    expect(gwetAC1(perfect, ['fail', 'pass'])).toBeCloseTo(1, 10);
    expect(gwetAC1([['pass', 'pass']], ['fail', 'pass'])).toBeNull();
  });

  it('worked example: two raters, mixed table', () => {
    // 4 units: agree pass, agree pass, agree fail, split. pa = 3/4.
    // Ratings: 8 total; pass 5/8, fail 3/8.
    // pe = (1/(q-1)) * [.625*.375 + .375*.625] = 0.46875 with q=2... use q=2.
    const units = [
      ['pass', 'pass'],
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['pass', 'fail'],
    ];
    // Need >= 5 units for the gate; duplicate the agreeing rows proportionally.
    const scaled = [...units, ['pass', 'pass'], ['fail', 'fail']];
    const ac1 = gwetAC1(scaled, ['fail', 'pass'])!;
    // pa = 5/6; pi_pass = 7/12, pi_fail = 5/12;
    // pe = (7/12)(5/12) + (5/12)(7/12) = 70/144 = 0.48611
    // ac1 = (0.83333 - 0.48611) / (1 - 0.48611) = 0.67567...
    expect(ac1).toBeCloseTo(0.6757, 3);
  });
});

describe("AC1's variance (Gwet 2008)", () => {
  it('matches a fully hand-derived example to four decimals', () => {
    // Six units, two raters, q=2: five (pass,pass) and one (pass,fail).
    // pa=5/6; prevalence pass 11/12, fail 1/12; pe=22/144=0.152778;
    // AC1=0.803279. Item linearizations: agreeing items 1.032249, the split
    // -0.341573 (arithmetic in the review notes); their mean recovers AC1,
    // and v = (1/30)[5(0.228970)^2 + (1.144852)^2] = 0.052427.
    const units = [...Array.from({ length: 5 }, () => ['pass', 'pass']), ['pass', 'fail']];
    const v = gwetAC1Variance(units, ['fail', 'pass'])!;
    expect(v).toBeCloseTo(0.0524, 4);
  });

  it('shrinks with more data and is null below the unit gate', () => {
    const base = [...Array.from({ length: 5 }, () => ['pass', 'pass']), ['pass', 'fail']];
    const more = [...base, ...base, ...base, ...base];
    expect(gwetAC1Variance(more, ['fail', 'pass'])!).toBeLessThan(gwetAC1Variance(base, ['fail', 'pass'])!);
    expect(gwetAC1Variance([['pass', 'pass']], ['fail', 'pass'])).toBeNull();
  });
});

describe('the verbosity readout', () => {
  it('sees a seat that rewards length', () => {
    const pairs = [
      { outputLength: 100, pass: false },
      { outputLength: 200, pass: false },
      { outputLength: 900, pass: true },
      { outputLength: 1100, pass: true },
    ];
    expect(lengthPassCorrelation(pairs).value!).toBeGreaterThan(0.8);
  });

  it('says why when it cannot be computed', () => {
    expect(lengthPassCorrelation([]).reason).toContain('fewer than four');
    expect(
      lengthPassCorrelation([
        { outputLength: 5, pass: true },
        { outputLength: 5, pass: false },
        { outputLength: 5, pass: true },
        { outputLength: 5, pass: false },
      ]).reason,
    ).toContain('same length');
  });
});

describe('typed undefined statistics', () => {
  it('returns the reason instead of NaN', () => {
    expect(alphaExplained([['pass', 'pass']], CATS).reason).toContain('fewer than');
    expect(ac1Explained([['pass', 'pass']], CATS).reason).toContain('fewer than');
    expect(ac1Explained(Array.from({ length: 6 }, () => ['pass', 'pass', 'pass']), CATS).value).toBeCloseTo(1, 6);
  });
});
