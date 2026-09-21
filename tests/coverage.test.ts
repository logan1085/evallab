/**
 * The coverage map.
 *
 * What these pin: every written scenario carries the ground it was written
 * for; pasted transcripts are their own class; the map counts each class
 * and reads the last finished round per class; gaps are named with the
 * action that fills them; and asking for one ground writes only that.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { classOf, coverageMap } from '../shared/coverage.js';
import { scenarioBatches } from '../shared/scenarios.js';

describe('coverageMap', () => {
  const c = (id: string, meta: Record<string, unknown>, source = 'scenario') => ({ id, title: id, source, meta });

  it('classes cases by stamped ground, by probe for older scenarios, and pasted ones as real', () => {
    expect(classOf(c('a', { ground: 'boundary' }))).toBe('boundary');
    expect(classOf(c('b', { generated: true, probe: 'What happens at the edge of the rules.' }))).toBe('boundary');
    expect(classOf(c('c', { generated: true, probe: 'The anchor case.' }))).toBe('clear');
    expect(classOf(c('d', {}, 'paste'))).toBe('real');
    expect(classOf(c('e', {}, 'jsonl'))).toBe('real');
  });

  it('counts each class, reads the round per class, and names the gaps', () => {
    const map = coverageMap(
      [c('1', { ground: 'clear' }), c('2', { ground: 'clear' }), c('3', { ground: 'boundary' }), c('4', { ground: 'boundary' }), c('5', { ground: 'boundary' })],
      [
        { caseId: '1', pattern: 'settled', verdict: 'pass' },
        { caseId: '2', pattern: 'settled', verdict: 'fail' },
        { caseId: '3', pattern: 'settled', verdict: 'pass' },
        { caseId: '4', pattern: 'settled', verdict: 'pass' },
        { caseId: '5', pattern: 'settled', verdict: 'pass' },
      ],
      'pass',
    );
    expect(map.total).toBe(5);
    const clear = map.rows.find((r) => r.id === 'clear')!;
    expect(clear).toMatchObject({ cases: 2, graded: 2, splits: 0, pass_rate: 0.5 });
    expect(map.rows.find((r) => r.id === 'unimagined')!.cases).toBe(0);
    expect(map.gaps.map((g) => g.id).sort()).toEqual(['boundary', 'real', 'unimagined']);
    expect(map.gaps.find((g) => g.id === 'boundary')!.reason).toMatch(/settled every boundary case/);
    expect(map.gaps.find((g) => g.id === 'real')!.reason).toMatch(/Paste one/);
  });

  it('asks for one ground alone when told to', () => {
    expect(scenarioBatches(4, 'boundary')).toEqual([{ index: 0, of: 1, count: 4, ground: 'boundary', focus: expect.stringMatching(/^boundary cases/) }]);
    expect(scenarioBatches(12).map((b) => b.ground)).toEqual(['clear', 'boundary', 'unimagined']);
  });
});

describe('GET /projects/:slug/coverage', () => {
  let app: Express;
  let db: DB;
  let slug: string;
  let auth: Record<string, string>;

  beforeEach(async () => {
    db = await testDb();
    app = createApp(db);
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Coverage Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    slug = created.body.project.slug;
    auth = { 'x-gr-token': created.body.project.token };
  });

  it('stamps written scenarios with their ground, counts the classes, and fills a gap by ground', async () => {
    await request(app).post(`/api/v1/projects/${slug}/scenarios`).set(auth).send({ description: 'A support agent for a bike shop that answers order questions.' }).expect(201);
    let cov = (await request(app).get(`/api/v1/projects/${slug}/coverage`).set(auth).expect(200)).body;
    expect(cov.total).toBe(6);
    expect(cov.round).toBeNull();
    const by = Object.fromEntries(cov.rows.map((r: { id: string; cases: number }) => [r.id, r.cases]));
    expect(by).toEqual({ clear: 1, boundary: 3, unimagined: 2, real: 0 });
    expect(cov.gaps.map((g: { id: string }) => g.id)).toEqual(['real']);

    await request(app).post(`/api/v1/projects/${slug}/traces`).set(auth).send({ traces: [{ title: 'Real one', content: 'USER: hi. ASSISTANT: hello.' }] }).expect(201);
    const more = await request(app).post(`/api/v1/projects/${slug}/scenarios`).set(auth).send({ description: 'A support agent for a bike shop.', count: 4, ground: 'clear' }).expect(201);
    expect(more.body.scenarios.length).toBeGreaterThanOrEqual(1);
    cov = (await request(app).get(`/api/v1/projects/${slug}/coverage`).set(auth).expect(200)).body;
    expect(cov.rows.find((r: { id: string }) => r.id === 'real').cases).toBe(1);
    expect(cov.rows.find((r: { id: string }) => r.id === 'clear').cases).toBeGreaterThanOrEqual(2);
    expect(cov.gaps).toEqual([]);

    // A finished round reads each class.
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
    const round = await request(app).post(`/api/v1/projects/${slug}/panel-rounds`).set(auth).expect(201);
    for (const s of round.body.seats) await request(app).post(`/api/v1/rounds/${round.body.round.id}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    cov = (await request(app).get(`/api/v1/projects/${slug}/coverage`).set(auth).expect(200)).body;
    expect(cov.round.id).toBe(round.body.round.id);
    expect(cov.rows.reduce((n: number, r: { graded: number }) => n + r.graded, 0)).toBe(cov.total);
    await request(app).get(`/api/v1/projects/${slug}/coverage`).expect(401);
  });
});
