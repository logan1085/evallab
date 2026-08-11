/**
 * Postgres, behind a deliberately small interface.
 *
 * The product ran on a SQLite file until it needed to run on Vercel, where
 * there is no disk to keep one on: functions are ephemeral and a request can
 * land on any machine. Postgres is forced by that, and then forced again by
 * multi-tenancy, where one file per instance is a single point of failure.
 *
 * Two drivers sit behind the same four methods. Production uses a `pg` pool
 * against Neon; tests use PGlite, which is Postgres compiled to WASM and runs
 * in-process — so the suite exercises real Postgres semantics without a server
 * to start or a container to wait on.
 *
 * The interface keeps `?` placeholders and rewrites them to `$1..$n` on the way
 * through. That is not laziness about SQL dialects: it kept the port to this
 * file plus a mechanical change at the call sites, instead of touching every
 * query string in the store and risking a typo in each one.
 */

import { randomBytes, randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

export interface DB {
  get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Multi-statement DDL. No parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
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

/**
 * Columns added after the first release. `ADD COLUMN IF NOT EXISTS` makes this
 * safe to run on every boot, which matters on a platform that may start a new
 * instance for any request.
 */
const MIGRATIONS = `
ALTER TABLE rubric_versions ADD COLUMN IF NOT EXISTS open_questions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE rubric_versions ADD COLUMN IF NOT EXISTS drafted_from   TEXT;
`;

/** `?` is what the store writes; Postgres wants `$1`. Quoted literals are left alone. */
export function toPositional(sql: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

/* ---- Drivers ------------------------------------------------------------ */

interface QueryResult {
  rows: Row[];
  changes: number;
}

function adapt(query: (sql: string, params: unknown[]) => Promise<QueryResult>, close: () => Promise<void>): DB {
  return {
    async get<T>(sql: string, ...params: unknown[]) {
      const { rows } = await query(toPositional(sql), params);
      return rows[0] as T | undefined;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const { rows } = await query(toPositional(sql), params);
      return rows as T[];
    },
    async run(sql: string, ...params: unknown[]) {
      const { changes } = await query(toPositional(sql), params);
      return { changes };
    },
    async exec(sql: string) {
      await query(sql, []);
    },
    close,
  };
}

async function pgliteDb(): Promise<DB> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  return adapt(
    async (sql, params) => {
      // PGlite runs one statement per query(); exec() takes a whole script.
      if (params.length === 0 && sql.includes(';')) {
        await lite.exec(sql);
        return { rows: [], changes: 0 };
      }
      const res = await lite.query(sql, params as never[]);
      return { rows: (res.rows ?? []) as Row[], changes: res.affectedRows ?? 0 };
    },
    async () => {
      await lite.close();
    },
  );
}

async function poolDb(connectionString: string): Promise<DB> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString,
    // Serverless functions open connections fast and hold them briefly; a
    // small ceiling per instance is what keeps the pooler from running out.
    max: Number(process.env.GR_PG_MAX ?? 4),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return adapt(
    async (sql, params) => {
      const res = await pool.query(sql, params);
      return { rows: res.rows as Row[], changes: res.rowCount ?? 0 };
    },
    () => pool.end(),
  );
}

/**
 * `:memory:` and an unset DATABASE_URL both mean PGlite. The second is the
 * developer default: `npm run dev` works with nothing installed, and the data
 * is gone on restart — which is the honest behaviour, rather than a file that
 * looks durable and is not the thing production runs on.
 */
export async function openDb(url = process.env.DATABASE_URL ?? ':memory:'): Promise<DB> {
  const db = url === ':memory:' ? await pgliteDb() : await poolDb(url);
  await ensureSchema(db);
  return db;
}

/** Idempotent by construction, so it is safe on every cold start. */
export async function ensureSchema(db: DB): Promise<void> {
  await db.exec(SCHEMA);
  await db.exec(MIGRATIONS);
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
