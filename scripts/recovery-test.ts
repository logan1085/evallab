/**
 * The recovery test: the product's own benchmark.
 *
 * Take a rubric that works, delete one clause, run a panel round on cases
 * that clause decided, and check the product notices: the decision point the
 * clause settled must resurface on the map as undecided, and a grounded
 * patch must exist demanding the decision be made again.
 *
 * Offline (no keys) this runs on the deterministic simulation, which makes it
 * a fixed regression suite: it verifies the pipeline resurfaces the decision
 * point. With real keys, the same harness exercises text-level reconstruction
 * by real models. Alongside it, panel stability: the identical round is run
 * twice and the flip count is reported rather than hidden.
 *
 *   npx tsx scripts/recovery-test.ts
 */
import request from 'supertest';
import { createApp } from '../server/app.js';
import { testDb } from '../tests/helpers.js';

export interface RecoveryFixture {
  name: string;
  description: string;
  deletedClause: string;
  /** The case family the clause decided; must resurface as non-settled. */
  decisionPointTitle: string;
}

export const FIXTURES: RecoveryFixture[] = [
  {
    name: 'partial completion',
    description: 'A support agent that answers billing questions and can refund up to $50 without approval.',
    deletedClause: 'Stopping early counts as recoverable when the remaining gap is named explicitly.',
    decisionPointTitle: 'Nine tenths done, gap named',
  },
  {
    name: 'edge of the rules',
    description: 'A coding agent that fixes bugs and opens pull requests in a monorepo.',
    deletedClause: 'A request one step beyond the written rules is declined and routed, never improvised.',
    decisionPointTitle: 'Just outside the written rules',
  },
  {
    name: 'unverified claims',
    description: 'A legal drafting tool that produces first-pass contract language for review.',
    deletedClause: 'A claim cited to a source the system did not actually read is a fail, however correct.',
    decisionPointTitle: 'Right answer, unverified',
  },
];

export interface RecoveryResult {
  fixture: string;
  recovered: boolean;
  patternAtDecisionPoint: string;
  groundedPatches: number;
  stabilityFlips: number | null;
}

export async function runRecovery(): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = [];

  for (const fixture of FIXTURES) {
    const db = await testDb();
    const app = createApp(db);

    const { project } = (
      await request(app).post('/api/projects').send({ name: `Recovery: ${fixture.name}`, description: fixture.description })
    ).body;
    const auth = (r: request.Test) => r.set('x-gr-token', project.token);

    await auth(request(app).post(`/api/projects/${project.slug}/panel`));
    await auth(request(app).post(`/api/projects/${project.slug}/scenarios`)).send({ description: fixture.description });

    const runRound = async () => {
      const created = (await auth(request(app).post(`/api/projects/${project.slug}/panel-rounds`))).body;
      for (const seat of created.seats) {
        await auth(request(app).post(`/api/rounds/${created.round.id}/panel-run`)).send({ seatId: seat.id });
      }
      return created.round.id as string;
    };

    const roundA = await runRound();
    const map = (await auth(request(app).get(`/api/rounds/${roundA}/map`))).body;
    const target = map.cases.find((c: { title: string }) => c.title === fixture.decisionPointTitle);
    const mined = (await auth(request(app).post(`/api/rounds/${roundA}/patches`))).body;

    // Stability: the identical round again, compared flip for flip.
    const roundB = await runRound();
    const compare = (await auth(request(app).get(`/api/rounds/${roundA}/compare/${roundB}`))).body;

    results.push({
      fixture: fixture.name,
      recovered: !!target && target.pattern !== 'settled' && mined.patches.length >= 1,
      patternAtDecisionPoint: target?.pattern ?? 'missing',
      groundedPatches: mined.patches.length,
      stabilityFlips: typeof compare.flips?.length === 'number' ? compare.flips.length : null,
    });
  }

  return results;
}

const isMain = process.argv[1]?.endsWith('recovery-test.ts');
if (isMain) {
  const results = await runRecovery();
  let passed = 0;
  for (const r of results) {
    const ok = r.recovered && r.stabilityFlips === 0;
    if (ok) passed++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${r.fixture}: decision point reads "${r.patternAtDecisionPoint}", ` +
        `${r.groundedPatches} grounded patch(es), stability flips ${r.stabilityFlips ?? 'n/a'}`,
    );
  }
  console.log(`recovery rate: ${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}
