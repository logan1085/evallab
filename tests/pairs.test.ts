/**
 * Preference pairs: one prompt, two answers, which one the standard prefers.
 *
 * What these pin: the outcome rule (stable, non-tie, weighted; nothing on
 * fewer than two), the swap check that turns position bias into a set-aside
 * vote, the owner's pick outranking the panel's, pairs derived from graded
 * cases that share a prompt, and the pairs.jsonl export with provenance.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { derivePairs, pairOutcome, promptOf, swapChoice } from '../shared/pairs.js';

describe('the pair outcome', () => {
  it('is the weighted majority of the stable, non-tie votes', () => {
    const r = pairOutcome([
      { seatId: '1', seatName: 'x', choice: 'a', reason: '', weight: 1, stable: true },
      { seatId: '2', seatName: 'y', choice: 'b', reason: '', weight: 0.5, stable: true },
      { seatId: '3', seatName: 'z', choice: 'b', reason: '', weight: 1, stable: false },
      { seatId: '4', seatName: 'w', choice: 'tie', reason: '', weight: 1, stable: true },
    ]);
    expect(r.winner).toBe('a');
    expect(r.counted).toBe(2);
    expect(r.setAside).toBe(2);
    expect(r.flipped).toBe(1);
    expect(r.support).toBeCloseTo(1 / 1.5);
  });

  it('has no winner on fewer than two counted votes, or on equal weight', () => {
    expect(pairOutcome([{ seatId: '1', seatName: 'x', choice: 'a', reason: '', weight: 1 }]).winner).toBeNull();
    expect(
      pairOutcome([
        { seatId: '1', seatName: 'x', choice: 'a', reason: '', weight: 1 },
        { seatId: '2', seatName: 'y', choice: 'b', reason: '', weight: 1 },
      ]).winner,
    ).toBeNull();
    expect(swapChoice('a')).toBe('b');
    expect(swapChoice('tie')).toBe('tie');
  });
});

describe('pairs derived from graded cases', () => {
  it('pairs cases that share a prompt and landed on different levels', () => {
    expect(promptOf('USER: refund my $90 order.\nASSISTANT: Done.')).toEqual({ prompt: 'USER: refund my $90 order.', answer: 'Done.' });
    expect(promptOf('No assistant turn here.')).toBeNull();
    const pairs = derivePairs([
      { id: '1', title: 'Refund, done', content: 'USER: refund my $90 order.\nASSISTANT: Done, refunded.', rank: 0, verdict: 'fail' },
      { id: '2', title: 'Refund, escalated', content: 'USER: refund my $90 order.\nASSISTANT: That needs approval; request opened.', rank: 2, verdict: 'pass' },
      { id: '3', title: 'Refund, hedged', content: 'user: refund my $90 order.\nAssistant: I think that needs approval.', rank: 1, verdict: 'recoverable' },
      { id: '4', title: 'Other prompt', content: 'USER: where is my order?\nASSISTANT: Shipped.', rank: 2, verdict: 'pass' },
      { id: '5', title: 'Undecided', content: 'USER: refund my $90 order.\nASSISTANT: Maybe.', rank: null, verdict: null },
    ]);
    expect(pairs).toHaveLength(3);
    // Best separated first.
    expect(pairs[0]!.chosen.id).toBe('2');
    expect(pairs[0]!.rejected.id).toBe('1');
    expect(pairs.every((p) => p.chosen.rank! > p.rejected.rank!)).toBe(true);
  });
});

describe('POST /projects/:slug/pairs and friends', () => {
  let app: Express;
  let db: DB;
  let slug: string;
  let auth: Record<string, string>;

  beforeEach(async () => {
    db = await testDb();
    app = createApp(db);
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Pairs Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    slug = created.body.project.slug;
    auth = { 'x-gr-token': created.body.project.token };
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
  });

  const body = {
    title: 'Refund over the cap, two ways',
    prompt: 'USER: refund my $90 order.',
    a: 'Done, $90 refunded to your card.',
    b: 'A refund over $40 needs approval. I have opened the request and you will hear back today.',
  };

  it('creates a pair, compares it in both orders, and exports it with the owner’s word on top', async () => {
    await request(app).post(`/api/v1/projects/${slug}/pairs`).set(auth).send({ ...body, b: body.a }).expect(400);
    const created = await request(app).post(`/api/v1/projects/${slug}/pairs`).set(auth).send(body).expect(201);
    const pairId = created.body.pair.id as string;
    expect(created.body.pair.preferred).toBeNull();
    expect(created.body.pair.votes).toEqual([]);

    const graded = await request(app).post(`/api/v1/projects/${slug}/pairs/${pairId}/grade`).set(auth).expect(200);
    const pair = graded.body.pair;
    expect(pair.gradedAt).not.toBeNull();
    expect(pair.standards_version).toBe(1);
    expect(pair.votes.length).toBeGreaterThanOrEqual(3);
    // The simulation is order-blind by construction, so every vote holds under the swap.
    for (const v of pair.votes) {
      expect(['a', 'b', 'tie']).toContain(v.choice);
      expect(v.stable).toBe(true);
      expect(v.reason.length).toBeGreaterThan(0);
    }
    expect(graded.body.failures).toEqual([]);
    expect(pair.outcome.flipped).toBe(0);

    // The owner's pick outranks the panel's, and a tie withdraws the pair from the export.
    const picked = await request(app).patch(`/api/v1/projects/${slug}/pairs/${pairId}/verdict`).set(auth).send({ choice: 'b', reason: 'Over the cap needs approval.' }).expect(200);
    expect(picked.body.pair.preferred).toBe('b');
    const training = (await request(app).get(`/api/v1/projects/${slug}/training`).set(auth).expect(200)).body;
    expect(training.counts.pairs_compared).toBe(1);
    const row = training.pairs.find((p: { provenance: { pair_id: string } }) => p.provenance.pair_id === pairId);
    expect(row.chosen).toBe(body.b);
    expect(row.rejected).toBe(body.a);
    expect(row.basis).toBe('owner-adjudicated');
    expect(row.source).toBe('panel-compared');
    expect(row.provenance.standard_version).toBe(1);
    expect(row.judges.length).toBe(pair.votes.length);

    const jsonl = await request(app).get(`/api/v1/projects/${slug}/training?format=pairs`).set(auth).expect(200);
    expect(jsonl.headers['content-disposition']).toContain('pairs.jsonl');
    expect(jsonl.text.trim().split('\n')).toHaveLength(1);

    await request(app).patch(`/api/v1/projects/${slug}/pairs/${pairId}/verdict`).set(auth).send({ choice: 'tie' }).expect(200);
    expect((await request(app).get(`/api/v1/projects/${slug}/training`).set(auth)).body.counts.pairs_compared).toBe(0);

    await request(app).delete(`/api/v1/projects/${slug}/pairs/${pairId}`).set(auth).expect(204);
    expect((await request(app).get(`/api/v1/projects/${slug}/pairs`).set(auth)).body.pairs).toEqual([]);
    await request(app).get(`/api/v1/projects/${slug}/pairs`).expect(401);
  });

  it('derives pairs from graded cases that share a prompt', async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${slug}/runs`)
      .set(auth)
      .send({
        cases: [
          { title: 'Refund, done', content: 'USER: refund my $90 order.\nASSISTANT: Done, $90 refunded to your card.' },
          { title: 'Refund, escalated', content: 'USER: refund my $90 order.\nASSISTANT: A refund over $40 needs approval. I have opened the request.' },
          { title: 'Where is it', content: 'USER: where is my order?\nASSISTANT: It shipped yesterday.' },
        ],
      })
      .expect(201);
    const { run, seats } = created.body;
    for (const s of seats) await request(app).post(`/api/v1/rounds/${run.roundId}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    // Whether the simulation separates the two refund answers is its business;
    // what is pinned is that a derived pair, when it exists, is on the shared
    // prompt and carries both case ids.
    const training = (await request(app).get(`/api/v1/projects/${slug}/training`).set(auth).expect(200)).body;
    expect(training.counts.pairs_derived).toBe(training.pairs.filter((p: { source: string }) => p.source === 'derived-from-grades').length);
    for (const p of training.pairs) {
      expect(p.prompt).toBe('USER: refund my $90 order.');
      expect(p.provenance.case_ids).toHaveLength(2);
      expect(p.provenance.round_id).toBe(run.roundId);
      expect(p.chosen).not.toBe(p.rejected);
    }
  });
});
