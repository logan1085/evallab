/**
 * Credential boundaries use only a local in-memory database and read/key
 * routes. No panel, scenario, judge, health or other model endpoint is called.
 * Any accidental fetch fails locally, so this file cannot spend model credits.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb, type DB } from '../server/db.js';

let db: DB;
let app: Express;
let project: { slug: string; token: string };
let rubricId: string;
let minted: { id: string; key: string };
const denyFetch = vi.fn(() => Promise.reject(new Error('External fetch is forbidden in credential tests.')));

beforeAll(async () => {
  db = await openDb(':memory:');
});

beforeEach(async () => {
  vi.stubGlobal('fetch', denyFetch);
  denyFetch.mockClear();
  app = createApp(db);
  const created = await request(app).post('/api/v1/projects').send({ name: 'Credential boundary' }).expect(201);
  project = created.body.project;
  rubricId = created.body.rubric.id;
  minted = (await request(app)
    .post(`/api/v1/projects/${project.slug}/keys`)
    .set('authorization', `Bearer ${project.token}`)
    .send({ name: 'revocable worker' })
    .expect(201)).body;
});

afterEach(() => {
  expect(denyFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

afterAll(async () => { await db.close(); });

describe('project credential boundary', () => {
  it('returns the original credential on creation, but never on project reads', async () => {
    expect(project.token).toBeTruthy();
    for (const prefix of ['/api', '/api/v1']) {
      for (const key of [project.token, minted.key]) {
        const read = await request(app)
          .get(`${prefix}/projects/${project.slug}`)
          .set('authorization', `Bearer ${key}`)
          .expect(200);
        expect(read.body.project).not.toHaveProperty('token');
        expect(JSON.stringify(read.body)).not.toContain(project.token);
        expect(read.body.project.slug).toBe(project.slug);
      }
    }
  });

  it('does not let a revocable key mint, list, or revoke credentials', async () => {
    const path = `/api/v1/projects/${project.slug}/keys`;
    const auth = { authorization: `Bearer ${minted.key}` };
    await request(app).post(path).set(auth).send({ name: 'persistent copy' }).expect(403);
    await request(app).get(path).set(auth).expect(403);
    await request(app).delete(`${path}/${minted.id}`).set(auth).expect(403);
    const listed = await request(app).get(path).set('authorization', `Bearer ${project.token}`).expect(200);
    expect(listed.body.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(minted.key);
  });

  it('keeps owner key management working and rejects a revoked key on reads and exports', async () => {
    await request(app)
      .delete(`/api/v1/projects/${project.slug}/keys/${minted.id}`)
      .set('x-gr-token', project.token)
      .expect(204);
    await request(app).get(`/api/v1/projects/${project.slug}`).set('authorization', `Bearer ${minted.key}`).expect(403);
    await request(app).get(`/api/v1/rubrics/${rubricId}/export`).set('authorization', `Bearer ${minted.key}`).expect(403);
    await request(app).get(`/api/v1/projects/${project.slug}`).set('x-gr-token', project.token).expect(200);
  });

  it('accepts the shared Bearer, header and link authentication on rubric exports', async () => {
    for (const key of [project.token, minted.key]) {
      const path = `/api/v1/rubrics/${rubricId}/export?format=json`;
      const bearer = await request(app).get(path).set('authorization', `Bearer ${key}`).expect(200);
      expect(bearer.body.id).toBe(rubricId);
      await request(app).get(path).set('x-gr-token', key).expect(200);
      await request(app).get(`${path}&k=${encodeURIComponent(key)}`).expect(200);
    }
  });

  it('rejects missing, wrong and cross-project credentials on rubric exports', async () => {
    const path = `/api/v1/rubrics/${rubricId}/export`;
    await request(app).get(path).expect(401);
    await request(app).get(path).set('authorization', 'Bearer wrong').expect(403);
    const other = await request(app).post('/api/v1/projects').send({ name: 'Other project' }).expect(201);
    await request(app).get(path).set('authorization', `Bearer ${other.body.project.token}`).expect(403);
  });
});
