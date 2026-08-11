import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb, type DB } from '../server/db.js';
import { seedDemoProject } from '../server/seed.js';
import * as store from '../server/store.js';

let db: DB;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

/** A project with n traces, a rubric, and no rounds yet. */
async function makeProject(traceCount = 6) {
  const created = await request(app).post('/api/projects').send({ name: 'Test project' }).expect(201);
  const { project } = created.body;
  const auth = (r: request.Test) => r.set('x-gr-token', project.token);

  if (traceCount > 0) {
    await auth(
      request(app)
        .post(`/api/projects/${project.slug}/traces`)
        .send({
          traces: Array.from({ length: traceCount }, (_, i) => ({
            title: `Trace ${i + 1}`,
            content: `transcript body ${i + 1}`,
          })),
        }),
    ).expect(201);
  }

  return { project, auth };
}

async function joinGrader(project: { slug: string; token: string }, name: string) {
  const res = await request(app)
    .post(`/api/projects/${project.slug}/graders`)
    .set('x-gr-token', project.token)
    .send({ name })
    .expect(201);
  return res.body.grader as { id: string; name: string };
}

describe('shared-link auth', () => {
  it('rejects a request with no key', async () => {
    const { project } = await makeProject(1);
    await request(app).get(`/api/projects/${project.slug}`).expect(403);
  });

  it('rejects a request with the wrong key', async () => {
    const { project } = await makeProject(1);
    await request(app).get(`/api/projects/${project.slug}`).set('x-gr-token', 'nope').expect(403);
  });

  it('accepts the key as a query parameter, which is how the shared link carries it', async () => {
    const { project } = await makeProject(1);
    await request(app).get(`/api/projects/${project.slug}?k=${project.token}`).expect(200);
  });

  it('404s an unknown project without leaking whether the key was right', async () => {
    await request(app).get('/api/projects/does-not-exist?k=whatever').expect(404);
  });
});

