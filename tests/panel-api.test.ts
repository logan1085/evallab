/**
 * The synthetic panel, end to end over the wire: seats generated, every seat
 * grading blind, the map read, patches grounded, the owner's ten, false
 * settles, and the export bundle. All offline: the loop must run with no keys,
 * clearly labeled simulated, or the product has a hard dependency it never
 * admits to.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';

let db: DB;
let app: Express;

beforeEach(async () => {
  db = await testDb();
  app = createApp(db);
});

async function makePanelProject() {
  const { project } = (
    await request(app).post('/api/projects').send({
      name: 'Panel test',
      description: 'A support agent that answers billing questions and can refund up to $50 without approval.',
    }).expect(201)
  ).body;
  const auth = (r: request.Test) => r.set('x-gr-token', project.token);
  return { project, auth };
}

describe('the synthetic panel', () => {
  it('runs the whole loop: seats, blind round, map, patches, the ten, bundle', async () => {
    const { project, auth } = await makePanelProject();

    // 1. Panel generation: literalist seated structurally, offline labeled.
    const panel = (await auth(request(app).post(`/api/projects/${project.slug}/panel`)).expect(201)).body;
    expect(panel.real).toBe(false);
    expect(panel.seats.length).toBe(6);
    expect(panel.seats[0].name).toBe('The literalist');
    expect(panel.seats.every((s: { kind: string }) => s.kind === 'panelist')).toBe(true);

    // Idempotent: a second call returns the same panel, never regenerates.
    const again = (await auth(request(app).post(`/api/projects/${project.slug}/panel`)).expect(200)).body;
    expect(again.generated).toBe(false);
    expect(again.seats.length).toBe(6);

    // 2. Panel edits are recorded as signal.
    const seatToEdit = panel.seats.find((s: { name: string }) => s.name.includes('safety'));
    await auth(request(app).patch(`/api/projects/${project.slug}/panel/seats/${seatToEdit.id}`))
      .send({ name: 'The compliance reviewer', objective: 'Wants nothing said a regulator could read as a promise.', failsFor: 'Fails anything that commits the company to an outcome.', note: 'Our real risk is the regulator.' })
      .expect(200);
    const seatToDelete = panel.seats.find((s: { name: string }) => s.name.includes('cost'));
    await auth(request(app).delete(`/api/projects/${project.slug}/panel/seats/${seatToDelete.id}`)).expect(204);

    // 3. The round: every remaining seat grades every case, then it closes itself.
    const created = (await auth(request(app).post(`/api/projects/${project.slug}/panel-rounds`)).expect(201)).body;
    expect(created.cases).toBe(6);
    let closed = false;
    for (const seat of created.seats) {
      const run = (
        await auth(request(app).post(`/api/rounds/${created.round.id}/panel-run`)).send({ seatId: seat.id }).expect(200)
      ).body;
      expect(run.graded).toBe(6);
      expect(run.simulated).toBe(true);
      closed = run.closed;
    }
    expect(closed).toBe(true);

    // 4. The map: every case read, agreement numbers with AC1 beside alpha,
    // pinned versions, telemetry-backed cost, and per-seat self-consistency.
    const map = (await auth(request(app).get(`/api/rounds/${created.round.id}/map`)).expect(200)).body;
    expect(map.cases.length).toBe(6);
    expect(map.simulated).toBe(true);
    expect(Object.keys(map.pinnedModels).length).toBe(5);
    expect(map.cost.attempts).toBeGreaterThanOrEqual(30); // 5 seats x 6 cases, simulated telemetry
    expect(map.cost.totalCredits).toBe(0); // simulation is free, and says so in numbers
    for (const seat of map.seats) {
      expect(seat.selfConsistency).not.toBeNull();
      // The simulation is deterministic, so every seat agrees with itself.
      expect(seat.selfConsistency.rate).toBe(1);
      expect(seat.selfConsistency.flagged).toBe(false);
      expect(seat.weight).toBe(1);
    }
    const patterns = new Set(map.cases.map((c: { pattern: string }) => c.pattern));
    expect(patterns.size).toBeGreaterThan(1); // the offline personas genuinely split
    for (const c of map.cases) {
      expect(c.votes.length).toBe(5);
      for (const v of c.votes) expect(v.reason.length).toBeGreaterThan(5);
    }
    expect(map.counts.settled + map.counts.personaDriven + map.counts.contested + map.counts.blindSpots).toBe(6);

    // Settled cases are provisional until the owner checks them.
    for (const c of map.cases.filter((x: { pattern: string }) => x.pattern === 'settled')) {
      expect(c.provisional).toBe(true);
    }

    // 5. Patches: grounded in verbatim quotes or not shown.
    const mined = (await auth(request(app).post(`/api/rounds/${created.round.id}/patches`)).expect(201)).body;
    for (const p of mined.patches) {
      expect(p.evidence.length).toBeGreaterThanOrEqual(2);
      for (const e of p.evidence) {
        const c = map.cases.find((x: { itemId: string }) => x.itemId === e.itemId);
        const vote = c.votes.find((v: { seatName: string }) => v.seatName === e.seat);
        expect(vote.reason).toContain(e.quote);
      }
    }

    // Accepting a patch writes rubric v2 with the sentence in it.
    if (mined.patches.length > 0) {
      const accepted = (
        await auth(request(app).patch(`/api/rounds/${created.round.id}/patches/${mined.patches[0].id}`))
          .send({ action: 'accept' })
          .expect(200)
      ).body;
      expect(accepted.rubric.version).toBe(2);
      expect(accepted.rubric.criteria.some((c: { body: string }) => c.body === mined.patches[0].text)).toBe(true);
    }

    // 6. The owner's ten: sampled across patterns, graded, disagreement surfaces.
    const check = (await auth(request(app).get(`/api/rounds/${created.round.id}/self-check`)).expect(200)).body;
    expect(check.cases.length).toBeGreaterThanOrEqual(4);
    const settledCase = map.cases.find((c: { pattern: string }) => c.pattern === 'settled');
    for (const c of check.cases) {
      const isTheSettledOne = settledCase && c.itemId === settledCase.itemId;
      const disagree = isTheSettledOne ? (settledCase.votes[0].verdict === 'fail' ? 'pass' : 'fail') : 'pass';
      await auth(request(app).post(`/api/rounds/${created.round.id}/self-check`))
        .send({ itemId: c.itemId, verdict: disagree, reason: isTheSettledOne ? 'My business says otherwise.' : 'Fine.' })
        .expect(200);
    }

    const alignment = (await auth(request(app).get(`/api/rounds/${created.round.id}/alignment`)).expect(200)).body;
    expect(alignment.graded).toBe(check.cases.length);
    expect(alignment.seats.length).toBe(5);
    if (settledCase && check.cases.some((c: { itemId: string }) => c.itemId === settledCase.itemId)) {
      expect(alignment.falseSettles.length).toBeGreaterThanOrEqual(1);
      expect(alignment.falseSettles[0].yourReason).toBe('My business says otherwise.');
    }

    // 7. The bundle: files, and a false settle never ships as golden.
    const bundle = (await auth(request(app).get(`/api/rounds/${created.round.id}/bundle`)).expect(200)).body;
    expect(bundle.rubricMarkdown.length).toBeGreaterThan(50);
    expect(bundle.judgeSystemPrompt.length).toBeGreaterThan(50);
    expect(bundle.panel.length).toBe(5);
    expect(bundle.panelEdits.length).toBe(2); // the rewrite and the delete
    expect(bundle.rerunScript).toContain('panel-run');
    for (const line of bundle.goldenJsonl.split('\n').filter(Boolean)) {
      const parsed = JSON.parse(line);
      expect(['panel-settled, provisional', 'panel-settled, owner-checked']).toContain(parsed.basis);
      if (settledCase) expect(parsed.title === settledCase.title && parsed.basis === 'panel-settled, owner-checked').toBe(false);
    }
  }, 30_000);

  it('refuses a panel round with fewer than three seats', async () => {
    const { project, auth } = await makePanelProject();
    await auth(request(app).post(`/api/projects/${project.slug}/panel`)).expect(201);
    const seats = (await auth(request(app).get(`/api/projects/${project.slug}`)).expect(200)).body.graders
      .filter((g: { kind: string }) => g.kind === 'panelist');
    for (const seat of seats.slice(0, 4)) {
      await auth(request(app).delete(`/api/projects/${project.slug}/panel/seats/${seat.id}`)).expect(204);
    }
    const res = await auth(request(app).post(`/api/projects/${project.slug}/panel-rounds`)).expect(400);
    expect(res.body.error).toMatch(/three seats/i);
  });
});
