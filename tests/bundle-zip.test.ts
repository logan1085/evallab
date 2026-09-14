/**
 * The eval package as one file.
 *
 * What these pin: the zip is a real zip (a reader that knows nothing about
 * us can list and inflate it), it carries the same files as the JSON bundle
 * byte for byte, eval.json's hashes match the files beside it, and the
 * Standards page hands the owner the link only when a package can ship.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { DB } from '../server/db.js';
import { testDb } from './helpers.js';
import { buildZip, crc32 } from '../server/zip.js';

/** A minimal reader: walk the central directory, inflate each entry. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + compressed);
    const raw = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(crc32(raw)).toBe(crc);
    out.set(name, raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('the zip writer', () => {
  it('round-trips text and stores what deflate cannot shrink', () => {
    const at = new Date('2026-09-14T12:00:00Z');
    const zip = buildZip([{ name: 'a.txt', content: 'hello '.repeat(200) }, { name: 'b.bin', content: Buffer.from([1, 2, 3]) }], at);
    const files = readZip(zip);
    expect(files.get('a.txt')!.toString()).toBe('hello '.repeat(200));
    expect([...files.get('b.bin')!]).toEqual([1, 2, 3]);
    // Same content, same clock, same bytes: the package's own hash means something.
    expect(buildZip([{ name: 'a.txt', content: 'x' }], at).equals(buildZip([{ name: 'a.txt', content: 'x' }], at))).toBe(true);
  });
});

describe('GET /rounds/:id/bundle.zip and /projects/:slug/eval.zip', () => {
  let app: Express;
  let db: DB;
  let slug: string;
  let token: string;
  let auth: Record<string, string>;

  beforeEach(async () => {
    db = await testDb();
    app = createApp(db);
    const created = await request(app)
      .post('/api/v1/projects')
      .send({ name: 'Zip Co', description: 'A support agent for a bike shop that answers order questions.', limits: 'Refunds over $40 need approval.' })
      .expect(201);
    slug = created.body.project.slug;
    token = created.body.project.token;
    auth = { 'x-gr-token': token };
    await request(app).post(`/api/v1/projects/${slug}/panel`).set(auth).expect(201);
  });

  async function finishedRound(): Promise<string> {
    const created = await request(app)
      .post(`/api/v1/projects/${slug}/runs`)
      .set(auth)
      .send({
        cases: [
          { title: 'Refund under the cap', content: 'USER: refund my $30 order. ASSISTANT: Done, $30 refunded.' },
          { title: 'Refund over the cap', content: 'USER: refund my $90 order. ASSISTANT: I have refunded $90.' },
          { title: 'Plain answer', content: 'USER: where is my order? ASSISTANT: It shipped yesterday, arriving Thursday.' },
        ],
      })
      .expect(201);
    const { run, seats } = created.body;
    for (const s of seats) await request(app).post(`/api/v1/rounds/${run.roundId}/panel-run`).set(auth).send({ seatId: s.id }).expect(200);
    return run.roundId as string;
  }

  it('is a zip whose files match the JSON bundle and whose manifest hashes verify', async () => {
    const roundId = await finishedRound();
    const json = (await request(app).get(`/api/v1/rounds/${roundId}/bundle`).set(auth).expect(200)).body;
    const res = await request(app).get(`/api/v1/rounds/${roundId}/bundle.zip`).set(auth).responseType('blob').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`${slug}-eval-v1\\.zip`));
    const files = readZip(res.body as Buffer);
    expect([...files.keys()].sort()).toEqual(
      ['README.md', 'eval.json', 'golden-set.jsonl', 'judge-prompt.txt', 'panel.json', 'rerun.sh', 'round.json', 'rubric.md'].sort(),
    );
    const manifest = JSON.parse(files.get('eval.json')!.toString()) as { files: Record<string, string>; standards_version: number; pins: Record<string, string> };
    expect(manifest.standards_version).toBe(1);
    expect(Object.keys(manifest.pins).length).toBeGreaterThanOrEqual(3);
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(files.get(name)!).digest('hex')).toBe(hash);
    }
    expect(files.get('rubric.md')!.toString()).toBe(json.rubricMarkdown);
    expect(files.get('rerun.sh')!.toString()).toBe(json.rerunScript);
    expect(files.get('README.md')!.toString()).toContain('eval.json');
  });

  it('refuses an unfinished round, and the project package needs a finished round', async () => {
    await request(app).get(`/api/v1/projects/${slug}/eval.zip`).set(auth).expect(409);
    const created = await request(app)
      .post(`/api/v1/projects/${slug}/runs`)
      .set(auth)
      .send({ cases: [{ title: 'x', content: 'USER: hi. ASSISTANT: hello.' }] })
      .expect(201);
    await request(app).get(`/api/v1/rounds/${created.body.run.roundId}/bundle.zip`).set(auth).expect(409);
    await request(app).get(`/api/v1/rounds/${created.body.run.roundId}/bundle.zip`).expect(401);
  });

  it('ships the current standard from the Standards page, owner only', async () => {
    let page = (await request(app).get(`/s/${slug}?k=${token}`).expect(200)).text;
    expect(page).not.toContain('Download the eval package');
    await finishedRound();
    page = (await request(app).get(`/s/${slug}?k=${token}`).expect(200)).text;
    expect(page).toContain(`/api/v1/projects/${slug}/eval.zip?k=`);
    const res = await request(app).get(`/api/v1/projects/${slug}/eval.zip?k=${token}`).responseType('blob').expect(200);
    const files = readZip(res.body as Buffer);
    expect(files.has('eval.json')).toBe(true);
    // A public page never carries the key, so it never carries the link.
    await request(app).post(`/s/${slug}/visibility`).type('form').send({ k: token, public: '1' }).expect(302);
    expect((await request(app).get(`/s/${slug}`).expect(200)).text).not.toContain('eval.zip');
  });
});
