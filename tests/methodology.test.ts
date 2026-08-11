/**
 * Guards on the two ways this product could report an improvement it did not
 * earn. Both are about the held-out arm, because the held-out arm is the only
 * thing standing behind the claim "agreement improved after calibration".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb, type DB } from '../server/db.js';

let db: DB;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

/** A closed round where every single item is a polar split, held-out included. */
async function roundWhereEverythingSplits() {
  const { body } = await request(app).post('/api/projects').send({ name: 'P' }).expect(201);
  const project = body.project;
  const auth = (r: request.Test) => r.set('x-gr-token', project.token);

  await auth(
    request(app)
      .post(`/api/projects/${project.slug}/traces`)
      .send({ traces: Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, content: `body ${i}` })) }),
  ).expect(201);

  const ana = (await auth(request(app).post(`/api/projects/${project.slug}/graders`)).send({ name: 'Ana' })).body.grader;
  const ben = (await auth(request(app).post(`/api/projects/${project.slug}/graders`)).send({ name: 'Ben' })).body.grader;

  const round = (
    await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 4, heldoutSize: 2 })
      .expect(201)
  ).body.round;

  const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;
  for (const item of items) {
    await auth(request(app).post(`/api/rounds/${round.id}/grades`))
      .send({ graderId: ana.id, itemId: item.itemId, verdict: 'pass', note: `ana-on-${item.title}` })
      .expect(200);
    await auth(request(app).post(`/api/rounds/${round.id}/grades`))
      .send({ graderId: ben.id, itemId: item.itemId, verdict: 'fail', note: `ben-on-${item.title}` })
      .expect(200);
  }
  await auth(request(app).post(`/api/rounds/${round.id}/close`)).expect(200);

  return { project, auth, round, ana, ben };
}

describe('the held-out arm is not writable', () => {
  it('refuses to resolve a held-out split — that would be writing the rubric against the test set', async () => {
    const { auth, round } = await roundWhereEverythingSplits();
    const report = (await auth(request(app).get(`/api/rounds/${round.id}/report`)).expect(200)).body;

    const heldout = report.rows.filter((r: { arm: string; kind: string }) => r.arm === 'heldout');
    expect(heldout.length).toBe(2);
    expect(heldout.every((r: { kind: string }) => r.kind === 'polar')).toBe(true);

    const res = await auth(request(app).post(`/api/rounds/${round.id}/items/${heldout[0].itemId}/resolve`))
      .send({ agreedVerdict: 'fail', clauseText: 'A clause aimed squarely at the measurement set.' })
      .expect(400);
    expect(res.body.error).toMatch(/held-out/i);
  });

  it('never offers a held-out split for resolution in the clusters', async () => {
    const { auth, round } = await roundWhereEverythingSplits();
    const report = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body;

    const clustered = report.clusters.flatMap((c: { rows: { arm: string }[] }) => c.rows);
    expect(clustered.length).toBe(4);
    expect(clustered.every((r: { arm: string }) => r.arm === 'calibration')).toBe(true);

    // Counted and shown, just not actionable.
    expect(report.splitCount).toBe(4);
    expect(report.heldoutSplitCount).toBe(2);
  });

  it('still counts held-out splits in the agreement statistics', async () => {
    const { auth, round } = await roundWhereEverythingSplits();
    const report = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body;
    expect(report.heldout.agreement.units).toBe(2);
    expect(report.heldout.agreement.observed).toBe(0);
  });
});

describe('reused traces are embargoed while a later round is open', () => {
  async function reuseHeldout() {
    const { project, auth, round } = await roundWhereEverythingSplits();
    const reused = new Set<string>(
      (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body.rows
        .filter((r: { arm: string }) => r.arm === 'heldout')
        .map((r: { traceId: string }) => r.traceId),
    );
    const second = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
        .send({ calibrationSize: 3, heldoutSize: 2, strategy: 'from_splits', sourceRoundId: round.id, reuseHeldout: true })
        .expect(201)
    ).body.round;
    return { project, auth, round, second, reused };
  }

  it('withholds the earlier round\'s verdicts and notes for every reused trace', async () => {
    const { auth, round, second, reused } = await reuseHeldout();
    const report = (await auth(request(app).get(`/api/rounds/${round.id}/report`)).expect(200)).body;

    const reusedRows = report.rows.filter((r: { traceId: string }) => reused.has(r.traceId));
    expect(reusedRows.length).toBe(2);
    for (const row of reusedRows) {
      expect(row.embargoed).toBe(true);
      expect(Object.keys(row.byGrader)).toHaveLength(0);
    }
    // The embargo covers everything the later round is grading, not just the
    // reused held-out traces: round two's calibration items are drawn from
    // round one's splits, and those verdicts would anchor just as hard.
    const secondItemCount = (await auth(request(app).get(`/api/rounds/${second.id}`))).body.itemCount;
    expect(report.embargoedCount).toBe(secondItemCount);
    expect(report.embargoedCount).toBeGreaterThan(reusedRows.length);

    const reusedItemIds = new Set(reusedRows.map((r: { itemId: string }) => r.itemId));
    expect(report.notes.filter((n: { itemId: string }) => reusedItemIds.has(n.itemId))).toHaveLength(0);

    // Nothing anywhere in the payload carries a verdict for a reused trace.
    const serialized = JSON.stringify(report.rows.filter((r: { traceId: string }) => reused.has(r.traceId)));
    expect(serialized).not.toContain('ana-on-');
    expect(serialized).not.toContain('ben-on-');
  });

  it('leaves traces the later round did not take fully visible', async () => {
    const { auth, round, reused } = await reuseHeldout();
    const report = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body;
    const untouched = report.rows.filter((r: { traceId: string; embargoed?: boolean }) => !reused.has(r.traceId) && !r.embargoed);
    expect(untouched.length).toBeGreaterThan(0);
    for (const row of untouched) expect(Object.keys(row.byGrader).length).toBe(2);
  });

  it('keeps the closed round\'s own statistics stable while the embargo is on', async () => {
    const { project, auth, round } = await roundWhereEverythingSplits();
    const before = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body;

    await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 3, heldoutSize: 2, strategy: 'from_splits', sourceRoundId: round.id, reuseHeldout: true })
      .expect(201);

    const after = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body;
    expect(after.overall.agreement.observed).toBe(before.overall.agreement.observed);
    expect(after.heldout.agreement.units).toBe(before.heldout.agreement.units);
  });

  it('restores the verdicts once the later round closes', async () => {
    const { auth, round, second, reused } = await reuseHeldout();

    const graders = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body.graders as { id: string }[];
    const items = (await auth(request(app).get(`/api/rounds/${second.id}/queue?graderId=${graders[0]!.id}`))).body.items;

    for (const item of items) {
      for (const grader of graders) {
        await auth(request(app).post(`/api/rounds/${second.id}/grades`))
          .send({ graderId: grader.id, itemId: item.itemId, verdict: 'pass' })
          .expect(200);
      }
    }
    await auth(request(app).post(`/api/rounds/${second.id}/close`)).expect(200);

    const report = (await auth(request(app).get(`/api/rounds/${round.id}/report`))).body;
    const reusedRows = report.rows.filter((r: { traceId: string }) => reused.has(r.traceId));
    expect(reusedRows).toHaveLength(2);
    for (const row of reusedRows) {
      expect(row.embargoed).toBeUndefined();
      expect(Object.keys(row.byGrader)).toHaveLength(2);
    }
  });
});
