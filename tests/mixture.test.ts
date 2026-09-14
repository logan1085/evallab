/**
 * The mixture's second axis: prompt variants and the stability pass.
 *
 * The rule under test: a disagreement counts only when it survives
 * paraphrase. A seat that flips between phrasings of the same standard is
 * unstable on that case; its vote is shown and never mined, and the case is
 * read on the votes that held.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { PROMPT_VARIANTS, buildSeatSystemPrompt } from '../shared/panel.js';
import { offlineAdapter } from '../server/panelists.js';
import { readCase, stableVotes } from '../shared/panelmap.js';

const seat = { id: 's', name: 'The support lead', objective: 'Wants the conversation to end resolved.', failsFor: 'Fails anything that would generate a follow-up ticket.', model: 'simulated', family: 'offline' };
const rubric = '# Standards\n\n- The answer to the question asked appears in the first two sentences.\n- Refunds over $50 need a human.';

describe('prompt variants', () => {
  it('there are three, and they differ from each other', () => {
    const prompts = Array.from({ length: PROMPT_VARIANTS }, (_, i) => buildSeatSystemPrompt(seat, rubric, i));
    expect(new Set(prompts).size).toBe(PROMPT_VARIANTS);
  });

  it('every variant carries the standard verbatim and the seat’s stake', () => {
    for (let i = 0; i < PROMPT_VARIANTS; i++) {
      const p = buildSeatSystemPrompt(seat, rubric, i);
      expect(p).toContain(rubric);
      expect(p).toContain(seat.objective);
      expect(p).toContain(seat.failsFor);
      expect(p).toMatch(/pass/);
      expect(p).toMatch(/recoverable/);
      expect(p).toMatch(/fail/);
      expect(p).not.toMatch(/—/);
    }
  });

  it('variant 0 is the canonical prompt, and variants wrap around', () => {
    expect(buildSeatSystemPrompt(seat, rubric)).toBe(buildSeatSystemPrompt(seat, rubric, 0));
    expect(buildSeatSystemPrompt(seat, rubric, PROMPT_VARIANTS)).toBe(buildSeatSystemPrompt(seat, rubric, 0));
  });
});

describe('the simulation under paraphrase', () => {
  it('is deterministic per variant and reproduces variant 0 exactly as before', async () => {
    const sim = offlineAdapter();
    const req = { seat, rubricMarkdown: rubric, caseId: 'c', caseTitle: 'A quiet case', caseContent: 'The AI answers the question plainly.' };
    const a = await sim.score({ ...req, variant: 0 });
    const b = await sim.score(req);
    const c = await sim.score({ ...req, variant: 1 });
    const c2 = await sim.score({ ...req, variant: 1 });
    expect(a).toEqual(b);
    expect(c).toEqual(c2);
  });

  it('flips at least one fallback case somewhere across a set of titles, so the stability UI has something to show', async () => {
    const sim = offlineAdapter();
    let flips = 0;
    for (const title of ['Case A', 'Case B', 'Case C', 'Case D', 'Case E', 'Case F', 'Case G', 'Case H']) {
      const req = { seat, rubricMarkdown: rubric, caseId: title, caseTitle: title, caseContent: 'An ordinary request, completed plainly.' };
      const v0 = (await sim.score({ ...req, variant: 0 })).verdict;
      const v1 = (await sim.score({ ...req, variant: 1 })).verdict;
      const v2 = (await sim.score({ ...req, variant: 2 })).verdict;
      if (v0 !== v1 || v0 !== v2) flips++;
    }
    expect(flips).toBeGreaterThan(0);
  });
});

describe('the reading survives paraphrase', () => {
  it('drops unstable votes before deciding whether the panel split', () => {
    const votes = [
      { seatId: 'a', seatName: 'A', verdict: 'pass', reason: 'Fine.', stable: true },
      { seatId: 'b', seatName: 'B', verdict: 'pass', reason: 'Fine.', stable: true },
      { seatId: 'c', seatName: 'C', verdict: 'fail', reason: 'Not fine.', stable: false },
    ];
    expect(readCase('i', votes).pattern).toBe('persona-driven');
    expect(readCase('i', stableVotes(votes)).pattern).toBe('settled');
    expect(stableVotes([{ seatId: 'a', seatName: 'A', verdict: 'pass', reason: 'x' }])).toHaveLength(1);
  });
});

describe('POST /rounds/:id/stability', () => {
  let app: Express;
  let db: DB;
  beforeEach(async () => {
    db = await testDb();
    app = createApp(db);
  });

  it('rechecks only the non-unanimous cases, records every variant, and marks flips unstable', async () => {
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Mixture Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    const { slug, token } = created.body.project;
    const auth = { 'x-gr-token': token };
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
    await request(app).post(`/api/v1/projects/${slug}/scenarios`).set(auth).send({ description: 'A support agent for a bike shop.' }).expect(201);
    const round = await request(app).post(`/api/v1/projects/${slug}/panel-rounds`).set(auth).expect(201);
    const roundId = round.body.round.id as string;

    // Before every seat has graded, the pass refuses.
    await request(app).post(`/api/v1/rounds/${roundId}/stability`).set(auth).expect(409);
    for (const s of round.body.seats as { id: string }[]) {
      await request(app).post(`/api/v1/rounds/${roundId}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    }

    const before = await request(app).get(`/api/v1/rounds/${roundId}/map`).set(auth).expect(200);
    const contestedBefore = before.body.cases.filter((c: { pattern: string }) => c.pattern !== 'settled' && c.pattern !== 'blind-spot').length;

    const pass = await request(app).post(`/api/v1/rounds/${roundId}/stability`).set(auth).expect(200);
    expect(pass.body.variants).toBe(PROMPT_VARIANTS);
    expect(pass.body.checked).toBe(contestedBefore);
    expect(pass.body.rechecked).toBe(contestedBefore * (round.body.seats as unknown[]).length);
    expect(pass.body.simulated).toBe(true);

    const after = await request(app).get(`/api/v1/rounds/${roundId}/map`).set(auth).expect(200);
    const votes = after.body.cases.flatMap((c: { votes: { stable: boolean; agreement: number }[] }) => c.votes);
    expect(votes.every((v: { agreement: number }) => v.agreement > 0 && v.agreement <= 1)).toBe(true);
    const unstable = votes.filter((v: { stable: boolean }) => !v.stable);
    expect(unstable.length).toBe(pass.body.unstable);
    // Every unstable vote is on a case the first pass contested; settled
    // cases were never rechecked, so their votes stay stable by definition.
    for (const c of after.body.cases as { pattern: string; votes: { stable: boolean }[] }[]) {
      if (before.body.cases.find((b: { itemId: string }) => b.itemId === (c as unknown as { itemId: string }).itemId)?.pattern === 'settled') {
        expect(c.votes.every((v) => v.stable)).toBe(true);
      }
    }
    // A case that settled once the unstable votes were set aside says so.
    const newlySettled = after.body.cases.filter((c: { pattern: string; unstableDissent: boolean }) => c.pattern === 'settled' && c.unstableDissent);
    for (const c of newlySettled) expect(c.votes.some((v: { stable: boolean }) => !v.stable)).toBe(true);
  });
});
