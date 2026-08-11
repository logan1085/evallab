/**
 * Columns added after the first release reach an existing database only through
 * `ensureSchema` — `CREATE TABLE IF NOT EXISTS` does nothing once the table is
 * there. On a serverless platform this runs on every cold start, so it has to be
 * both idempotent and actually effective, and this exercises each.
 */
import { describe, expect, it } from 'vitest';
import { ensureSchema, openDb, toPositional, type DB } from '../server/db.js';
import * as store from '../server/store.js';

async function columns(db: DB): Promise<string[]> {
  const rows = await db.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'rubric_versions'",
  );
  return rows.map((r) => r.column_name);
}

describe('ensureSchema on a database written by an older build', () => {
  it('adds the drafting columns and reads rubrics through them', async () => {
    const db = await openDb(':memory:');
    const project = await store.createProject(db, { slug: 'p', token: 't', name: 'P' });
    await store.createRubricVersion(db, { projectId: project.id, name: 'First' });

    // Roll the schema back to what shipped before drafting existed.
    await db.exec('ALTER TABLE rubric_versions DROP COLUMN open_questions');
    await db.exec('ALTER TABLE rubric_versions DROP COLUMN drafted_from');
    expect(await columns(db)).not.toContain('open_questions');

    await ensureSchema(db);
    expect(await columns(db)).toContain('open_questions');
    expect(await columns(db)).toContain('drafted_from');

    const rubric = await store.currentRubric(db, project.id);
    expect(rubric?.name).toBe('First');
    expect(rubric?.openQuestions).toEqual([]);
    expect(rubric?.draftedFrom).toBeNull();

    // Present is not the same as writable.
    const saved = await store.updateRubricInPlace(db, rubric!.id, {
      openQuestions: [{ id: 'q1', question: 'Is an escalation a pass?', why: 'Never shown.' }],
    });
    expect(saved?.openQuestions).toHaveLength(1);
    await db.close();
  });

  it('is safe to run repeatedly, which is what a cold start does', async () => {
    const db = await openDb(':memory:');
    await ensureSchema(db);
    await ensureSchema(db);
    const project = await store.createProject(db, { slug: 'p2', token: 't', name: 'P2' });
    expect((await store.getProjectBySlug(db, 'p2'))?.id).toBe(project.id);
    await db.close();
  });
});

/**
 * The store writes `?` and Postgres wants `$1`. A rewrite that miscounts does
 * not throw — it binds the wrong value to the wrong column, which is the kind
 * of bug that reaches production looking like data corruption.
 */
describe('placeholder rewriting', () => {
  it('numbers placeholders left to right, from one', () => {
    expect(toPositional('INSERT INTO t (a, b, c) VALUES (?, ?, ?)')).toBe(
      'INSERT INTO t (a, b, c) VALUES ($1, $2, $3)',
    );
  });

  it('leaves question marks inside string literals alone', () => {
    expect(toPositional("SELECT * FROM t WHERE q = 'is it a pass?' AND id = ?")).toBe(
      "SELECT * FROM t WHERE q = 'is it a pass?' AND id = $1",
    );
    expect(toPositional('UPDATE t SET note = ? WHERE label = "why?" AND id = ?')).toBe(
      'UPDATE t SET note = $1 WHERE label = "why?" AND id = $2',
    );
  });

  it('leaves SQL with no placeholders untouched', () => {
    expect(toPositional('SELECT 1 AS ok')).toBe('SELECT 1 AS ok');
  });

  it('keeps counting across newlines in a multi-line statement', () => {
    expect(toPositional('UPDATE t\n  SET a = ?,\n      b = ?\n  WHERE id = ?')).toBe(
      'UPDATE t\n  SET a = $1,\n      b = $2\n  WHERE id = $3',
    );
  });
});
