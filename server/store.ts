/**
 * Data access. Everything the routes need, expressed in domain nouns.
 *
 * The one rule this layer enforces on behalf of the whole product: while a
 * round is open, nothing in here will hand back another grader's verdict.
 * `verdictsForRound` is the only function that can, and it refuses on an open
 * round unless explicitly told the caller is the report path for a closed one.
 */

import type { DB } from './db.js';
import { newId, now } from './db.js';
import {
  DEFAULT_SCALE,
  type DocumentKind,
  type DraftConflict,
  type DraftProvenance,
  type DraftQuestion,
  type OperatingDocument,
  type Grade,
  type Grader,
  type ItemArm,
  type ItemVerdicts,
  type Project,
  type Resolution,
  type Round,
  type RoundItem,
  type RubricClause,
  type RubricVersion,
  type Trace,
  type VerdictLevel,
} from '../shared/types.js';

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const nullable = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/* ---- Projects ----------------------------------------------------------- */

export async function createProject(
  db: DB,
  args: { id?: string; slug: string; token: string; name: string; description?: string },
): Promise<Project> {
  const project: Project = {
    id: args.id ?? newId(),
    slug: args.slug,
    token: args.token,
    name: args.name,
    description: args.description ?? '',
    createdAt: now(),
  };
  await db.run(
    'INSERT INTO projects (id, slug, token, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    project.slug,
    project.token,
    project.name,
    project.description,
    project.createdAt,
  );
  return project;
}

export async function getProjectBySlug(db: DB, slug: string): Promise<Project | null> {
  const row = await db.get('SELECT * FROM projects WHERE slug = ?', slug) as Row | undefined;
  return row ? toProject(row) : null;
}

export async function getProjectById(db: DB, id: string): Promise<Project | null> {
  const row = await db.get('SELECT * FROM projects WHERE id = ?', id) as Row | undefined;
  return row ? toProject(row) : null;
}

export async function getProjectSlug(db: DB, id: string): Promise<string | null> {
  const row = await db.get('SELECT slug FROM projects WHERE id = ?', id) as Row | undefined;
  return row ? str(row.slug) : null;
}

function toProject(row: Row): Project {
  return {
    id: str(row.id),
    slug: str(row.slug),
    token: str(row.token),
    name: str(row.name),
    description: str(row.description),
    createdAt: str(row.created_at),
  };
}

/* ---- Graders ------------------------------------------------------------ */

/** Idempotent by name: rejoining from a second device must not create a second grader. */
export async function upsertGrader(db: DB, projectId: string, name: string): Promise<Grader> {
  const trimmed = name.trim();
  const existing = await db.get('SELECT * FROM graders WHERE project_id = ? AND name = ?', projectId, trimmed) as Row | undefined;
  if (existing) return toGrader(existing);

  return insertGrader(db, { projectId, name: trimmed, kind: 'human' });
}

