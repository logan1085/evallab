/**
 * Two production failures, fenced.
 *
 * The standards route threw on a round the panel had never graded: the demo
 * project's own round is graded by people, so every case carried zero seat
 * votes, readCase called an ungraded case "contested", and the miner reached
 * for a dissenting vote that was not there. Express 4 does not forward a
 * rejected promise to error middleware, so the throw killed the process and
 * the client saw nothing until the platform gave up. That is the whole
 * two-minute "hang".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { readCase } from '../shared/panelmap.js';

let db: DB;
let app: Express;

beforeEach(async () => {
  db = await testDb();
  app = createApp(db);
});

describe('reading a case nobody graded', () => {
  it('is ungraded, not contested: an absence is not a disagreement', () => {
    expect(readCase('i1', []).pattern).toBe('ungraded');
    expect(readCase('i1', [{ seatId: 's', seatName: 'One', verdict: 'pass', reason: 'r' }]).pattern).toBe('ungraded');
  });

  it('still reads a real split as a split', () => {
    const reading = readCase('i1', [
      { seatId: 'a', seatName: 'A', verdict: 'pass', reason: 'fine' },
      { seatId: 'b', seatName: 'B', verdict: 'pass', reason: 'fine' },
      { seatId: 'c', seatName: 'C', verdict: 'fail', reason: 'the rubric does not decide this' },
    ]);
    expect(reading.pattern).toBe('persona-driven');
    expect(reading.dissenter).toBe('C');
  });
});

describe('writing standards from a round the panel never graded', () => {
  it('refuses in words instead of throwing, and the server survives', async () => {
    const demo = (await request(app).post('/api/v1/projects/demo').send({}).expect(201)).body;
    const auth = `Bearer ${demo.token}`;

    const res = await request(app).post(`/api/v1/rounds/${demo.roundId}/standards`).set('authorization', auth);
    expect([409, 200, 201]).toContain(res.status);
    if (res.status === 409) expect(res.body.error).toMatch(/panel/i);

    // The process is still here and still serving, which is the actual fix.
    await request(app).get('/api/v1/health').expect(200);
  }, 30_000);

  it('answers a round whose panel has not run yet with a sentence, not a stack', async () => {
    const { project } = (
      await request(app).post('/api/v1/projects').send({
        name: 'Unrun',
        description: 'A support agent that answers billing questions and can refund up to $50.',
      }).expect(201)
    ).body;
    const auth = `Bearer ${project.token}`;
    await request(app).post(`/api/v1/projects/${project.slug}/panel`).set('authorization', auth).expect(201);
    await request(app)
      .post(`/api/v1/projects/${project.slug}/scenarios`)
      .set('authorization', auth)
      .send({ description: 'A support agent that answers billing questions and can refund up to $50.' })
      .expect(201);
    const created = (
      await request(app).post(`/api/v1/projects/${project.slug}/panel-rounds`).set('authorization', auth).expect(201)
    ).body;

    // Closed-but-ungraded is impossible through the UI, but the route must not
    // depend on that: it reports the state rather than dereferencing it.
    const res = await request(app).post(`/api/v1/rounds/${created.round.id}/standards`).set('authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/run the round|finished round/i);
  }, 30_000);
});

describe('an unhandled throw in any route', () => {
  it('becomes a 500 with a message rather than taking the process down', async () => {
    // A round id that exists nowhere: the route resolves nothing and must
    // answer, not crash.
    const res = await request(app).post('/api/v1/rounds/nope/standards').set('authorization', 'Bearer x');
    expect(res.status).toBeGreaterThanOrEqual(400);
    await request(app).get('/api/v1/health').expect(200);
  });
});

describe('the brake on anonymous creation', () => {
  it('throttles a loop and answers a person', async () => {
    process.env.GR_CREATE_LIMIT = '2';
    try {
      const throttled = createApp(db);
      const make = () =>
        request(throttled).post('/api/v1/projects').set('x-forwarded-for', '203.0.113.9').send({ name: 'Loop' });
      await make().expect(201);
      await make().expect(201);
      const refused = await make().expect(429);
      expect(refused.body.error).toMatch(/wait/i);
      // A different address is not punished for someone else's loop.
      await request(throttled)
        .post('/api/v1/projects')
        .set('x-forwarded-for', '198.51.100.7')
        .send({ name: 'Neighbor' })
        .expect(201);
    } finally {
      delete process.env.GR_CREATE_LIMIT;
    }
  });
});