describe('blind grading', () => {
  it('never returns another grader\'s verdict from the queue while the round is open', async () => {
    const { project, auth } = await makeProject(4);
    const ana = await joinGrader(project, 'Ana');
    const ben = await joinGrader(project, 'Ben');

    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 4 }).expect(201)
    ).body.round;

    const items = (
      await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`)).expect(200)
    ).body.items;

    // Ana grades everything with a distinctive verdict.
    for (const item of items) {
      await auth(request(app).post(`/api/rounds/${round.id}/grades`))
        .send({ graderId: ana.id, itemId: item.itemId, verdict: 'pass', note: 'ANA_SECRET_NOTE' })
        .expect(200);
    }

    const benQueue = await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ben.id}`)).expect(200);

    const serialized = JSON.stringify(benQueue.body);
    expect(serialized).not.toContain('ANA_SECRET_NOTE');
    expect(serialized).not.toContain(ana.id);
    for (const item of benQueue.body.items) {
      expect(item.myVerdict).toBeNull();
    }
  });

  it('refuses to serve the report while the round is open', async () => {
    const { project, auth } = await makeProject(4);
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 4 }).expect(201)
    ).body.round;

    const res = await auth(request(app).get(`/api/rounds/${round.id}/report`)).expect(409);
    expect(res.body.error).toMatch(/still open/i);
  });

  it('refuses new grades once the round is closed, so nobody can peek then grade', async () => {
    const { project, auth } = await makeProject(3);
    const ana = await joinGrader(project, 'Ana');
    const ben = await joinGrader(project, 'Ben');
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 3 }).expect(201)
    ).body.round;
    const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;

    for (const grader of [ana, ben]) {
      for (const item of items) {
        await auth(request(app).post(`/api/rounds/${round.id}/grades`))
          .send({ graderId: grader.id, itemId: item.itemId, verdict: 'pass' })
          .expect(200);
      }
    }

    await auth(request(app).post(`/api/rounds/${round.id}/close`)).expect(200);
    await auth(request(app).get(`/api/rounds/${round.id}/report`)).expect(200);

    const late = await auth(request(app).post(`/api/rounds/${round.id}/grades`))
      .send({ graderId: ben.id, itemId: items[0].itemId, verdict: 'fail' })
      .expect(409);
    expect(late.body.error).toMatch(/closed/i);
  });

  it('does not tell a grader which arm an item belongs to', async () => {
    const { project, auth } = await makeProject(6);
    const ana = await joinGrader(project, 'Ana');
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
        .send({ calibrationSize: 3, heldoutSize: 3 })
        .expect(201)
    ).body.round;

    const queue = await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`)).expect(200);
    for (const item of queue.body.items) {
      expect(item).not.toHaveProperty('arm');
    }
    expect(JSON.stringify(queue.body)).not.toContain('heldout');
  });

  it('reports per-grader progress counts but no verdicts while open', async () => {
    const { project, auth } = await makeProject(2);
    const ana = await joinGrader(project, 'Ana');
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 2 }).expect(201)
    ).body.round;
    const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;

    await auth(request(app).post(`/api/rounds/${round.id}/grades`))
      .send({ graderId: ana.id, itemId: items[0].itemId, verdict: 'fail' })
      .expect(200);

    const detail = await auth(request(app).get(`/api/rounds/${round.id}`)).expect(200);
    expect(detail.body.progress).toEqual([expect.objectContaining({ name: 'Ana', done: 1 })]);
    expect(JSON.stringify(detail.body.progress)).not.toContain('fail');
  });

  it('will not close a round with only one grader', async () => {
    const { project, auth } = await makeProject(2);
    const ana = await joinGrader(project, 'Ana');
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 2 }).expect(201)
    ).body.round;
    const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;
    await auth(request(app).post(`/api/rounds/${round.id}/grades`))
      .send({ graderId: ana.id, itemId: items[0].itemId, verdict: 'pass' })
      .expect(200);

    const res = await auth(request(app).post(`/api/rounds/${round.id}/close`)).expect(400);
    expect(res.body.error).toMatch(/two graders/i);
  });
});

describe('rounds and sampling', () => {
  it('refuses a round larger than the trace pool', async () => {
    const { project, auth } = await makeProject(3);
    const res = await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 3, heldoutSize: 2 })
      .expect(400);
    expect(res.body.error).toMatch(/3 traces/);
  });

  it('carries the sampler explanation through to the round', async () => {
    const { project, auth } = await makeProject(6);
    const res = await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 4, heldoutSize: 2 })
      .expect(201);
    expect(res.body.samplingNote).toMatch(/uniformly at random/);
    expect(res.body.samplingNote).toMatch(/held-out/);
  });

  it('reports the attention budget for the sample size', async () => {
    const { project, auth } = await makeProject(40);
    const res = await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 40 })
      .expect(201);
    expect(res.body.attention.overBudget).toBe(true);
  });

  it('refuses to draw from an open source round', async () => {
    const { project, auth } = await makeProject(8);
    const first = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 4 }).expect(201)
    ).body.round;

    const res = await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 4, strategy: 'from_splits', sourceRoundId: first.id })
      .expect(400);
    expect(res.body.error).toMatch(/still open/i);
  });
});

describe('the demo project', () => {
  it('opens on a closed round with real splits in it', async () => {
    const seeded = seedDemoProject(db);
    const report = await request(app)
      .get(`/api/rounds/${seeded.roundId}/report?k=${store.getProjectById(db, seeded.projectId)!.token}`)
      .expect(200);

    expect(report.body.splitCount).toBeGreaterThan(0);
    expect(report.body.graders).toHaveLength(3);
    expect(report.body.overall.agreement.observed).toBeGreaterThan(0);
    expect(report.body.overall.agreement.observed).toBeLessThan(1);
  });

  it('orders the report so the widest disagreements come first', async () => {
    const seeded = seedDemoProject(db);
    const token = store.getProjectById(db, seeded.projectId)!.token;
    const report = await request(app).get(`/api/rounds/${seeded.roundId}/report?k=${token}`).expect(200);

    const spreads = report.body.rows.map((r: { spread: number }) => r.spread);
    expect(spreads).toEqual([...spreads].sort((a: number, b: number) => b - a));
  });

  it('flags the seeded traces as authored rather than captured', async () => {
    const seeded = seedDemoProject(db);
    const token = store.getProjectById(db, seeded.projectId)!.token;
    const traces = await request(app).get(`/api/projects/${seeded.slug}/traces?k=${token}`).expect(200);
    expect(traces.body.traces.every((t: { source: string }) => t.source === 'authored-demo')).toBe(true);
  });
});

describe('resolutions and shipping', () => {
  async function closedRound(traceCount = 4) {
    const { project, auth } = await makeProject(traceCount);
    const ana = await joinGrader(project, 'Ana');
    const ben = await joinGrader(project, 'Ben');
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
        .send({ calibrationSize: traceCount })
        .expect(201)
    ).body.round;
    const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;

    // Disagree on the first item, agree on the rest.
    for (const [i, item] of items.entries()) {
      await auth(request(app).post(`/api/rounds/${round.id}/grades`))
        .send({ graderId: ana.id, itemId: item.itemId, verdict: 'pass' })
        .expect(200);
      await auth(request(app).post(`/api/rounds/${round.id}/grades`))
        .send({ graderId: ben.id, itemId: item.itemId, verdict: i === 0 ? 'fail' : 'pass' })
        .expect(200);
    }
    await auth(request(app).post(`/api/rounds/${round.id}/close`)).expect(200);
    return { project, auth, round, items };
  }

  it('turns resolutions into clauses on a new rubric version', async () => {
    const { project, auth, round, items } = await closedRound();

    await auth(request(app).post(`/api/rounds/${round.id}/items/${items[0].itemId}/resolve`))
      .send({
        agreedVerdict: 'fail',
        clauseText: 'A run that edits the assertion to make a test pass is a fail, regardless of the green result.',
        resolvedBy: 'Ana',
      })
      .expect(200);

    const shipped = await auth(request(app).post(`/api/rounds/${round.id}/ship`)).expect(201);
    expect(shipped.body.added).toBe(1);
    expect(shipped.body.rubric.version).toBe(2);
    expect(shipped.body.rubric.clauses[0].text).toMatch(/edits the assertion/);
    expect(shipped.body.rubric.clauses[0].originRoundId).toBe(round.id);

    const md = await auth(request(app).get(`/api/rubrics/${shipped.body.rubric.id}/export?format=md`)).expect(200);
    expect(md.text).toMatch(/Clauses from resolved disagreements/);
    expect(md.text).toMatch(/edits the assertion/);
  });

  it('refuses to ship a revision with no resolutions', async () => {
    const { auth, round } = await closedRound();
    const res = await auth(request(app).post(`/api/rounds/${round.id}/ship`)).expect(400);
    expect(res.body.error).toMatch(/resolve at least one/i);
  });

  it('refuses to resolve while the round is still open', async () => {
    const { project, auth } = await makeProject(2);
    const ana = await joinGrader(project, 'Ana');
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 2 }).expect(201)
    ).body.round;
    const items = (await auth(request(app).get(`/api/rounds/${round.id}/queue?graderId=${ana.id}`))).body.items;

    await auth(request(app).post(`/api/rounds/${round.id}/items/${items[0].itemId}/resolve`))
      .send({ agreedVerdict: 'pass', clauseText: 'Something the rubric should say.' })
      .expect(409);
  });

  it('forks rather than mutates a rubric a round has already pinned', async () => {
    const { project, auth } = await makeProject(2);
    await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 2 }).expect(201);

    const res = await auth(request(app).put(`/api/projects/${project.slug}/rubric`))
      .send({ name: 'Revised name', preamble: 'New preamble' })
      .expect(200);

    expect(res.body.forked).toBe(true);
    expect(res.body.rubric.version).toBe(2);
  });

  it('edits in place while the rubric is still unpinned', async () => {
    const { project, auth } = await makeProject(2);
    const res = await auth(request(app).put(`/api/projects/${project.slug}/rubric`))
      .send({ name: 'First draft', preamble: 'Still editable' })
      .expect(200);
    expect(res.body.forked).toBe(false);
    expect(res.body.rubric.version).toBe(1);
  });
});

describe('trace import', () => {
  it('accepts JSONL with platform-ish field names', async () => {
    const { project, auth } = await makeProject(0);
    const body = [
      JSON.stringify({ name: 'Refund case', output: 'ASSISTANT: I cannot do that.', score: 0.4 }),
      JSON.stringify({ id: 'run-2', completion: 'ASSISTANT: Done.' }),
    ].join('\n');

    const res = await auth(request(app).post(`/api/projects/${project.slug}/traces/import`))
      .send({ format: 'jsonl', body })
      .expect(201);

    expect(res.body.traces).toHaveLength(2);
    expect(res.body.traces[0].title).toBe('Refund case');
    expect(res.body.traces[0].meta.score).toBe(0.4);
  });

  it('rejects an import where nothing parsed, rather than creating empty traces', async () => {
    const { project, auth } = await makeProject(0);
    const res = await auth(request(app).post(`/api/projects/${project.slug}/traces/import`))
      .send({ format: 'jsonl', body: 'not json at all\nnor this' })
      .expect(422);
    expect(res.body.skipped).toBe(2);
  });
});

describe('judge', () => {
  it('scores the judge against humans as one more rater on the same items', async () => {
    const seeded = seedDemoProject(db);
    const project = store.getProjectById(db, seeded.projectId)!;
    const rubric = store.currentRubric(db, seeded.projectId)!;

    const run = await request(app)
      .post(`/api/rounds/${seeded.roundId}/judge?k=${project.token}`)
      .send({ rubricVersionId: rubric.id, arm: 'heldout' })
      .expect(201);

    // Without an API key this is the offline stub, and the response says so.
    expect(run.body.real).toBe(process.env.ANTHROPIC_API_KEY ? true : false);

    const runs = await request(app).get(`/api/rounds/${seeded.roundId}/judge?k=${project.token}`).expect(200);
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0].itemCount).toBeGreaterThan(0);
    expect(runs.body.runs[0].comparisons).toBeGreaterThan(0);
  });

  it('will not judge an open round', async () => {
    const { project, auth } = await makeProject(2);
    const rubric = store.currentRubric(db, store.getProjectBySlug(db, project.slug)!.id)!;
    const round = (
      await auth(request(app).post(`/api/projects/${project.slug}/rounds`)).send({ calibrationSize: 2 }).expect(201)
    ).body.round;

    await auth(request(app).post(`/api/rounds/${round.id}/judge`))
      .send({ rubricVersionId: rubric.id })
      .expect(409);
  });
});

describe('drafting a rubric from conversations', () => {
  const description = 'A support agent that answers billing questions and can issue refunds.';

  it('drafts from traces already in the project without saving anything', async () => {
    const { project, auth } = await makeProject(3);
    const traces = (await auth(request(app).get(`/api/projects/${project.slug}/traces`))).body.traces as {
      id: string;
    }[];

    const res = await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
      .send({ description, traceIds: traces.map((t) => t.id) })
      .expect(200);

    expect(res.body.draft.scale.length).toBeGreaterThanOrEqual(2);
    expect(res.body.draft.openQuestions.length).toBeGreaterThan(0);
    expect(res.body.draftedFrom.exampleCount).toBe(3);
    expect(res.body.usedTraceIds).toHaveLength(3);

    // Nothing is written until a human accepts it.
    const rubric = (await auth(request(app).get(`/api/projects/${project.slug}`))).body.rubric;
    expect(rubric.openQuestions).toEqual([]);
    expect(rubric.draftedFrom).toBeNull();
  });

  it('accepts pasted conversations from a project with no traces at all', async () => {
    const { project, auth } = await makeProject(0);
    const res = await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
      .send({ description, examples: [{ title: 'First call', content: 'user: where is my refund' }] })
      .expect(200);
    expect(res.body.draftedFrom.exampleCount).toBe(1);
  });

  it('says so rather than inventing criteria when no model is configured', async () => {
    const { project, auth } = await makeProject(2);
    const traces = (await auth(request(app).get(`/api/projects/${project.slug}/traces`))).body.traces as {
      id: string;
    }[];
    const res = await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
      .send({ description, traceIds: [traces[0]!.id] })
      .expect(200);

    expect(res.body.provider.real).toBe(false);
    expect(res.body.draft.criteria).toEqual([]);
    expect(res.body.draft.openQuestions.length).toBeGreaterThan(0);
  });

  it('refuses to draft from another project\'s traces', async () => {
    const mine = await makeProject(1);
    const theirs = await makeProject(1);
    const theirTrace = (await theirs.auth(request(app).get(`/api/projects/${theirs.project.slug}/traces`))).body
      .traces[0];

    const res = await mine
      .auth(request(app).post(`/api/projects/${mine.project.slug}/rubric/draft`))
      .send({ description, traceIds: [theirTrace.id] })
      .expect(404);
    expect(res.body.error).toMatch(/not in this project/i);
  });

  it('refuses with nothing to draft from, and with no description', async () => {
    const { project, auth } = await makeProject(1);
    await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`)).send({ description }).expect(400);
    await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
      .send({ description: 'short', examples: [{ title: 'x', content: 'y' }] })
      .expect(400);
  });

  it('stores the draft and its provenance once a human accepts it', async () => {
    const { project, auth } = await makeProject(2);
    const traces = (await auth(request(app).get(`/api/projects/${project.slug}/traces`))).body.traces as {
      id: string;
    }[];
    const drafted = (
      await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
        .send({ description, traceIds: [traces[0]!.id] })
        .expect(200)
    ).body;

    const saved = (
      await auth(request(app).put(`/api/projects/${project.slug}/rubric`))
        .send({
          name: drafted.draft.name,
          preamble: drafted.draft.preamble,
          scale: drafted.draft.scale,
          criteria: drafted.draft.criteria,
          openQuestions: drafted.draft.openQuestions,
          draftedFrom: drafted.draftedFrom,
        })
        .expect(200)
    ).body.rubric;

    expect(saved.openQuestions).toEqual(drafted.draft.openQuestions);
    expect(saved.draftedFrom.describedAs).toBe(description);
    expect(saved.draftedFrom.exampleCount).toBe(1);

    const markdown = (
      await auth(request(app).get(`/api/rubrics/${saved.id}/export?format=md`)).expect(200)
    ).text;
    expect(markdown).toContain('does not answer yet');
    expect(markdown).toContain(saved.openQuestions[0].question);

    const judge = (await auth(request(app).get(`/api/rubrics/${saved.id}/export?format=judge`)).expect(200)).text;
    expect(judge).not.toContain(saved.openQuestions[0].question);
  });

  it('carries open questions forward when an edit forks a pinned version', async () => {
    const { project, auth } = await makeProject(4);
    const drafted = (
      await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
        .send({ description, examples: [{ title: 'x', content: 'a conversation' }] })
        .expect(200)
    ).body;

    await auth(request(app).put(`/api/projects/${project.slug}/rubric`))
      .send({ name: 'v1', openQuestions: drafted.draft.openQuestions, draftedFrom: drafted.draftedFrom })
      .expect(200);

    await auth(request(app).post(`/api/projects/${project.slug}/graders`)).send({ name: 'Ana' }).expect(201);
    await auth(request(app).post(`/api/projects/${project.slug}/rounds`))
      .send({ calibrationSize: 2, heldoutSize: 1 })
      .expect(201);

    const forked = (
      await auth(request(app).put(`/api/projects/${project.slug}/rubric`)).send({ name: 'v2' }).expect(200)
    ).body;
    expect(forked.forked).toBe(true);
    expect(forked.rubric.openQuestions).toEqual(drafted.draft.openQuestions);
    expect(forked.rubric.draftedFrom.describedAs).toBe(description);
  });

  it('lets a team strike a question the rubric now answers', async () => {
    const { project, auth } = await makeProject(1);
    const drafted = (
      await auth(request(app).post(`/api/projects/${project.slug}/rubric/draft`))
        .send({ description, examples: [{ title: 'x', content: 'a conversation' }] })
        .expect(200)
    ).body;

    await auth(request(app).put(`/api/projects/${project.slug}/rubric`))
      .send({ name: 'v1', openQuestions: drafted.draft.openQuestions })
      .expect(200);

    const kept = drafted.draft.openQuestions.slice(1);
    const res = await auth(request(app).put(`/api/projects/${project.slug}/rubric`))
      .send({ name: 'v1', openQuestions: kept })
      .expect(200);
    expect(res.body.rubric.openQuestions).toEqual(kept);
  });
});
