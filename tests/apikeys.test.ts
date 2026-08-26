/**
 * The agent surface: /api/v1 as an alias of the same router, Bearer keys
 * minted per project, 401 for a missing credential versus 403 for a wrong
 * one, and docs that need no key to read.
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

const DESCRIPTION =
  'A support agent that answers billing questions and can refund up to $50 without approval.';

/** Create, seat, write: the three steps setup runs, as the product runs them. */
async function makeProject(name = 'Keyed') {
  const { project } = (
    await request(app).post('/api/v1/projects').send({ name, description: DESCRIPTION }).expect(201)
  ).body;
  const auth = `Bearer ${project.token}`;
  await request(app).post(`/api/v1/projects/${project.slug}/panel`).set('authorization', auth).expect(201);
  await request(app)
    .post(`/api/v1/projects/${project.slug}/scenarios`)
    .set('authorization', auth)
    .send({ description: DESCRIPTION })
    .expect(201);
  return project as { slug: string; token: string };
}

describe('the /api/v1 surface', () => {
  it('is the same router as /api, both ways', async () => {
    const project = await makeProject();
    const viaV1 = (
      await request(app).get(`/api/v1/projects/${project.slug}`).set('authorization', `Bearer ${project.token}`).expect(200)
    ).body;
    const viaApi = (
      await request(app).get(`/api/projects/${project.slug}`).set('x-gr-token', project.token).expect(200)
    ).body;
    expect(viaV1.project.slug).toBe(viaApi.project.slug);
    expect(viaV1.traceCount).toBe(viaApi.traceCount);
  });

  it('refuses an unauthenticated write with 401 and names the fix', async () => {
    const project = await makeProject();
    const res = await request(app)
      .post(`/api/v1/projects/${project.slug}/scenarios`)
      .send({ description: 'more scenarios about refunds' })
      .expect(401);
    expect(res.body.error).toMatch(/Bearer/);
  });

  it('refuses a wrong key with 403', async () => {
    const project = await makeProject();
    await request(app)
      .get(`/api/v1/projects/${project.slug}`)
      .set('authorization', 'Bearer gr_0000000000000000000000000000000000000000000000')
      .expect(403);
  });

  it('serves the docs with no key, with curl examples for the v1 surface', async () => {
    for (const path of ['/api/docs', '/api/v1/docs']) {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain('curl');
      expect(res.text).toContain('/api/v1');
      expect(res.text).toContain('Authorization: Bearer');
      expect(res.text).toContain('/keys');
    }
  });
});

describe('minted keys', () => {
  it('mints once, works everywhere, and dies when revoked', async () => {
    const project = await makeProject();
    const auth = `Bearer ${project.token}`;

    // Minting needs a credential: a leaked slug alone mints nothing.
    await request(app).post(`/api/v1/projects/${project.slug}/keys`).send({ name: 'agent' }).expect(401);

    const minted = (
      await request(app)
        .post(`/api/v1/projects/${project.slug}/keys`)
        .set('authorization', auth)
        .send({ name: 'ci-agent' })
        .expect(201)
    ).body;
    expect(minted.key).toMatch(/^gr_[0-9a-f]{48}$/);
    expect(minted.prefix).toBe(minted.key.slice(0, 11));

    // The key both reads and writes.
    await request(app).get(`/api/v1/projects/${project.slug}`).set('authorization', `Bearer ${minted.key}`).expect(200);
    await request(app)
      .post(`/api/v1/projects/${project.slug}/traces`)
      .set('authorization', `Bearer ${minted.key}`)
      .send({ traces: [{ title: 'Pasted case', content: 'USER: hello ASSISTANT: hello' }] })
      .expect(201);

    // The list shows the prefix, never the key.
    const listed = (
      await request(app).get(`/api/v1/projects/${project.slug}/keys`).set('authorization', auth).expect(200)
    ).body;
    expect(JSON.stringify(listed)).not.toContain(minted.key);
    expect(listed.keys.some((k: { prefix: string }) => k.prefix === minted.prefix)).toBe(true);

    // Revoked reads as wrong, not as missing.
    await request(app).delete(`/api/v1/projects/${project.slug}/keys/${minted.id}`).set('authorization', auth).expect(204);
    await request(app).get(`/api/v1/projects/${project.slug}`).set('authorization', `Bearer ${minted.key}`).expect(403);
  });

  it('does not open another project', async () => {
    const a = await makeProject('Project A');
    const b = await makeProject('Project B');
    const minted = (
      await request(app)
        .post(`/api/v1/projects/${a.slug}/keys`)
        .set('authorization', `Bearer ${a.token}`)
        .send({ name: 'a-only' })
        .expect(201)
    ).body;
    await request(app).get(`/api/v1/projects/${b.slug}`).set('authorization', `Bearer ${minted.key}`).expect(403);
  });

  it('opens round routes too', async () => {
    const project = await makeProject();
    const minted = (
      await request(app)
        .post(`/api/v1/projects/${project.slug}/keys`)
        .set('authorization', `Bearer ${project.token}`)
        .send({ name: 'rounds' })
        .expect(201)
    ).body;
    const created = (
      await request(app)
        .post(`/api/v1/projects/${project.slug}/panel-rounds`)
        .set('authorization', `Bearer ${minted.key}`)
        .expect(201)
    ).body;
    await request(app).get(`/api/v1/rounds/${created.round.id}`).set('authorization', `Bearer ${minted.key}`).expect(200);
    await request(app).get(`/api/v1/rounds/${created.round.id}`).expect(401);
  });
});

