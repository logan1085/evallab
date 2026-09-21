/**
 * The coverage map: what kinds of ground the case set stands on, and how
 * the panel read each kind.
 *
 * Four classes. Three are the grounds the writer covers on purpose (clear,
 * boundary, unimagined), stamped on each scenario when it is written; the
 * fourth is the company's own transcripts, pasted or imported, which are
 * the class that proves the eval on the real workflow. A class with no
 * cases is a gap the map names, and a class the panel never split on is
 * worth a look too: a boundary set that settles every case was not
 * written at the boundary.
 */

import { SCENARIO_GROUNDS, isScenarioGround, type ScenarioGround } from './scenarios.js';

export type CoverageClass = ScenarioGround | 'real';

export interface CoverageCase {
  id: string;
  title: string;
  source: string;
  meta: Record<string, unknown>;
}

/** How the latest finished round read one case: its pattern, or absent when ungraded. */
export interface CoverageReading {
  caseId: string;
  pattern: string;
  verdict: string | null;
}

export interface CoverageRow {
  id: CoverageClass;
  label: string;
  what: string;
  cases: number;
  graded: number;
  settled: number;
  splits: number;
  /** Share of graded cases the panel split on; null when none graded. */
  split_rate: number | null;
  /** Share of decided cases with the top verdict; null when none decided. */
  pass_rate: number | null;
  titles: string[];
}

export interface CoverageMap {
  rows: CoverageRow[];
  total: number;
  gaps: { id: CoverageClass; reason: string }[];
}

const CLASSES: { id: CoverageClass; label: string; what: string }[] = [
  ...SCENARIO_GROUNDS.map((g) => ({ id: g.id, label: g.label, what: g.focus.replace(/\.$/, '') })),
  { id: 'real', label: 'Your own transcripts', what: 'pasted or imported from the real workflow: the cases that prove the eval on your actual problem' },
];

export function classOf(c: CoverageCase): CoverageClass {
  if (isScenarioGround(c.meta.ground)) return c.meta.ground;
  if (c.meta.generated === true || c.source === 'scenario' || c.source === 'seed') {
    // Scenarios written before grounds were stamped: read the probe for
    // the words the writer's own rules use, else count them as clear.
    const probe = typeof c.meta.probe === 'string' ? c.meta.probe.toLowerCase() : '';
    if (/edge|boundary|contradict|split|judgment|run out|partial|scope/.test(probe)) return 'boundary';
    if (/never|imagin|unverified|caution|unexpected/.test(probe)) return 'unimagined';
    return 'clear';
  }
  return 'real';
}

export function coverageMap(cases: CoverageCase[], readings: CoverageReading[], topVerdict: string | null): CoverageMap {
  const byCase = new Map(readings.map((r) => [r.caseId, r]));
  const rows: CoverageRow[] = CLASSES.map((cls) => {
    const mine = cases.filter((c) => classOf(c) === cls.id);
    const read = mine.map((c) => byCase.get(c.id)).filter((r): r is CoverageReading => !!r && r.pattern !== 'ungraded');
    const splits = read.filter((r) => r.pattern === 'persona-driven' || r.pattern === 'contested').length;
    const settled = read.filter((r) => r.pattern === 'settled').length;
    const decided = read.filter((r) => r.verdict !== null);
    return {
      id: cls.id,
      label: cls.label,
      what: cls.what,
      cases: mine.length,
      graded: read.length,
      settled,
      splits,
      split_rate: read.length === 0 ? null : splits / read.length,
      pass_rate: decided.length === 0 || topVerdict === null ? null : decided.filter((r) => r.verdict === topVerdict).length / decided.length,
      titles: mine.map((c) => c.title),
    };
  });

  const gaps: CoverageMap['gaps'] = [];
  for (const row of rows) {
    if (row.cases === 0) {
      gaps.push({ id: row.id, reason: row.id === 'real' ? 'No transcript from the real workflow yet. Paste one; it is the case that proves the eval on your actual problem.' : `No ${row.label.toLowerCase()} yet.` });
      continue;
    }
    if (row.id === 'boundary' && row.graded >= 3 && row.splits === 0) {
      gaps.push({ id: row.id, reason: 'The panel settled every boundary case. Cases written at the boundary should split it; these may not be at the boundary.' });
    }
    if (row.id === 'clear' && row.graded >= 3 && row.split_rate !== null && row.split_rate > 0.5) {
      gaps.push({ id: row.id, reason: 'The panel split on most of the clear cases. Either they are not clear, or the standard is missing the sentence that settles them.' });
    }
  }
  return { rows, total: cases.length, gaps };
}
