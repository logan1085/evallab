/**
 * The trajectory is the view that makes a second round worth running, so the
 * thing worth testing is not that it draws a line — it is that it refuses to
 * draw one between two points that are not comparable.
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

interface Harness {
  slug: string;
  auth: (r: request.Test) => request.Test;
  graders: Record<string, { id: string; name: string }>;
}

async function project(traceCount = 10): Promise<Harness> {
  const { body } = await request(app).post('/api/projects').send({ name: 'P' }).expect(201);
  const p = body.project;
  const auth = (r: request.Test) => r.set('x-gr-token', p.token);
  await auth(
    request(app)
      .post(`/api/projects/${p.slug}/traces`)
      .send({ traces: Array.from({ length: traceCount }, (_, i) => ({ title: `T${i}`, content: `body ${i}` })) }),
  ).expect(201);

  const graders: Harness['graders'] = {};
  for (const name of ['Ana', 'Ben', 'Cass']) {
    graders[name] = (await auth(request(app).post(`/api/projects/${p.slug}/graders`)).send({ name })).body.grader;
  }
  return { slug: p.slug, auth, graders };
}

/** Runs a round to completion. `disagreeEvery` controls how much the panel splits. */
async function runRound(
  h: Harness,
  opts: {
    calibrationSize: number;
    heldoutSize: number;
    strategy?: 'random' | 'from_splits';
    sourceRoundId?: string;
    reuseHeldout?: boolean;
    panel: string[];
    disagreeEvery: number;
  },
) {
  const round = (
    await h
      .auth(request(app).post(`/api/projects/${h.slug}/rounds`))
      .send({
        calibrationSize: opts.calibrationSize,
        heldoutSize: opts.heldoutSize,
        strategy: opts.strategy ?? 'random',
        sourceRoundId: opts.sourceRoundId ?? null,
        reuseHeldout: opts.reuseHeldout ?? true,
      })
      .expect(201)
  ).body.round;

  const first = h.graders[opts.panel[0]!]!;
  const items = (await h.auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${first.id}`))).body.items;

  for (const [i, item] of items.entries()) {
    for (const [gi, name] of opts.panel.entries()) {
      const disagrees = opts.disagreeEvery > 0 && i % opts.disagreeEvery === 0 && gi > 0;
      await h
        .auth(request(app).post(`/api/rounds/${round.id}/grades`))
        .send({ graderId: h.graders[name]!.id, itemId: item.itemId, verdict: disagrees ? 'fail' : 'pass' })
        .expect(200);
    }
  }
  await h.auth(request(app).post(`/api/rounds/${round.id}/close`)).expect(200);
  return round;
}

const trajectory = (h: Harness) =>
  h.auth(request(app).get(`/api/projects/${h.slug}/trajectory`)).expect(200).then((r) => r.body);

describe('trajectory', () => {
  it('reports a delta when the held-out set and the panel both held still', async () => {
    const h = await project();
    const panel = ['Ana', 'Ben'];
    const first = await runRound(h, { calibrationSize: 4, heldoutSize: 4, panel, disagreeEvery: 2 });
    await runRound(h, {
      calibrationSize: 4,
      heldoutSize: 4,
      strategy: 'from_splits',
      sourceRoundId: first.id,
      reuseHeldout: true,
      panel,
      disagreeEvery: 0, // everyone agrees this time
    });

    const { series } = await trajectory(h);
    expect(series).toHaveLength(2);
    expect(series[0].comparableToPrevious).toBe(false);
    expect(series[1].comparableToPrevious).toBe(true);
    expect(series[1].comparabilityNotes).toEqual([]);
    expect(series[1].heldoutDelta).toBeGreaterThan(0);
    expect(series[1].heldout.agreement.observed).toBe(1);
  });

  it('refuses to compare when the held-out traces were redrawn', async () => {
    const h = await project();
    const panel = ['Ana', 'Ben'];
    const first = await runRound(h, { calibrationSize: 3, heldoutSize: 3, panel, disagreeEvery: 2 });
    await runRound(h, {
      calibrationSize: 3,
      heldoutSize: 3,
      strategy: 'from_splits',
      sourceRoundId: first.id,
      reuseHeldout: false, // redrawn
      panel,
      disagreeEvery: 0,
    });

    const { series } = await trajectory(h);
    expect(series[1].comparableToPrevious).toBe(false);
    expect(series[1].heldoutDelta).toBeNull();
    expect(series[1].comparabilityNotes.join(' ')).toMatch(/not the same ones/i);
  });

  it('refuses to compare when the panel changed, and names who moved', async () => {
    const h = await project();
    const first = await runRound(h, { calibrationSize: 4, heldoutSize: 4, panel: ['Ana', 'Ben'], disagreeEvery: 2 });
    await runRound(h, {
      calibrationSize: 4,
      heldoutSize: 4,
      strategy: 'from_splits',
      sourceRoundId: first.id,
      reuseHeldout: true,
      panel: ['Ana', 'Cass'], // Ben out, Cass in
      disagreeEvery: 0,
    });

    const { series } = await trajectory(h);
    expect(series[1].comparableToPrevious).toBe(false);
    const note = series[1].comparabilityNotes.join(' ');
    expect(note).toMatch(/Cass joined/);
    expect(note).toMatch(/Ben did not grade/);
    expect(note).toMatch(/the people, not the rubric/);
  });

  it('carries the rubric version and clause count each round was graded against', async () => {
    const h = await project();
    const first = await runRound(h, { calibrationSize: 4, heldoutSize: 4, panel: ['Ana', 'Ben'], disagreeEvery: 2 });

    const report = (await h.auth(request(app).get(`/api/rounds/${first.id}/report`))).body;
    const split = report.clusters[0].rows[0];
    await h
      .auth(request(app).post(`/api/rounds/${first.id}/items/${split.itemId}/resolve`))
      .send({ agreedVerdict: 'fail', clauseText: 'A sentence the rubric was missing.' })
      .expect(200);
    await h.auth(request(app).post(`/api/rounds/${first.id}/ship`)).expect(201);

    await runRound(h, {
      calibrationSize: 4,
      heldoutSize: 4,
      strategy: 'from_splits',
      sourceRoundId: first.id,
      reuseHeldout: true,
      panel: ['Ana', 'Ben'],
      disagreeEvery: 0,
    });

    const { series } = await trajectory(h);
    expect(series[0].rubricVersion).toBe(1);
    expect(series[0].clauseCount).toBe(0);
    expect(series[1].rubricVersion).toBe(2);
    expect(series[1].clauseCount).toBe(1);
  });

  it('omits rounds that are still open', async () => {
    const h = await project();
    await runRound(h, { calibrationSize: 3, heldoutSize: 3, panel: ['Ana', 'Ben'], disagreeEvery: 2 });
    await h
      .auth(request(app).post(`/api/projects/${h.slug}/rounds`))
      .send({ calibrationSize: 3, heldoutSize: 3 })
      .expect(201);

    const { series, roundsClosed } = await trajectory(h);
    expect(roundsClosed).toBe(1);
    expect(series).toHaveLength(1);
  });

  it('flags a round with no held-out arm rather than plotting it as a drop to zero', async () => {
    const h = await project();
    const first = await runRound(h, { calibrationSize: 4, heldoutSize: 4, panel: ['Ana', 'Ben'], disagreeEvery: 2 });
    await runRound(h, {
      calibrationSize: 4,
      heldoutSize: 0,
      strategy: 'from_splits',
      sourceRoundId: first.id,
      reuseHeldout: false,
      panel: ['Ana', 'Ben'],
      disagreeEvery: 0,
    });

    const { series } = await trajectory(h);
    expect(series[1].heldout.agreement.units).toBe(0);
    expect(series[1].comparableToPrevious).toBe(false);
    expect(series[1].heldoutDelta).toBeNull();
    expect(series[1].comparabilityNotes.join(' ')).toMatch(/no held-out traces/i);
  });
});
