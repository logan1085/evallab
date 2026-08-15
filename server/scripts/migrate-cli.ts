/**
 * Creates the schema on a fresh database, or brings an existing one up to date.
 * `npm run db:migrate`
 *
 * openDb() already runs this on connect, which is what keeps a cold serverless
 * instance correct. Running it explicitly is for the first deploy, where you
 * want a clear pass or a clear error before any traffic arrives — rather than
 * discovering a bad connection string through a 500 on someone's first request.
 */
import { CONNECTION_URL_VARS, openDb, resolveConnection } from '../db.js';

const EXPECTED_TABLES = [
  'projects',
  'graders',
  'traces',
  'documents',
  'rubric_versions',
  'rubric_clauses',
  'rounds',
  'round_items',
  'grades',
  'resolutions',
  'judge_runs',
  'judge_verdicts',
];

const { url, via, pooled } = resolveConnection();
if (!url) {
  console.error('No connection string found. Set one of:');
  for (const name of CONNECTION_URL_VARS) console.error(`  ${name}`);
  console.error('\nIf you provisioned Postgres from inside Vercel, pull the values first:');
  console.error('  npx vercel env pull .env.local');
  process.exit(1);
}

console.log(`Using ${via}.`);
if (!pooled) {
  // Not fatal — a direct connection is correct for a one-off migration, and is
  // the only option on some providers. It is the wrong thing to serve traffic
  // on, so it gets said once rather than discovered under load.
  console.warn(
    'Warning: this looks like a direct connection, not a pooled one. Fine for migrating,\n' +
      '         but serverless functions will exhaust it. Use the pooled string for the app.',
  );
}

const db = await openDb(url);
const rows = await db.all<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(?)`,
  EXPECTED_TABLES,
);
await db.close();

const found = new Set(rows.map((r) => r.table_name));
const missing = EXPECTED_TABLES.filter((t) => !found.has(t));

if (missing.length > 0) {
  console.error(`Schema is incomplete. Missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`Schema is up to date: all ${EXPECTED_TABLES.length} tables present on ${new URL(url).host}.`);
