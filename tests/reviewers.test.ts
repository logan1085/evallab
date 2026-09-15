/**
 * Several reviewers, one round.
 *
 * What these pin: verdicts are kept apart by reviewer name; everything
 * downstream reads the consensus (the majority, the owner breaking ties);
 * the reviewers report measures agreement on shared cases and lists the
 * splits; and a lone owner sees exactly what they saw before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import * as store from '../server/store.js';

describe('self-check with reviewers and GET /rounds/:id/reviewers', () => {
  let app: Express;
  let db: DB;
  let slug: string;
  let auth: Record<string, string>;
  let roundId: string;
  let ten: { itemId: string; title: string }[];

  beforeEach(async () => {
    db = await testDb();
    app = createApp(db);
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Reviewers Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    slug = created.body.project.slug;
    auth = { 'x-gr-token': created.body.project.token };
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
    const run = await request(app)
      .post(`/api/v1/projects/${slug}/runs`)
      .set(auth)
      .send({
        cases: [
          { title: 'Refund under the cap', content: 'USER: refund my $30 order. ASSISTANT: Done, $30 refunded to your card.' },
          { title: 'Refund over the cap', content: 'USER: refund my $90 order. ASSISTANT: I have refunded $90.' },
          { title: 'Plain answer', content: 'USER: where is my order? ASSISTANT: It shipped yesterday.' },
          { title: 'Nine tenths done, gap named', content: 'The AI completes most of the request but cannot finish one part. It stops, names precisely what remains undone and why, and hands it back.' },
        ],
      })
      .expect(201);
    roundId = run.body.run.roundId;
    for (const s of run.body.seats) await request(app).post(`/api/v1/rounds/${roundId}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    ten = (await request(app).get(`/api/v1/rounds/${roundId}/self-check`).set(auth).expect(200)).body.cases;
    expect(ten.length).toBeGreaterThanOrEqual(3);
  });

  const grade = (itemId: string, verdict: string, reviewer?: string, reason = '') =>
    request(app).post(`/api/v1/rounds/${roundId}/self-check`).set(auth).send({ itemId, verdict, reason, ...(reviewer ? { reviewer } : {}) }).expect(200);

  it('keeps each reviewer’s ten apart and reports agreement and the splits', async () => {
    const [a, b, c] = ten;
    await grade(a!.itemId, 'pass', 'Ana', 'Ana on a');
    await grade(b!.itemId, 'fail', 'Ana');
    await grade(c!.itemId, 'pass', 'Ana');
    await grade(a!.itemId, 'pass', 'Ben');
    await grade(b!.itemId, 'pass', 'Ben', 'Ben reads it as fine');
    await grade(a!.itemId, 'pass');

    const ana = (await request(app).get(`/api/v1/rounds/${roundId}/self-check?reviewer=Ana`).set(auth).expect(200)).body;
    expect(ana.reviewer).toBe('Ana');
    expect(ana.done).toBe(3);
    const owner = (await request(app).get(`/api/v1/rounds/${roundId}/self-check`).set(auth).expect(200)).body;
    expect(owner.reviewer).toBe('owner');
    expect(owner.done).toBe(1);

    const rep = (await request(app).get(`/api/v1/rounds/${roundId}/reviewers`).set(auth).expect(200)).body;
    expect(rep.reviewers.map((r: { name: string; graded: number }) => [r.name, r.graded]).sort()).toEqual([['Ana', 3], ['Ben', 2], ['owner', 1]]);
    expect(rep.shared_cases).toBe(2);
    expect(rep.alpha).not.toBeNull();
    const pair = rep.pairwise.find((p: { a: string; b: string }) => p.a === 'Ana' && p.b === 'Ben');
    expect(pair).toMatchObject({ items: 2, agree: 1 });
    expect(rep.disagreements).toHaveLength(1);
    expect(rep.disagreements[0].itemId).toBe(b!.itemId);
    expect(rep.disagreements[0].verdicts.map((v: { reviewer: string }) => v.reviewer).sort()).toEqual(['Ana', 'Ben']);
    // A tie with no owner: the first grader's word stands as consensus for now.
    expect(rep.disagreements[0].consensus).toBe('fail');

    // Alignment and the training export read the consensus: three cases graded, not six rows.
    const alignment = (await request(app).get(`/api/v1/rounds/${roundId}/alignment`).set(auth).expect(200)).body;
    expect(alignment.graded).toBe(3);
    const training = (await request(app).get(`/api/v1/projects/${slug}/training`).set(auth).expect(200)).body;
    expect(training.counts.gold).toBe(3);
  });

  it('reads the consensus as the majority, with the owner breaking ties and lending the reason', async () => {
    const item = ten[0]!.itemId;
    await store.saveUserVerdict(db, { roundId, itemId: item, verdict: 'pass', reason: 'Ana: fine', reviewer: 'Ana' });
    await store.saveUserVerdict(db, { roundId, itemId: item, verdict: 'fail', reason: 'Ben: not fine', reviewer: 'Ben' });
    let [c] = await store.listUserVerdicts(db, roundId);
    // A tie with no owner goes to whoever graded first.
    expect(c!.verdict).toBe('pass');
    expect(c!.unanimous).toBe(false);
    expect(c!.reviewers).toBe(2);

    await store.saveUserVerdict(db, { roundId, itemId: item, verdict: 'fail', reason: 'Owner: over the cap' });
    [c] = await store.listUserVerdicts(db, roundId);
    expect(c!.verdict).toBe('fail');
    expect(c!.reason).toBe('Owner: over the cap');
    expect([...c!.by].sort()).toEqual(['Ben', 'owner']);

    // Re-grading replaces, per reviewer.
    await store.saveUserVerdict(db, { roundId, itemId: item, verdict: 'fail', reason: 'Ana, on reflection', reviewer: 'Ana' });
    [c] = await store.listUserVerdicts(db, roundId);
    expect(c!.unanimous).toBe(true);
    expect((await store.listReviewerVerdicts(db, roundId)).length).toBe(3);
  });

  it('treats a blank or "owner" reviewer as the owner, and caps the name', async () => {
    const [a] = ten;
    await grade(a!.itemId, 'fail', '  Owner ');
    await grade(a!.itemId, 'pass', '');
    const rep = (await request(app).get(`/api/v1/rounds/${roundId}/reviewers`).set(auth).expect(200)).body;
    expect(rep.reviewers).toEqual([{ name: 'owner', graded: 1, agreed_with_consensus: 1, last_at: expect.any(String) }]);
    const long = await grade(a!.itemId, 'pass', 'x'.repeat(40));
    expect(long.body.reviewer).toBe('x'.repeat(40));
  });
});