/** All graders are seats; a human is a seat with no model behind it. */
export async function insertGrader(
  db: DB,
  seat: {
    projectId: string;
    name: string;
    kind: Grader['kind'];
    objective?: string;
    failsFor?: string;
    model?: string;
    family?: string;
    origin?: string;
    archetypeId?: string | null;
    weight?: number;
    sameFamilyAsSut?: boolean;
  },
): Promise<Grader> {
  const grader: Grader = {
    id: newId(),
    projectId: seat.projectId,
    name: seat.name,
    kind: seat.kind,
    objective: seat.objective ?? '',
    failsFor: seat.failsFor ?? '',
    model: seat.model ?? '',
    family: seat.family ?? '',
    origin: seat.origin ?? 'user',
    archetypeId: seat.archetypeId ?? null,
    weight: seat.weight ?? 1,
    sameFamilyAsSut: seat.sameFamilyAsSut ?? false,
    createdAt: now(),
  };
  await db.run(
    `INSERT INTO graders (id, project_id, name, kind, objective, fails_for, model, family, origin, archetype_id, weight, same_family_as_sut, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    grader.id, grader.projectId, grader.name, grader.kind, grader.objective, grader.failsFor,
    grader.model, grader.family, grader.origin, grader.archetypeId, grader.weight,
    grader.sameFamilyAsSut, grader.createdAt,
  );
  return grader;
}

export async function updateSeat(
  db: DB,
  projectId: string,
  seatId: string,
  fields: { name?: string; objective?: string; failsFor?: string; model?: string; family?: string },
): Promise<Grader | null> {
  const existing = await getGrader(db, seatId);
  if (!existing || existing.projectId !== projectId) return null;
  await db.run(
    'UPDATE graders SET name = ?, objective = ?, fails_for = ?, model = ?, family = ?, origin = ? WHERE id = ?',
    fields.name ?? existing.name,
    fields.objective ?? existing.objective,
    fields.failsFor ?? existing.failsFor,
    fields.model ?? existing.model,
    fields.family ?? existing.family,
    'user',
    seatId,
  );
  return getGrader(db, seatId);
}

export async function deleteSeat(db: DB, projectId: string, seatId: string): Promise<boolean> {
  const res = await db.run("DELETE FROM graders WHERE id = ? AND project_id = ? AND kind = 'panelist'", seatId, projectId);
  return Number(res.changes) > 0;
}

export async function recordPanelEdit(
  db: DB,
  edit: { projectId: string; seatName: string; action: string; before?: string; after?: string; note?: string },
): Promise<void> {
  await db.run(
    'INSERT INTO panel_edits (id, project_id, seat_name, action, before, after, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), edit.projectId, edit.seatName, edit.action, edit.before ?? '', edit.after ?? '', edit.note ?? '', now(),
  );
}

export async function listPanelEdits(db: DB, projectId: string) {
  return (await db.all('SELECT * FROM panel_edits WHERE project_id = ? ORDER BY created_at', projectId) as Row[]).map((row) => ({
    id: str(row.id),
    seatName: str(row.seat_name),
    action: str(row.action),
    before: str(row.before),
    after: str(row.after),
    note: str(row.note),
    createdAt: str(row.created_at),
  }));
}

export async function listGraders(db: DB, projectId: string): Promise<Grader[]> {
  return (await db.all('SELECT * FROM graders WHERE project_id = ? ORDER BY created_at, id', projectId) as Row[]).map(
    toGrader,
  );
}

export async function getGrader(db: DB, id: string): Promise<Grader | null> {
  const row = await db.get('SELECT * FROM graders WHERE id = ?', id) as Row | undefined;
  return row ? toGrader(row) : null;
}

function toGrader(row: Row): Grader {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    name: str(row.name),
    kind: (str(row.kind ?? 'human') as Grader['kind']) || 'human',
    objective: str(row.objective ?? ''),
    failsFor: str(row.fails_for ?? ''),
    model: str(row.model ?? ''),
    family: str(row.family ?? ''),
    origin: str(row.origin ?? 'user'),
    archetypeId: row.archetype_id == null ? null : str(row.archetype_id),
    weight: Number(row.weight ?? 1),
    sameFamilyAsSut: Boolean(row.same_family_as_sut),
    createdAt: str(row.created_at),
  };
}

/* ---- Traces ------------------------------------------------------------- */

export async function addTraces(
  db: DB,
  projectId: string,
  traces: { title: string; content: string; source?: string; meta?: Record<string, unknown> }[],
): Promise<Trace[]> {
  const sql =
    'INSERT INTO traces (id, project_id, title, content, source, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const out: Trace[] = [];
  for (const t of traces) {
    const trace: Trace = {
      id: newId(),
      projectId,
      title: t.title.trim() || 'Untitled trace',
      content: t.content,
      source: t.source ?? 'paste',
      meta: t.meta ?? {},
      expectedVerdict: null,
      expectedReason: '',
      createdAt: now(),
    };
    await db.run(
      sql,
      trace.id,
      projectId,
      trace.title,
      trace.content,
      trace.source,
      JSON.stringify(trace.meta),
      trace.createdAt,
    );
    out.push(trace);
  }
  return out;
}

export async function listTraces(db: DB, projectId: string): Promise<Trace[]> {
  return (await db.all('SELECT * FROM traces WHERE project_id = ? ORDER BY created_at, id', projectId) as Row[]).map(
    toTrace,
  );
}

export async function getTrace(db: DB, id: string): Promise<Trace | null> {
  const row = await db.get('SELECT * FROM traces WHERE id = ?', id) as Row | undefined;
  return row ? toTrace(row) : null;
}

export async function setTraceExpected(
  db: DB,
  projectId: string,
  traceId: string,
  expected: { verdict: string | null; reason: string },
): Promise<Trace | null> {
  await db.run(
    'UPDATE traces SET expected_verdict = ?, expected_reason = ? WHERE id = ? AND project_id = ?',
    expected.verdict,
    expected.reason,
    traceId,
    projectId,
  );
  return getTrace(db, traceId);
}

export async function deleteTrace(db: DB, projectId: string, traceId: string): Promise<boolean> {
  const res = await db.run('DELETE FROM traces WHERE id = ? AND project_id = ?', traceId, projectId);
  return Number(res.changes) > 0;
}

function toTrace(row: Row): Trace {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    title: str(row.title),
    content: str(row.content),
    source: str(row.source),
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    expectedVerdict: row.expected_verdict == null ? null : str(row.expected_verdict),
    expectedReason: str(row.expected_reason ?? ''),
    createdAt: str(row.created_at),
  };
}

/* ---- Operating documents ------------------------------------------------ */

export async function addDocuments(
  db: DB,
  projectId: string,
  docs: { title: string; kind?: DocumentKind; content: string }[],
): Promise<OperatingDocument[]> {
  const sql = 'INSERT INTO documents (id, project_id, title, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  const out: OperatingDocument[] = [];
  for (const d of docs) {
    const doc: OperatingDocument = {
      id: newId(),
      projectId,
      title: d.title.trim() || 'Untitled document',
      kind: d.kind ?? 'policy',
      content: d.content,
      createdAt: now(),
    };
    await db.run(sql, doc.id, projectId, doc.title, doc.kind, doc.content, doc.createdAt);
    out.push(doc);
  }
  return out;
}

export async function listDocuments(db: DB, projectId: string): Promise<OperatingDocument[]> {
  const rows = (await db.all(
    'SELECT * FROM documents WHERE project_id = ? ORDER BY created_at, id',
    projectId,
  )) as Row[];
  return rows.map(toDocument);
}

export async function getDocument(db: DB, id: string): Promise<OperatingDocument | null> {
  const row = (await db.get('SELECT * FROM documents WHERE id = ?', id)) as Row | undefined;
  return row ? toDocument(row) : null;
}

export async function deleteDocument(db: DB, projectId: string, id: string): Promise<boolean> {
  const res = await db.run('DELETE FROM documents WHERE id = ? AND project_id = ?', id, projectId);
  return Number(res.changes) > 0;
}

function toDocument(row: Row): OperatingDocument {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    title: str(row.title),
    kind: str(row.kind, 'policy') as DocumentKind,
    content: str(row.content),
    createdAt: str(row.created_at),
  };
}

/* ---- Rubrics ------------------------------------------------------------ */

export async function createRubricVersion(
  db: DB,
  args: {
    projectId: string;
    name: string;
    preamble?: string;
    scale?: VerdictLevel[];
    criteria?: RubricVersion['criteria'];
    parentVersionId?: string | null;
    clauses?: { text: string; originItemId?: string | null; originRoundId?: string | null }[];
    openQuestions?: DraftQuestion[];
    conflicts?: DraftConflict[];
    draftedFrom?: DraftProvenance | null;
    changelog?: string;
  },
): Promise<RubricVersion> {
  const maxRow = await db.get('SELECT COALESCE(MAX(version), 0) AS v FROM rubric_versions WHERE project_id = ?', args.projectId) as Row;
  const version = num(maxRow.v) + 1;

  const rubric: RubricVersion = {
    id: newId(),
    projectId: args.projectId,
    version,
    parentVersionId: args.parentVersionId ?? null,
    name: args.name,
    preamble: args.preamble ?? '',
    scale: args.scale && args.scale.length > 0 ? args.scale : DEFAULT_SCALE,
    criteria: args.criteria ?? [],
    clauses: [],
    openQuestions: args.openQuestions ?? [],
    conflicts: args.conflicts ?? [],
    draftedFrom: args.draftedFrom ?? null,
    createdAt: now(),
  };

  await db.run(`INSERT INTO rubric_versions
       (id, project_id, version, parent_version_id, name, preamble, scale, criteria, open_questions, conflicts, drafted_from, changelog, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, rubric.id,
    rubric.projectId,
    rubric.version,
    rubric.parentVersionId,
    rubric.name,
    rubric.preamble,
    JSON.stringify(rubric.scale),
    JSON.stringify(rubric.criteria),
    JSON.stringify(rubric.openQuestions),
    JSON.stringify(rubric.conflicts),
    rubric.draftedFrom ? JSON.stringify(rubric.draftedFrom) : null,
    args.changelog ?? '',
    rubric.createdAt,);

  const clauses = args.clauses ?? [];
  const clauseSql = `INSERT INTO rubric_clauses (id, rubric_version_id, text, origin_item_id, origin_round_id, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`;
  for (const [i, c] of clauses.entries()) {
    const clause: RubricClause = {
      id: newId(),
      text: c.text,
      originItemId: c.originItemId ?? null,
      originRoundId: c.originRoundId ?? null,
      createdAt: now(),
    };
    await db.run(clauseSql, clause.id, rubric.id, clause.text, clause.originItemId, clause.originRoundId, i, clause.createdAt);
    rubric.clauses.push(clause);
  }

  return rubric;
}

export async function getRubric(db: DB, id: string): Promise<RubricVersion | null> {
  const row = await db.get('SELECT * FROM rubric_versions WHERE id = ?', id) as Row | undefined;
  return row ? hydrateRubric(db, row) : null;
}

export async function currentRubric(db: DB, projectId: string): Promise<RubricVersion | null> {
  const row = await db.get('SELECT * FROM rubric_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1', projectId) as Row | undefined;
  return row ? hydrateRubric(db, row) : null;
}

export async function listRubrics(db: DB, projectId: string): Promise<RubricVersion[]> {
  const rows = (await db.all(
    'SELECT * FROM rubric_versions WHERE project_id = ? ORDER BY version',
    projectId,
  )) as Row[];
  return Promise.all(rows.map((row) => hydrateRubric(db, row)));
}

/** True once a round has pinned this version. Pinned versions are immutable; edits fork instead. */
export async function rubricIsPinned(db: DB, rubricVersionId: string): Promise<boolean> {
  const row = await db.get('SELECT COUNT(*) AS n FROM rounds WHERE rubric_version_id = ?', rubricVersionId) as Row;
  return num(row.n) > 0;
}

export async function updateRubricInPlace(
  db: DB,
  id: string,
  patch: {
    name?: string;
    preamble?: string;
    scale?: VerdictLevel[];
    criteria?: RubricVersion['criteria'];
    openQuestions?: DraftQuestion[];
    conflicts?: DraftConflict[];
    draftedFrom?: DraftProvenance | null;
  },
): Promise<RubricVersion | null> {
  const existing = await getRubric(db, id);
  if (!existing) return null;
  const next = {
    name: patch.name ?? existing.name,
    preamble: patch.preamble ?? existing.preamble,
    scale: patch.scale ?? existing.scale,
    criteria: patch.criteria ?? existing.criteria,
    openQuestions: patch.openQuestions ?? existing.openQuestions,
    conflicts: patch.conflicts ?? existing.conflicts,
    draftedFrom: patch.draftedFrom === undefined ? existing.draftedFrom : patch.draftedFrom,
  };
  await db.run(`UPDATE rubric_versions
        SET name = ?, preamble = ?, scale = ?, criteria = ?, open_questions = ?, conflicts = ?, drafted_from = ?
      WHERE id = ?`, next.name,
    next.preamble,
    JSON.stringify(next.scale),
    JSON.stringify(next.criteria),
    JSON.stringify(next.openQuestions),
    JSON.stringify(next.conflicts),
    next.draftedFrom ? JSON.stringify(next.draftedFrom) : null,
    id,);
  return await getRubric(db, id);
}

async function hydrateRubric(db: DB, row: Row): Promise<RubricVersion> {
  const id = str(row.id);
  const clauses = (
    await db.all('SELECT * FROM rubric_clauses WHERE rubric_version_id = ? ORDER BY position, created_at', id) as Row[]
  ).map(
    (c): RubricClause => ({
      id: str(c.id),
      text: str(c.text),
      originItemId: nullable(c.origin_item_id),
      originRoundId: nullable(c.origin_round_id),
      createdAt: str(c.created_at),
    }),
  );
  return {
    id,
    projectId: str(row.project_id),
    version: num(row.version),
    parentVersionId: nullable(row.parent_version_id),
    name: str(row.name),
    preamble: str(row.preamble),
    scale: parseJson<VerdictLevel[]>(row.scale, DEFAULT_SCALE),
    criteria: parseJson<RubricVersion['criteria']>(row.criteria, []),
    clauses,
    openQuestions: parseJson<DraftQuestion[]>(row.open_questions, []),
    conflicts: parseJson<DraftConflict[]>(row.conflicts, []),
    draftedFrom: row.drafted_from == null ? null : parseJson<DraftProvenance | null>(row.drafted_from, null),
    createdAt: str(row.created_at),
  };
}

/* ---- Rounds ------------------------------------------------------------- */

export async function createRound(
  db: DB,
  args: {
    projectId: string;
    rubricVersionId: string;
    name: string;
    strategy: Round['strategy'];
    seed: string;
    samplingNote: string;
    sourceRoundId: string | null;
    calibration: string[];
    heldout: string[];
  },
): Promise<{ round: Round; items: RoundItem[] }> {
  const maxRow = await db.get('SELECT COALESCE(MAX(idx), 0) AS v FROM rounds WHERE project_id = ?', args.projectId) as Row;
  const index = num(maxRow.v) + 1;

  const round: Round = {
    id: newId(),
    projectId: args.projectId,
    rubricVersionId: args.rubricVersionId,
    index,
    name: args.name || `Round ${index}`,
    status: 'open',
    strategy: args.strategy,
    seed: args.seed,
    sourceRoundId: args.sourceRoundId,
    falseSettleRate: null,
    createdAt: now(),
    closedAt: null,
  };

  await db.run(`INSERT INTO rounds (id, project_id, rubric_version_id, idx, name, status, strategy, seed, sampling_note, source_round_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, round.id,
    round.projectId,
    round.rubricVersionId,
    round.index,
    round.name,
    round.status,
    round.strategy,
    round.seed,
    args.samplingNote,
    round.sourceRoundId,
    round.createdAt,);

  const itemSql = 'INSERT INTO round_items (id, round_id, trace_id, arm, position) VALUES (?, ?, ?, ?, ?)';
  const items: RoundItem[] = [];
  let position = 0;
  // Calibration and held-out are interleaved deliberately: a grader must not be
  // able to tell which arm an item belongs to, or the held-out set stops being
  // a clean measurement.
  const planned: { traceId: string; arm: ItemArm }[] = [
    ...args.calibration.map((traceId) => ({ traceId, arm: 'calibration' as ItemArm })),
    ...args.heldout.map((traceId) => ({ traceId, arm: 'heldout' as ItemArm })),
  ];
  for (const p of interleave(planned, args.seed)) {
    const item: RoundItem = { id: newId(), roundId: round.id, traceId: p.traceId, arm: p.arm, position: position++ };
    await db.run(itemSql, item.id, item.roundId, item.traceId, item.arm, item.position);
    items.push(item);
  }

  return { round, items };
}

function interleave<T>(input: T[], seed: string): T[] {
  // Reuse the sampler's deterministic shuffle semantics without importing the
  // whole module: presentation order only needs to be stable, not unbiased.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = (h >>> 0) ^ 0x9e3779b9;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function getRound(db: DB, id: string): Promise<Round | null> {
  const row = await db.get('SELECT * FROM rounds WHERE id = ?', id) as Row | undefined;
  return row ? toRound(row) : null;
}

export async function roundSamplingNote(db: DB, id: string): Promise<string> {
  const row = await db.get('SELECT sampling_note FROM rounds WHERE id = ?', id) as Row | undefined;
  return row ? str(row.sampling_note) : '';
}

export async function listRounds(db: DB, projectId: string): Promise<Round[]> {
  return (await db.all('SELECT * FROM rounds WHERE project_id = ? ORDER BY idx', projectId) as Row[]).map(toRound);
}

export async function closeRound(db: DB, id: string): Promise<Round | null> {
  await db.run("UPDATE rounds SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'", now(), id);
  return getRound(db, id);
}

export async function reopenRound(db: DB, id: string): Promise<Round | null> {
  await db.run("UPDATE rounds SET status = 'open', closed_at = NULL WHERE id = ?", id);
  return getRound(db, id);
}

function toRound(row: Row): Round {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    rubricVersionId: str(row.rubric_version_id),
    index: num(row.idx),
    name: str(row.name),
    status: str(row.status) === 'closed' ? 'closed' : 'open',
    strategy: str(row.strategy) === 'from_splits' ? 'from_splits' : 'random',
    seed: str(row.seed),
    sourceRoundId: nullable(row.source_round_id),
    falseSettleRate: row.false_settle_rate == null ? null : Number(row.false_settle_rate),
    createdAt: str(row.created_at),
    closedAt: nullable(row.closed_at),
  };
}

export async function listItems(db: DB, roundId: string): Promise<RoundItem[]> {
  return (await db.all('SELECT * FROM round_items WHERE round_id = ? ORDER BY position', roundId) as Row[]).map(
    (row): RoundItem => ({
      id: str(row.id),
      roundId: str(row.round_id),
      traceId: str(row.trace_id),
      arm: str(row.arm) === 'heldout' ? 'heldout' : 'calibration',
      position: num(row.position),
    }),
  );
}

export async function getItem(db: DB, id: string): Promise<RoundItem | null> {
  const row = await db.get('SELECT * FROM round_items WHERE id = ?', id) as Row | undefined;
  if (!row) return null;
  return {
    id: str(row.id),
    roundId: str(row.round_id),
    traceId: str(row.trace_id),
    arm: str(row.arm) === 'heldout' ? 'heldout' : 'calibration',
    position: num(row.position),
  };
}

/* ---- Grades ------------------------------------------------------------- */

export async function submitGrade(
  db: DB,
  args: { itemId: string; graderId: string; verdict: string; note?: string; elapsedMs?: number; outputLength?: number },
): Promise<Grade> {
  const grade: Grade = {
    id: newId(),
    itemId: args.itemId,
    graderId: args.graderId,
    verdict: args.verdict,
    note: args.note ?? '',
    elapsedMs: args.elapsedMs ?? 0,
    createdAt: now(),
  };
  await db.run(`INSERT INTO grades (id, item_id, grader_id, verdict, note, elapsed_ms, output_length, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, grader_id) DO UPDATE SET
       verdict = excluded.verdict, note = excluded.note,
       elapsed_ms = excluded.elapsed_ms, output_length = excluded.output_length, created_at = excluded.created_at`, grade.id, grade.itemId, grade.graderId, grade.verdict, grade.note, grade.elapsedMs, args.outputLength ?? 0, grade.createdAt);

  const stored = await db.get('SELECT * FROM grades WHERE item_id = ? AND grader_id = ?', args.itemId, args.graderId) as Row;
  return toGrade(stored);
}

/** The grader's own grades, and only ever their own. */
export async function gradesForGrader(db: DB, roundId: string, graderId: string): Promise<Grade[]> {
  return (
    await db.all(`SELECT g.* FROM grades g
         JOIN round_items ri ON ri.id = g.item_id
         WHERE ri.round_id = ? AND g.grader_id = ?`, roundId, graderId) as Row[]
  ).map(toGrade);
}

export async function allGradesForRound(db: DB, roundId: string): Promise<Grade[]> {
  return (
    await db.all(`SELECT g.* FROM grades g
         JOIN round_items ri ON ri.id = g.item_id
         WHERE ri.round_id = ?
         ORDER BY ri.position`, roundId) as Row[]
  ).map(toGrade);
}

function toGrade(row: Row): Grade {
  return {
    id: str(row.id),
    itemId: str(row.item_id),
    graderId: str(row.grader_id),
    verdict: str(row.verdict),
    note: str(row.note),
    elapsedMs: num(row.elapsed_ms),
    createdAt: str(row.created_at),
  };
}

/**
 * Per-grader progress. Counts only, never verdicts, so this is safe to expose
 * during an open round: knowing that someone finished tells you nothing about
 * what they decided.
 */
export async function roundProgress(db: DB, roundId: string): Promise<{ graderId: string; name: string; done: number; elapsedMs: number }[]> {
  return (
    await db.all(`SELECT g.grader_id AS grader_id, gr.name AS name, COUNT(*) AS done, COALESCE(SUM(g.elapsed_ms), 0) AS elapsed
         FROM grades g
         JOIN round_items ri ON ri.id = g.item_id
         JOIN graders gr ON gr.id = g.grader_id
         WHERE ri.round_id = ?
         GROUP BY g.grader_id, gr.name
         ORDER BY gr.name`, roundId) as Row[]
  ).map((row) => ({
    graderId: str(row.grader_id),
    name: str(row.name),
    done: num(row.done),
    elapsedMs: num(row.elapsed),
  }));
}

export async function verdictsForRound(db: DB, roundId: string): Promise<ItemVerdicts[]> {
  const items = await listItems(db, roundId);
  const grades = await allGradesForRound(db, roundId);
  const byItem = new Map<string, Record<string, string>>();
  for (const item of items) byItem.set(item.id, {});
  for (const g of grades) {
    const bucket = byItem.get(g.itemId);
    if (bucket) bucket[g.graderId] = g.verdict;
  }
  return items.map((item) => ({ itemId: item.id, byGrader: byItem.get(item.id) ?? {} }));
}

/** Graders who actually submitted at least one grade in this round. */
export async function participantsOf(db: DB, roundId: string): Promise<Grader[]> {
  return (
    await db.all(`SELECT DISTINCT gr.* FROM graders gr
         JOIN grades g ON g.grader_id = gr.id
         JOIN round_items ri ON ri.id = g.item_id
         WHERE ri.round_id = ?
         ORDER BY gr.created_at`, roundId) as Row[]
  ).map(toGrader);
}

/* ---- Resolutions -------------------------------------------------------- */

export async function saveResolution(
  db: DB,
  args: { itemId: string; agreedVerdict: string; clauseText: string; rationale?: string; resolvedBy?: string },
): Promise<Resolution> {
  const resolution: Resolution = {
    id: newId(),
    itemId: args.itemId,
    agreedVerdict: args.agreedVerdict,
    clauseText: args.clauseText.trim(),
    rationale: args.rationale ?? '',
    clauseId: null,
    resolvedBy: args.resolvedBy ?? '',
    createdAt: now(),
  };
  await db.run(`INSERT INTO resolutions (id, item_id, agreed_verdict, clause_text, rationale, clause_id, resolved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET
       agreed_verdict = excluded.agreed_verdict, clause_text = excluded.clause_text,
       rationale = excluded.rationale, resolved_by = excluded.resolved_by, created_at = excluded.created_at`, resolution.id,
    resolution.itemId,
    resolution.agreedVerdict,
    resolution.clauseText,
    resolution.rationale,
    resolution.clauseId,
    resolution.resolvedBy,
    resolution.createdAt,);
  const row = await db.get('SELECT * FROM resolutions WHERE item_id = ?', args.itemId) as Row;
  return toResolution(row);
}

export async function resolutionsForRound(db: DB, roundId: string): Promise<Resolution[]> {
  return (
    await db.all(`SELECT r.* FROM resolutions r
         JOIN round_items ri ON ri.id = r.item_id
         WHERE ri.round_id = ?
         ORDER BY ri.position`, roundId) as Row[]
  ).map(toResolution);
}

export async function deleteResolution(db: DB, itemId: string): Promise<boolean> {
  const res = await db.run('DELETE FROM resolutions WHERE item_id = ?', itemId);
  return Number(res.changes) > 0;
}

function toResolution(row: Row): Resolution {
  return {
    id: str(row.id),
    itemId: str(row.item_id),
    agreedVerdict: str(row.agreed_verdict),
    clauseText: str(row.clause_text),
    rationale: str(row.rationale),
    clauseId: nullable(row.clause_id),
    resolvedBy: str(row.resolved_by),
    createdAt: str(row.created_at),
  };
}

/* ---- Judge -------------------------------------------------------------- */

export async function createJudgeRun(
  db: DB,
  args: { projectId: string; roundId: string; rubricVersionId: string; provider: string; model: string; arm: string },
): Promise<string> {
  const id = newId();
  await db.run(`INSERT INTO judge_runs (id, project_id, round_id, rubric_version_id, provider, model, arm, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, args.projectId, args.roundId, args.rubricVersionId, args.provider, args.model, args.arm, now());
  return id;
}

export async function saveJudgeVerdict(db: DB, runId: string, itemId: string, verdict: string, rationale: string): Promise<void> {
  await db.run('INSERT INTO judge_verdicts (id, run_id, item_id, verdict, rationale) VALUES (?, ?, ?, ?, ?)', newId(),
    runId,
    itemId,
    verdict,
    rationale,);
}

export async function listJudgeRuns(db: DB, roundId: string) {
  return (await db.all('SELECT * FROM judge_runs WHERE round_id = ? ORDER BY created_at', roundId) as Row[]).map(
    (row) => ({
      id: str(row.id),
      projectId: str(row.project_id),
      roundId: str(row.round_id),
      rubricVersionId: str(row.rubric_version_id),
      provider: str(row.provider),
      model: str(row.model),
      arm: str(row.arm),
      createdAt: str(row.created_at),
    }),
  );
}

export async function judgeVerdicts(db: DB, runId: string) {
  return (await db.all('SELECT * FROM judge_verdicts WHERE run_id = ?', runId) as Row[]).map((row) => ({
    id: str(row.id),
    runId: str(row.run_id),
    itemId: str(row.item_id),
    verdict: str(row.verdict),
    rationale: str(row.rationale),
  }));
}


/* ---- Patches (proposed rubric sentences) --------------------------------- */

export interface PatchRecord {
  id: string;
  projectId: string;
  roundId: string;
  text: string;
  /** [{ caseId, seat, quote }] verbatim reasons this patch quotes. */
  evidence: { itemId: string; seat: string; quote: string }[];
  seatsSided: string[];
  projectedLift: number | null;
  status: 'proposed' | 'accepted' | 'rejected';
  resolvedRubricVersionId: string | null;
  createdAt: string;
}

export async function insertPatch(
  db: DB,
  patch: Omit<PatchRecord, 'id' | 'createdAt' | 'status' | 'resolvedRubricVersionId'>,
): Promise<PatchRecord> {
  const record: PatchRecord = {
    ...patch,
    id: newId(),
    status: 'proposed',
    resolvedRubricVersionId: null,
    createdAt: now(),
  };
  await db.run(
    'INSERT INTO patches (id, project_id, round_id, text, evidence, seats_sided, projected_lift, status, resolved_rubric_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    record.id, record.projectId, record.roundId, record.text, JSON.stringify(record.evidence),
    JSON.stringify(record.seatsSided), record.projectedLift, record.status, null, record.createdAt,
  );
  return record;
}

export async function listPatches(db: DB, roundId: string): Promise<PatchRecord[]> {
  return (await db.all('SELECT * FROM patches WHERE round_id = ? ORDER BY created_at', roundId) as Row[]).map(toPatch);
}

export async function getPatch(db: DB, id: string): Promise<PatchRecord | null> {
  const row = await db.get('SELECT * FROM patches WHERE id = ?', id) as Row | undefined;
  return row ? toPatch(row) : null;
}

export async function setPatchStatus(
  db: DB,
  id: string,
  status: 'accepted' | 'rejected',
  resolvedRubricVersionId: string | null,
): Promise<void> {
  await db.run('UPDATE patches SET status = ?, resolved_rubric_version_id = ? WHERE id = ?', status, resolvedRubricVersionId, id);
}

function toPatch(row: Row): PatchRecord {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    roundId: str(row.round_id),
    text: str(row.text),
    evidence: parseJson(row.evidence, []),
    seatsSided: parseJson(row.seats_sided, []),
    projectedLift: row.projected_lift == null ? null : Number(row.projected_lift),
    status: str(row.status) as PatchRecord['status'],
    resolvedRubricVersionId: row.resolved_rubric_version_id == null ? null : str(row.resolved_rubric_version_id),
    createdAt: str(row.created_at),
  };
}

/* ---- The owner's ten ------------------------------------------------------ */

export async function saveUserVerdict(
  db: DB,
  args: { roundId: string; itemId: string; verdict: string; reason: string },
): Promise<void> {
  await db.run(
    `INSERT INTO user_verdicts (id, round_id, item_id, verdict, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id, item_id) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason`,
    newId(), args.roundId, args.itemId, args.verdict, args.reason, now(),
  );
}

export async function listUserVerdicts(db: DB, roundId: string) {
  return (await db.all('SELECT * FROM user_verdicts WHERE round_id = ? ORDER BY created_at', roundId) as Row[]).map((row) => ({
    itemId: str(row.item_id),
    verdict: str(row.verdict),
    reason: str(row.reason),
  }));
}


/* ---- Model-call telemetry ------------------------------------------------- */

export async function recordModelCall(db: DB, a: {
  call_id: string; attempt_no: number; caller_kind: string;
  round_id: string | null; panelist_id: string | null; case_id: string | null;
  pin_id: string; model_family: string; openrouter_model_id: string; provider_slug: string | null;
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  cost_credits: number; upstream_inference_cost: number | null; generation_id: string | null;
  latency_ms: number; http_status: number | null; error_kind: string | null;
}): Promise<void> {
  await db.run(
    `INSERT INTO model_call (id, call_id, attempt_no, caller_kind, round_id, panelist_id, case_id, pin_id, model_family,
       openrouter_model_id, provider_slug, prompt_tokens, completion_tokens, total_tokens, cost_credits,
       upstream_inference_cost, generation_id, latency_ms, http_status, error_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), a.call_id, a.attempt_no, a.caller_kind, a.round_id, a.panelist_id, a.case_id, a.pin_id, a.model_family,
    a.openrouter_model_id, a.provider_slug, a.prompt_tokens, a.completion_tokens, a.total_tokens, a.cost_credits,
    a.upstream_inference_cost, a.generation_id, a.latency_ms, a.http_status, a.error_kind, now(),
  );
}

export interface CostSummary {
  totalCredits: number;
  totalTokens: number;
  byPin: { pinId: string; tokens: number; credits: number }[];
  attempts: number;
}

function toCostSummary(rows: Row[]): CostSummary {
  const byPin = new Map<string, { tokens: number; credits: number }>();
  let credits = 0;
  let tokens = 0;
  for (const r of rows) {
    credits += Number(r.cost_credits ?? 0);
    tokens += Number(r.total_tokens ?? 0);
    const key = str(r.pin_id);
    const agg = byPin.get(key) ?? { tokens: 0, credits: 0 };
    agg.tokens += Number(r.total_tokens ?? 0);
    agg.credits += Number(r.cost_credits ?? 0);
    byPin.set(key, agg);
  }
  return {
    totalCredits: credits,
    totalTokens: tokens,
    byPin: [...byPin.entries()].map(([pinId, v]) => ({ pinId, ...v })),
    attempts: rows.length,
  };
}

export async function costForRound(db: DB, roundId: string): Promise<CostSummary> {
  return toCostSummary(await db.all('SELECT * FROM model_call WHERE round_id = ?', roundId) as Row[]);
}

export async function costForPanelist(db: DB, roundId: string, panelistId: string): Promise<CostSummary> {
  return toCostSummary(
    await db.all('SELECT * FROM model_call WHERE round_id = ? AND panelist_id = ?', roundId, panelistId) as Row[],
  );
}

export async function dailySpend(db: DB): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = await db.get(
    'SELECT COALESCE(SUM(cost_credits), 0) AS c FROM model_call WHERE created_at >= ?', cutoff,
  ) as Row;
  return Number(row.c ?? 0);
}


/* ---- Self-consistency and pinned versions --------------------------------- */

export async function saveSelfConsistency(
  db: DB,
  a: { roundId: string; graderId: string; sampleSize: number; agreements: number; flagged: boolean },
): Promise<void> {
  await db.run(
    `INSERT INTO self_consistency (id, round_id, grader_id, sample_size, agreements, rate, flagged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id, grader_id) DO UPDATE SET
       sample_size = EXCLUDED.sample_size, agreements = EXCLUDED.agreements,
       rate = EXCLUDED.rate, flagged = EXCLUDED.flagged`,
    newId(), a.roundId, a.graderId, a.sampleSize, a.agreements,
    a.sampleSize === 0 ? 1 : a.agreements / a.sampleSize, a.flagged, now(),
  );
}

export async function listSelfConsistency(db: DB, roundId: string) {
  return (await db.all('SELECT * FROM self_consistency WHERE round_id = ?', roundId) as Row[]).map((r) => ({
    graderId: str(r.grader_id),
    sampleSize: Number(r.sample_size),
    agreements: Number(r.agreements),
    rate: Number(r.rate),
    flagged: Boolean(r.flagged),
  }));
}

export async function setSeatWeight(db: DB, graderId: string, weight: number): Promise<void> {
  await db.run('UPDATE graders SET weight = ? WHERE id = ?', weight, graderId);
}

export async function setRoundPinnedModels(db: DB, roundId: string, map: Record<string, string>): Promise<void> {
  await db.run('UPDATE rounds SET pinned_models = ? WHERE id = ?', JSON.stringify(map), roundId);
}

export async function getRoundPinnedModels(db: DB, roundId: string): Promise<Record<string, string>> {
  const row = await db.get('SELECT pinned_models FROM rounds WHERE id = ?', roundId) as Row | undefined;
  return row ? parseJson<Record<string, string>>(row.pinned_models, {}) : {};
}

export async function outputLengthsByGrader(db: DB, roundId: string) {
  return (await db.all(
    `SELECT g.grader_id, g.verdict, g.output_length FROM grades g
       JOIN round_items ri ON ri.id = g.item_id WHERE ri.round_id = ?`,
    roundId,
  ) as Row[]).map((r) => ({
    graderId: str(r.grader_id),
    verdict: str(r.verdict),
    outputLength: Number(r.output_length ?? 0),
  }));
}


export async function setRoundFalseSettleRate(db: DB, roundId: string, rate: number | null): Promise<void> {
  await db.run('UPDATE rounds SET false_settle_rate = ? WHERE id = ?', rate, roundId);
}


export async function recordExport(db: DB, roundId: string, artifactType: string, contentHash: string): Promise<void> {
  await db.run(
    'INSERT INTO exports (id, round_id, artifact_type, content_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    newId(), roundId, artifactType, contentHash, now(),
  );
}