/**
 * The launch loop: setup writes a framework from the owner's own words, a
 * round's splits write the next version, and the Standards page is the thing
 * they leave with.
 */
describe('the framework', () => {
  it('starts as the owner\'s own hard limits, verbatim, not an empty preamble', async () => {
    const created = (
      await request(app).post('/api/v1/projects').send({
        name: 'Limits',
        description: 'A support agent that answers billing questions.',
        limits: 'Never refund over $50 without human approval. Never promise a delivery date.',
      }).expect(201)
    ).body;
    const bodies = created.rubric.criteria.map((c: { body: string }) => c.body);
    expect(bodies).toEqual([
      'Never refund over $50 without human approval.',
      'Never promise a delivery date.',
    ]);
  });

  it('refuses to turn "skip" into a rubric clause', async () => {
    const created = (
      await request(app).post('/api/v1/projects').send({
        name: 'Skipped',
        description: 'A support agent that answers billing questions.',
        limits: 'skip',
      }).expect(201)
    ).body;
    expect(created.rubric.criteria).toEqual([]);
  });

  it('writes the splits into one new version, and says so when there is nothing to write', async () => {
    const project = await makeProject('Handoff');
    const auth = `Bearer ${project.token}`;
    const created = (
      await request(app).post(`/api/v1/projects/${project.slug}/panel-rounds`).set('authorization', auth).expect(201)
    ).body;
    for (const seat of created.seats) {
      await request(app)
        .post(`/api/v1/rounds/${created.round.id}/panel-run`)
        .set('authorization', auth)
        .send({ seatId: seat.id })
        .expect(200);
    }

    const written = (
      await request(app).post(`/api/v1/rounds/${created.round.id}/standards`).set('authorization', auth).expect(201)
    ).body;
    expect(written.sentences).toBeGreaterThan(0);
    expect(written.url).toBe(`/s/${project.slug}`);
    expect(written.rubric.version).toBe(2);

    // Idempotent: the same round does not keep minting versions.
    const again = (
      await request(app).post(`/api/v1/rounds/${created.round.id}/standards`).set('authorization', auth).expect(200)
    ).body;
    expect(again.alreadyWritten).toBe(true);
    expect(again.rubric.version).toBe(2);
  }, 30_000);

  it('serves the Standards page publicly only once published', async () => {
    const project = await makeProject('Shareable');
    await request(app).get(`/s/${project.slug}`).expect(404);

    // The owner's key opens it even while private.
    const priv = await request(app).get(`/s/${project.slug}?k=${project.token}`).expect(200);
    expect(priv.text).toContain('This page is private');

    await request(app)
      .post(`/api/v1/projects/${project.slug}/visibility`)
      .set('authorization', `Bearer ${project.token}`)
      .send({ public: true })
      .expect(200);

    const pub = await request(app).get(`/s/${project.slug}`).expect(200);
    expect(pub.text).toContain('Standards v1');
    expect(pub.text).toContain('Seat your own panel');
    // A stranger never sees the owner's controls.
    expect(pub.text).not.toContain('Publish it');
    expect(pub.text).not.toContain(project.token);

    await request(app).get(`/s/${project.slug}/og.svg`).expect(200).expect('content-type', /svg/);
  });
});
