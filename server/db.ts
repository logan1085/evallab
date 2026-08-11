import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';

// Loaded through createRequire rather than a static import: bundlers whose
// builtin list predates Node 22 try to resolve `node:sqlite` from disk and fail.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export type DB = InstanceType<typeof DatabaseSync>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  token       TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graders (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'paste',
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_project ON traces(project_id);

CREATE TABLE IF NOT EXISTS rubric_versions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  parent_version_id TEXT,
  name              TEXT NOT NULL,
  preamble          TEXT NOT NULL DEFAULT '',
  scale             TEXT NOT NULL,
  criteria          TEXT NOT NULL DEFAULT '[]',
  open_questions    TEXT NOT NULL DEFAULT '[]',
  drafted_from      TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS rubric_clauses (
  id                TEXT PRIMARY KEY,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  origin_item_id    TEXT,
  origin_round_id   TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clauses_rubric ON rubric_clauses(rubric_version_id);

CREATE TABLE IF NOT EXISTS rounds (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  idx               INTEGER NOT NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  strategy          TEXT NOT NULL DEFAULT 'random',
  seed              TEXT NOT NULL,
  sampling_note     TEXT NOT NULL DEFAULT '',
  source_round_id   TEXT,
  created_at        TEXT NOT NULL,
  closed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_rounds_project ON rounds(project_id);

CREATE TABLE IF NOT EXISTS round_items (
  id        TEXT PRIMARY KEY,
  round_id  TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  trace_id  TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  arm       TEXT NOT NULL DEFAULT 'calibration',
  position  INTEGER NOT NULL,
  UNIQUE (round_id, trace_id)
);
CREATE INDEX IF NOT EXISTS idx_items_round ON round_items(round_id);

CREATE TABLE IF NOT EXISTS grades (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES round_items(id) ON DELETE CASCADE,
  grader_id   TEXT NOT NULL REFERENCES graders(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (item_id, grader_id)
);
CREATE INDEX IF NOT EXISTS idx_grades_item ON grades(item_id);

CREATE TABLE IF NOT EXISTS resolutions (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL UNIQUE REFERENCES round_items(id) ON DELETE CASCADE,
  agreed_verdict  TEXT NOT NULL,
  clause_text     TEXT NOT NULL,
  rationale       TEXT NOT NULL DEFAULT '',
  clause_id       TEXT,
  resolved_by     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_runs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id          TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  arm               TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_verdicts (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES judge_runs(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL REFERENCES round_items(id) ON DELETE CASCADE,
  verdict   TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_judge_verdicts_run ON judge_verdicts(run_id);
`;

export function openDb(file = process.env.GR_DB ?? 'data/grading-room.db'): DB {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  if (file !== ':memory:') {
    // A round has several people submitting grades at once. WAL plus a wait —
    // rather than an immediate SQLITE_BUSY — is the difference between a slow
    // write and a grader losing a verdict they thought they had saved.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}

/**
 * Columns added after the first release.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a database that already has
 * the table, so a new column in SCHEMA never reaches an existing file. Adding it
 * here keeps a running deployment working across an upgrade instead of failing
 * on the first query that mentions the column.
 */
function migrate(db: DB): void {
  addColumn(db, 'rubric_versions', 'open_questions', "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, 'rubric_versions', 'drafted_from', 'TEXT');
}

function addColumn(db: DB, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Consistent on-disk copy while the server is running. SQLite's own backup
 * command handles the WAL correctly; copying the .db file by hand does not.
 */
export function backupTo(db: DB, destination: string): void {
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  db.prepare('VACUUM INTO ?').run(resolve(destination));
}

export function newId(prefix = ''): string {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 20);
}

/** Slug + token are the whole auth model in v1. Token needs real entropy; slug just needs to be typeable. */
export function newSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'project';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function now(): string {
  return new Date().toISOString();
}
