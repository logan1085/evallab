/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a database that already has the
 * table, so every column added after the first release reaches existing data
 * only through `migrate()`. This test simulates the upgrade by removing the new
 * columns from a real file and reopening it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import * as store from '../server/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'grading-room-migration-'));
  dirs.push(dir);
  return join(dir, 'test.db');
}

describe('opening a database written by an older build', () => {
  it('adds the drafting columns and reads rubrics through them', () => {
    const file = tempDbPath();

    const old = openDb(file);
    const project = store.createProject(old, { slug: 'p', token: 't', name: 'P' });
    store.createRubricVersion(old, { projectId: project.id, name: 'First' });
    // Roll the schema back to what shipped before drafting existed.
    old.exec('ALTER TABLE rubric_versions DROP COLUMN open_questions');
    old.exec('ALTER TABLE rubric_versions DROP COLUMN drafted_from');
    old.close();

    const upgraded = openDb(file);
    const rubric = store.currentRubric(upgraded, project.id);
    expect(rubric?.name).toBe('First');
    expect(rubric?.openQuestions).toEqual([]);
    expect(rubric?.draftedFrom).toBeNull();

    // And the columns are writable, not just present.
    const saved = store.updateRubricInPlace(upgraded, rubric!.id, {
      openQuestions: [{ id: 'q1', question: 'Is an escalation a pass?', why: 'Never shown.' }],
    });
    expect(saved?.openQuestions).toHaveLength(1);
    upgraded.close();
  });

  it('is safe to run twice', () => {
    const file = tempDbPath();
    openDb(file).close();
    expect(() => openDb(file).close()).not.toThrow();
  });
});
