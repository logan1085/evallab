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

async function makeProject(name = 'Keyed') {
  const { project } = (
    await request(app).post('/api/v1/projects').send({
      name,
      description: 'A support agent that answers billing questions and can refund up to $50 without approval.',
    }).expect(201)
  ).body;
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
