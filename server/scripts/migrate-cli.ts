/**
 * Creates the schema on a fresh database, or brings an existing one up to date.
 * `npm run db:migrate`
 *
 * openDb() already runs this on connect, which is what keeps a cold serverless
 * instance correct. Running it explicitly is for the first deploy, where you
 * want a clear pass or a clear error before any traffic arrives — rather than
 * discovering a bad DATABASE_URL through a 500 on someone's first request.
 */
import { openDb } from '../db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at your Postgres database and run this again.');
  process.exit(1);
}

const db = await openDb(url);
const { count } = (await db.get<{ count: string }>(
  `SELECT COUNT(*) AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN
      ('projects','graders','traces','rubric_versions','rubric_clauses','rounds',
       'round_items','grades','resolutions','judge_runs','judge_verdicts')`,
))!;

await db.close();

// Eleven tables is the whole schema. Anything less means the DDL did not land.
if (Number(count) !== 11) {
  console.error(`Schema is incomplete: found ${count} of 11 tables.`);
  process.exit(1);
}
console.log(`Schema is up to date — all 11 tables present on ${new URL(url).host}.`);
