/**
 * The extraction rule is the product: unanimity and explicit resolutions become
 * test cases, live disagreement is excluded rather than averaged, and held-back
 * cases never leave — even unanimous ones. If any of these loosens, the eval
 * set starts holding the AI to a standard the team itself has not met.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildEvalSet, evalSetToJsonl } from '../shared/evalset.js';
import type { Grade, ItemVerdicts, Resolution, RoundItem, Trace } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';

const trace = (id: string, title: string): Trace => ({
  id, projectId: 'p', title, content: `body of ${title}`, source: 'scenario', meta: {},
  expectedVerdict: null, expectedReason: '', createdAt: '',
});
const item = (id: string, traceId: string, arm: 'calibration' | 'heldout' = 'calibration'): RoundItem => ({
  id, roundId: 'r', traceId, arm, position: 0,
});
const votes = (itemId: string, byGrader: Record<string, string>): ItemVerdicts => ({ itemId, byGrader });
const note = (itemId: string, graderId: string, text: string): Grade => ({
  id: `${itemId}-${graderId}`, itemId, graderId, verdict: 'pass', note: text, elapsedMs: 0, createdAt: '',
});

describe('what becomes a test case', () => {
  it('unanimity does; a 2-1 split does not, whatever the majority says', () => {
    const set = buildEvalSet({
      items: [item('i1', 't1'), item('i2', 't2')],
      traces: new Map([['t1', trace('t1', 'Agreed')], ['t2', trace('t2', 'Split')]]),
      verdicts: [
        votes('i1', { a: 'pass', b: 'pass', c: 'pass' }),
        votes('i2', { a: 'pass', b: 'pass', c: 'fail' }),
      ],
      resolutions: [],
      grades: [note('i1', 'a', 'Clean and complete.')],
      embargoed: new Set(),
    });

    expect(set.cases).toHaveLength(1);
    expect(set.cases[0]).toMatchObject({ title: 'Agreed', expected: 'pass', basis: 'unanimous' });
    expect(set.cases[0]!.evidence).toEqual(['Clean and complete.']);
    expect(set.excluded).toEqual([{ title: 'Split', reason: 'unresolved disagreement' }]);
  });

  it('a resolution turns a split into a case, carrying the sentence the team wrote', () => {
    const resolution: Resolution = {
      id: 'res1', itemId: 'i2', agreedVerdict: 'recoverable',
      clauseText: 'Stopping early counts as partial when the gap is named.',
      rationale: 'Settled in the review meeting.', clauseId: null, resolvedBy: 'Ana', createdAt: '',
    };
    const set = buildEvalSet({
      items: [item('i2', 't2')],
      traces: new Map([['t2', trace('t2', 'Split')]]),
      verdicts: [votes('i2', { a: 'pass', b: 'fail' })],
      resolutions: [resolution],
      grades: [],
      embargoed: new Set(),
    });
    expect(set.cases[0]).toMatchObject({ expected: 'recoverable', basis: 'resolved' });
    expect(set.cases[0]!.evidence).toContain('Stopping early counts as partial when the gap is named.');
  });

  it('held-back cases never export, even unanimous ones', () => {
    const set = buildEvalSet({
      items: [item('i3', 't3', 'heldout')],
      traces: new Map([['t3', trace('t3', 'Held back')]]),
      verdicts: [votes('i3', { a: 'pass', b: 'pass', c: 'pass' })],
      resolutions: [],
      grades: [],
      embargoed: new Set(),
    });
    expect(set.cases).toEqual([]);
    expect(set.excluded).toEqual([{ title: 'Held back', reason: 'held back for the next poll' }]);
  });

  it('abstentions are not votes: one real vote is not unanimity', () => {
    const set = buildEvalSet({
      items: [item('i4', 't4')],
      traces: new Map([['t4', trace('t4', 'Thin')]]),
      verdicts: [votes('i4', { a: 'pass', b: 'abstain', c: 'abstain' })],
      resolutions: [],
      grades: [],
      embargoed: new Set(),
    });
    expect(set.cases).toEqual([]);
    expect(set.excluded[0]!.reason).toBe('not enough votes');
  });

  it('jsonl carries one case per line with the input verbatim', () => {
    const set = buildEvalSet({
      items: [item('i1', 't1')],
      traces: new Map([['t1', trace('t1', 'Agreed')]]),
      verdicts: [votes('i1', { a: 'fail', b: 'fail' })],
      resolutions: [],
      grades: [],
      embargoed: new Set(),
    });
    const lines = evalSetToJsonl(set).split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ input: 'body of Agreed', expected: 'fail', title: 'Agreed', basis: 'unanimous' }]);
  });
});

describe('the evalset endpoint', () => {
  let db: DB;
  let app: Express;

  it('refuses an open poll, then extracts from a closed one', async () => {
    db = await testDb();
    app = createApp(db);

    const { project } = (await request(app).post('/api/projects').send({ name: 'Support AI' }).expect(201)).body;
    const auth = (r: request.Test) => r.set('x-gr-token', project.token);

    // The system writes the scenarios (offline scenarist here).
    const generated = (
      await auth(request(app).post(`/api/projects/${project.slug}/scenarios`))
        .send({ description: 'A support agent that answers billing questions and can issue refunds.' })
        .expect(201)
    ).body;
    expect(generated.provider.real).toBe(false);
    expect(generated.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(generated.scenarios[0].probe).toBeTruthy();

    const ana = (await auth(request(app).post(`/api/projects/${project.slug}/graders`)).send({ name: 'Ana' })).body.grader;
    const ben = (await auth(request(app).post(`/api/projects/${project.slug}/graders`)).send({ name: 'Ben' })).body.grader;

    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
        .send({ calibrationSize: 4, heldoutSize: 2 })
        .expect(201)
    ).body.round;

    await auth(request(app).get(`/api/rounds/${round.id}/evalset`)).expect(409);

    // Ben dissents on the first three queue positions. Arms are interleaved
    // randomly and the queue deliberately hides them, so a test keyed to "the
    // split is in calibration" would be flaky — instead dissent lands on three
    // items (only two can be held out, so at least one split is calibration)
    // and the assertions compute from the report rather than assume.
    const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;
    for (const [i, it] of items.entries()) {
      await auth(request(app).post(`/api/rounds/${round.id}/grades`))
        .send({ graderId: ana.id, itemId: it.itemId, verdict: 'pass', note: `ana on ${i}` }).expect(200);
      await auth(request(app).post(`/api/rounds/${round.id}/grades`))
        .send({ graderId: ben.id, itemId: it.itemId, verdict: i < 3 ? 'fail' : 'pass' }).expect(200);
    }
    await auth(request(app).post(`/api/rounds/${round.id}/close`)).expect(200);

    const rows = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body.rows as {
      itemId: string; arm: string; kind: string;
    }[];
    const calUnanimous = rows.filter((r) => r.arm === 'calibration' && r.kind === 'unanimous');
    const calSplits = rows.filter((r) => r.arm === 'calibration' && r.kind !== 'unanimous');
    expect(calSplits.length).toBeGreaterThanOrEqual(1);

    const set = (await auth(request(app).get(`/api/rounds/${round.id}/evalset`)).expect(200)).body;
    expect(set.caseCount).toBe(calUnanimous.length);
    expect(set.cases.every((c: { basis: string }) => c.basis === 'unanimous')).toBe(true);
    const reasons = set.excluded.map((e: { reason: string }) => e.reason);
    expect(reasons.filter((r: string) => r === 'held back for the next poll')).toHaveLength(2);
    expect(reasons.filter((r: string) => r === 'unresolved disagreement')).toHaveLength(calSplits.length);
    expect(set.judgeSystemPrompt).toContain('## Verdict scale');

    // Settle one split; it joins the set with the team's sentence attached.
    await auth(request(app).post(`/api/rounds/${round.id}/items/${calSplits[0]!.itemId}/resolve`))
      .send({ agreedVerdict: 'fail', clauseText: 'A wrong answer fails even when politely delivered.' })
      .expect(200);

    const after = (await auth(request(app).get(`/api/rounds/${round.id}/evalset`)).expect(200)).body;
    expect(after.caseCount).toBe(calUnanimous.length + 1);
    const resolved = after.cases.find((c: { basis: string }) => c.basis === 'resolved');
    expect(resolved.evidence).toContain('A wrong answer fails even when politely delivered.');

    // And the jsonl download is one line per case.
    const jsonl = (await auth(request(app).get(`/api/rounds/${round.id}/evalset?format=jsonl`)).expect(200)).text;
    expect(jsonl.trim().split('\n')).toHaveLength(calUnanimous.length + 1);
  }, 30_000);
});
