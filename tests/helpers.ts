/**
 * One Postgres per test file, not one per test.
 *
 * PGlite boots a WASM Postgres in roughly two seconds. Doing that in a
 * `beforeEach` took the suite from under two seconds to nearly ninety, and a
 * suite that slow stops being run. Truncating is milliseconds and gives the same
 * isolation, so the instance is shared within a file and the data is not.
 *
 * Vitest runs each test file in its own worker, so files still cannot see each
 * other's rows.
 */
import { openDb, type DB } from '../server/db.js';

const TABLES = [
  'judge_verdicts',
  'judge_runs',
  'resolutions',
  'grades',
  'round_items',
  'rounds',
  'rubric_clauses',
  'rubric_versions',
  'traces',
  'graders',
  'projects',
];

let shared: DB | null = null;

/** A database with the schema in place and no rows in it. */
export async function testDb(): Promise<DB> {
  if (!shared) {
    shared = await openDb(':memory:');
    return shared;
  }
  // RESTART IDENTITY is not needed — every id is generated in application code —
  // but CASCADE is, because these tables are a foreign-key chain.
  await shared.exec(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
  return shared;
}
