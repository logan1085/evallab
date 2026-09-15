/**
 * Drift: the same eval read over time.
 *
 * What these pin: the report reads one standard version at a time, the
 * baseline is the oldest run in the window, the trend needs a whole point
 * of pass rate to say anything, each threshold fails with a reason that
 * names the runs, and the route builds the series from finished runs only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { driftReport, parseDriftSpec, type RunPoint } from '../shared/drift.js';

const point = (name: string, pass_rate: number | null, extra: Partial<RunPoint> = {}): RunPoint => ({
  id: name,
  name,
  at: `2026-09-0${name.length}T00:00:00Z`,
  standards_version: 1,
  cases: 10,
  decided: 10,
  pass_rate,
  splits: 1,
  new_splits: 0,
  unstable_votes: 0,
  flipped: 0,
  ...extra,
});

describe('driftReport', () => {
  it('compares the latest run with the oldest in the window, on one standard version', () => {
    const r = driftReport(
      [point('r1', 0.9), point('r2', 0.9, { standards_version: 2 }), point('r3', 0.8, { standards_version: 2 }), point('r4', 0.7, { standards_version: 2 })],
      { window: 2 },
    );
    expect(r.standards_version).toBe(2);
    expect(r.series.map((p) => p.name)).toEqual(['r3', 'r4']);
    expect(r.baseline?.name).toBe('r3');
    expect(r.delta.pass_rate).toBeCloseTo(-0.1);
    expect(r.trend).toBe('degrading');
    expect(r.drifted).toBe(false);
  });

  it('needs two runs, and a whole point, before it names a trend', () => {
    expect(driftReport([point('r1', 0.9)]).trend).toBe('insufficient');
    expect(driftReport([point('r1', 0.9), point('r2', 0.905)]).trend).toBe('steady');
    expect(driftReport([point('r1', 0.8), point('r2', 0.9)]).trend).toBe('improving');
    expect(driftReport([point('r1', null), point('r2', 0.9)]).trend).toBe('insufficient');
  });

  it('fails each threshold with a reason that names the runs', () => {
    const r = driftReport([point('r1', 0.9), point('r2', 0.8, { flipped: 2, new_splits: 1 })], parseDriftSpec('pass-rate-drop:0.05,flips:0,new-splits:0,window:5'));
    expect(r.drifted).toBe(true);
    expect(r.reasons).toHaveLength(3);
    expect(r.reasons[0]).toMatch(/fell 10 points from r1 \(90%\) to r2 \(80%\)/);
    expect(r.reasons[1]).toMatch(/2 cases flipped/);
    expect(r.reasons[2]).toMatch(/1 new split/);
    expect(parseDriftSpec(undefined)).toEqual({});
    expect(driftReport([point('r1', 0.9), point('r2', 0.88)], { max_pass_rate_drop: 0.05 }).drifted).toBe(false);
  });
});

describe('GET /projects/:slug/drift', () => {
  let app: Express;
  let db: DB;
  let slug: string;
  let auth: Record<string, string>;

  beforeEach(async () => {
    db = await testDb();
    app = createApp(db);
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Drift Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    slug = created.body.project.slug;
    auth = { 'x-gr-token': created.body.project.token };
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
  });

  const cases = [
    { title: 'Refund under the cap', content: 'USER: refund my $30 order. ASSISTANT: Done, $30 refunded to your card.' },
    { title: 'Refund over the cap', content: 'USER: refund my $90 order. ASSISTANT: I have refunded $90.' },
    { title: 'Plain answer', content: 'USER: where is my order? ASSISTANT: It shipped yesterday.' },
  ];

  async function finish(name: string) {
    const created = await request(app).post(`/api/v1/projects/${slug}/runs`).set(auth).send({ cases, name }).expect(201);
    const { run, seats } = created.body;
    for (const s of seats) await request(app).post(`/api/v1/rounds/${run.roundId}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    return run.id as string;
  }

  it('builds the series from finished runs only and reads the thresholds from the query', async () => {
    expect((await request(app).get(`/api/v1/projects/${slug}/drift`).set(auth).expect(200)).body.points).toEqual([]);
    await finish('Week 1');
    await finish('Week 2');
    // An unfinished run is not a reading.
    await request(app).post(`/api/v1/projects/${slug}/runs`).set(auth).send({ cases, name: 'Week 3, still grading' }).expect(201);

    const res = await request(app).get(`/api/v1/projects/${slug}/drift?window=5&pass_rate_drop=0.05&flips=0`).set(auth).expect(200);
    expect(res.body.points.map((p: { name: string }) => p.name)).toEqual(['Week 1', 'Week 2']);
    expect(res.body.report.spec).toEqual({ window: 5, max_pass_rate_drop: 0.05, max_flips: 0 });
    expect(res.body.report.baseline.name).toBe('Week 1');
    expect(res.body.report.latest.name).toBe('Week 2');
    // The simulation is deterministic per title: two identical readings, no drift.
    expect(res.body.report.delta.pass_rate).toBe(0);
    expect(res.body.points[1].flipped).toBe(0);
    expect(res.body.report.trend).toBe('steady');
    expect(res.body.report.drifted).toBe(false);
    await request(app).get(`/api/v1/projects/${slug}/drift`).expect(401);
  });
});
