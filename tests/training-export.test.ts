/**
 * Training data is the thesis as rows: a company's judgment, with provenance.
 * These pin the three shapes and the two exclusions that keep the file honest:
 * unsettled cases never become examples, and neither does a settle the owner
 * overruled.
 */
import { describe, expect, it } from 'vitest';
import { buildTrainingExport, scoreOf, toJsonl, type TrainingRound } from '../server/training.js';
import { DEFAULT_SCALE, type Grader, type RubricVersion, type Trace } from '../shared/types.js';

const rubric: RubricVersion = {
  id: 'rv2',
  projectId: 'p',
  version: 2,
  name: 'Standards',
  preamble: 'A support agent.',
  scale: DEFAULT_SCALE,
  criteria: [],
  clauses: [],
  openQuestions: [],
  conflicts: [],
  draftedFrom: null,
  parentVersionId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
} as unknown as RubricVersion;

const seat = (id: string, name: string, family: string): Grader =>
  ({ id, projectId: 'p', name, kind: 'panelist', objective: `${name} wants`, failsFor: 'x', model: `${family}/m`, family, origin: 'generated', archetypeId: null, weight: 1, sameFamilyAsSut: false, createdAt: '' }) as Grader;

const seats = [seat('s1', 'The literalist', 'anthropic'), seat('s2', 'The impatient user', 'openai'), seat('s3', 'The support lead', 'google')];
const trace = (id: string, title: string): Trace => ({ id, projectId: 'p', title, content: `CASE ${title}`, source: 'scenario', meta: {}, createdAt: '' }) as Trace;
const traces = new Map([['t1', trace('t1', 'Settled')], ['t2', trace('t2', 'Split')], ['t3', trace('t3', 'Overruled')]]);

const grade = (itemId: string, graderId: string, verdict: string, note: string) => ({ id: `${itemId}-${graderId}`, itemId, graderId, verdict, note, elapsedMs: 0, createdAt: '' });

const round: TrainingRound = {
  id: 'r1',
  name: 'Round 1',
  rubric,
  items: [
    { id: 'i1', roundId: 'r1', traceId: 't1', arm: 'calibration', position: 0 },
    { id: 'i2', roundId: 'r1', traceId: 't2', arm: 'calibration', position: 1 },
    { id: 'i3', roundId: 'r1', traceId: 't3', arm: 'calibration', position: 2 },
  ],
  grades: [
    grade('i1', 's1', 'pass', 'Clean.'), grade('i1', 's2', 'pass', 'Clean.'), grade('i1', 's3', 'pass', 'Clean.'),
    grade('i2', 's1', 'fail', 'The rubric is silent.'), grade('i2', 's2', 'pass', 'Answer up front.'), grade('i2', 's3', 'recoverable', 'A ticket.'),
    grade('i3', 's1', 'pass', 'Fine.'), grade('i3', 's2', 'pass', 'Fine.'), grade('i3', 's3', 'pass', 'Fine.'),
  ],
  userVerdicts: [
    { itemId: 'i1', verdict: 'pass', reason: 'Agreed.' },
    { itemId: 'i3', verdict: 'fail', reason: 'It quoted a delivery date we never confirmed.' },
  ],
  pinnedModels: { 'The literalist': 'anthropic/claude-haiku-4.5', 'The impatient user': 'openai/gpt-5-mini', 'The support lead': 'google/gemini-2.5-flash' },
};

describe('training export', () => {
  const out = buildTrainingExport({ projectName: 'Meridian', seats, traces, rounds: [round], now: '2026-09-14T00:00:00.000Z' });

  it('exports only settled cases the owner did not overrule as examples', () => {
    expect(out.examples.map((e) => e.provenance.case_title)).toEqual(['Settled']);
    expect(out.counts.excluded_unsettled).toBe(1);
    expect(out.counts.excluded_false_settles).toBe(1);
  });

  it('gives an example its label, score, majority rationale, and a chat-shaped row', () => {
    const e = out.examples[0]!;
    expect(e.label).toBe('pass');
    expect(e.score).toBe(1);
    expect(e.rationale).toBe('Clean.');
    expect(e.basis).toBe('panel-settled, owner-checked');
    expect(e.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(e.messages[2]!.content).toBe('pass. Clean.');
  });

  it('carries provenance on every row, down to the pinned model per judge', () => {
    const e = out.examples[0]!;
    expect(e.provenance).toMatchObject({ project: 'Meridian', round_id: 'r1', standard_version: 2, case_id: 't1', case_source: 'scenario', prompt_variant: 0 });
    expect(e.judges.find((j) => j.seat === 'The literalist')?.model).toBe('anthropic/claude-haiku-4.5');
    for (const r of [...out.examples, ...out.gold, ...out.rewards]) expect(r.provenance.exported_at).toBe('2026-09-14T00:00:00.000Z');
  });

  it('keeps the owner’s word as gold, with the panel beside it', () => {
    expect(out.gold).toHaveLength(2);
    const overruled = out.gold.find((g) => g.provenance.case_title === 'Overruled')!;
    expect(overruled.label).toBe('fail');
    expect(overruled.score).toBe(0);
    expect(overruled.panel).toEqual({ verdict: 'pass', pattern: 'settled', agreed_with_owner: false });
    expect(overruled.rationale).toContain('delivery date');
  });

  it('writes one reward row per judge per case, scored on the standard’s scale, pattern attached', () => {
    expect(out.rewards).toHaveLength(9);
    const split = out.rewards.filter((r) => r.provenance.case_title === 'Split');
    expect(split.map((r) => r.score).sort()).toEqual([0, 0.5, 1]);
    expect(new Set(split.map((r) => r.case_pattern))).toEqual(new Set(['contested']));
    expect(split[0]!.judge.stake).toMatch(/wants$/);
  });

  it('normalizes any ordinal scale to 0..1 and leaves abstentions unscored', () => {
    expect(scoreOf('recoverable', rubric)).toBe(0.5);
    expect(scoreOf('__abstain__', rubric)).toBeNull();
    const five = { ...rubric, scale: [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, label: `${n}`, rank: n })) } as RubricVersion;
    expect(scoreOf('s3', five)).toBe(0.5);
  });

  it('serializes to JSONL with a trailing newline and nothing else', () => {
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
    expect(toJsonl([])).toBe('');
  });
});
