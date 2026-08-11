/**
 * HTTP API.
 *
 * The load-bearing rule in this file is blindness. While a round is open, no
 * endpoint returns another grader's verdict — not the queue, not the progress
 * readout, not the report. The report is gated on the round being closed, and
 * closing a round stops accepting grades, so there is no ordering in which a
 * grader can look first and grade second. Anchoring would make the agreement
 * number fiction, so it is enforced structurally rather than by convention.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DB } from './db.js';
import { newSlug, newToken } from './db.js';
import * as store from './store.js';
import { seedDemoProject } from './seed.js';
import { parseImport } from './import.js';
import { JudgeError, mapLimit, resolveProvider } from './judge.js';
import {
  ABSTAIN,
  DEFAULT_SCALE,
  agreementStats,
  attentionEstimate,
  buildJudgeSystemPrompt,
  buildSplitReport,
  clusterSplits,
  coverageStats,
  type ItemContext,
  type ItemVerdicts,
  planSample,
  renderRubricMarkdown,
  splitsOf,
  type Project,
} from '@shared/index.js';

interface ProjectRequest extends Request {
  project: Project;
}

export function createApp(db: DB) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const api = express.Router();

  /* ---- Project scoping -------------------------------------------------- */

  function requireProject(req: Request, res: Response, next: NextFunction) {
    const slug = req.params.slug!;
    const project = store.getProjectBySlug(db, slug);
    if (!project) return res.status(404).json({ error: 'No project with that link.' });

    const token = (req.header('x-gr-token') ?? req.query.k ?? '') as string;
    if (token !== project.token) {
      return res.status(403).json({ error: 'This link is missing its key, or the key is wrong.' });
    }
    (req as ProjectRequest).project = project;
    next();
  }

  /** Round routes are reached by round id, so the project is resolved from the round. */
  function requireRound(req: Request, res: Response, next: NextFunction) {
    const round = store.getRound(db, req.params.roundId!);
    if (!round) return res.status(404).json({ error: 'No such round.' });
    const project = store.getProjectBySlug(db, store.getProjectSlug(db, round.projectId) ?? '');
    if (!project) return res.status(404).json({ error: 'No such project.' });

    const token = (req.header('x-gr-token') ?? req.query.k ?? '') as string;
    if (token !== project.token) return res.status(403).json({ error: 'Wrong or missing key.' });

    (req as ProjectRequest).project = project;
    (req as Request & { round: typeof round }).round = round;
    next();
  }

  /* ---- Projects --------------------------------------------------------- */

  api.post('/projects', (req, res) => {
    const body = z.object({ name: z.string().min(1).max(120) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A project name is required.' });

    const project = store.createProject(db, {
      slug: newSlug(body.data.name),
      token: newToken(),
      name: body.data.name,
    });
    const rubric = store.createRubricVersion(db, {
      projectId: project.id,
      name: 'Untitled rubric',
      preamble: '',
      scale: DEFAULT_SCALE,
      criteria: [],
    });
    res.status(201).json({ project, rubric });
  });

  api.post('/projects/demo', (req, res) => {
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : undefined;
    const seeded = seedDemoProject(db, name);
    res.status(201).json(seeded);
  });

  api.get('/projects/:slug', requireProject, (req, res) => {
    const { project } = req as ProjectRequest;
    res.json({
      project,
      rubric: store.currentRubric(db, project.id),
      traceCount: store.listTraces(db, project.id).length,
      graders: store.listGraders(db, project.id),
      rounds: store.listRounds(db, project.id).map((round) => ({
        ...round,
        items: store.listItems(db, round.id).length,
        samplingNote: store.roundSamplingNote(db, round.id),
        // Each round pins its own rubric version, so this has to come from the
        // round rather than from whatever the current version happens to be.
        rubricVersion: store.getRubric(db, round.rubricVersionId)?.version ?? null,
      })),
    });
  });

  /* ---- Traces ----------------------------------------------------------- */

  api.get('/projects/:slug/traces', requireProject, (req, res) => {
    res.json({ traces: store.listTraces(db, (req as ProjectRequest).project.id) });
  });

  api.post('/projects/:slug/traces', requireProject, (req, res) => {
    const body = z
      .object({
        traces: z
          .array(
            z.object({
              title: z.string().default(''),
              content: z.string().min(1),
              source: z.string().optional(),
              meta: z.record(z.unknown()).optional(),
            }),
          )
          .min(1),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Each trace needs content.' });

    const traces = store.addTraces(db, (req as ProjectRequest).project.id, body.data.traces);
    res.status(201).json({ traces });
  });

  api.post('/projects/:slug/traces/import', requireProject, (req, res) => {
    const body = z
      .object({ format: z.enum(['jsonl', 'csv', 'paste']), body: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Give a format and a body to parse.' });

    const parsed = parseImport(body.data.format, body.data.body);
    if (parsed.traces.length === 0) {
      return res.status(422).json({
        error: 'Nothing in that input looked like a trace.',
        skipped: parsed.skipped,
      });
    }

    const traces = store.addTraces(
      db,
      (req as ProjectRequest).project.id,
      parsed.traces.map((t) => ({ ...t, source: body.data.format })),
    );
    res.status(201).json({ traces, skipped: parsed.skipped });
  });

  api.delete('/projects/:slug/traces/:traceId', requireProject, (req, res) => {
    const ok = store.deleteTrace(db, (req as ProjectRequest).project.id, req.params.traceId!);
    res.status(ok ? 204 : 404).end();
  });

  /* ---- Rubric ----------------------------------------------------------- */

  api.get('/projects/:slug/rubrics', requireProject, (req, res) => {
    res.json({ rubrics: store.listRubrics(db, (req as ProjectRequest).project.id) });
  });

  api.put('/projects/:slug/rubric', requireProject, (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(160),
        preamble: z.string().default(''),
        scale: z
          .array(z.object({ id: z.string().min(1), label: z.string().min(1), rank: z.number().int() }))
          .min(2)
          .optional(),
        criteria: z
          .array(z.object({ id: z.string().min(1), title: z.string().min(1), body: z.string().default('') }))
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A rubric needs a name and at least two verdict levels.' });

    const { project } = req as ProjectRequest;
    const current = store.currentRubric(db, project.id);
    if (!current) return res.status(404).json({ error: 'This project has no rubric yet.' });

    // A version a round has already pinned is immutable — otherwise a closed
    // round's numbers would silently start referring to a rubric nobody graded
    // against. Editing one forks a new version instead.
    if (store.rubricIsPinned(db, current.id)) {
      const forked = store.createRubricVersion(db, {
        projectId: project.id,
        name: body.data.name,
        preamble: body.data.preamble,
        scale: body.data.scale ?? current.scale,
        criteria: body.data.criteria ?? current.criteria,
        parentVersionId: current.id,
        clauses: current.clauses.map((c) => ({
          text: c.text,
          originItemId: c.originItemId,
          originRoundId: c.originRoundId,
        })),
      });
      return res.json({ rubric: forked, forked: true });
    }

    const updated = store.updateRubricInPlace(db, current.id, body.data);
    res.json({ rubric: updated, forked: false });
  });

  api.get('/rubrics/:rubricId/export', (req, res) => {
    const rubric = store.getRubric(db, req.params.rubricId!);
    if (!rubric) return res.status(404).json({ error: 'No such rubric version.' });
    const project = store.getProjectById(db, rubric.projectId);
    const token = (req.header('x-gr-token') ?? req.query.k ?? '') as string;
    if (!project || token !== project.token) return res.status(403).json({ error: 'Wrong or missing key.' });

    const format = String(req.query.format ?? 'md');
    if (format === 'json') {
      res.setHeader('content-type', 'application/json');
      return res.send(JSON.stringify(rubric, null, 2));
    }
    if (format === 'judge') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.send(buildJudgeSystemPrompt(rubric));
    }
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.send(renderRubricMarkdown(rubric, { includeProvenance: false }));
  });

  /* ---- Graders ---------------------------------------------------------- */

  api.post('/projects/:slug/graders', requireProject, (req, res) => {
    const body = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Enter a name so your grades can be told apart.' });
    res.status(201).json({ grader: store.upsertGrader(db, (req as ProjectRequest).project.id, body.data.name) });
  });

  /* ---- Rounds ----------------------------------------------------------- */

  api.post('/projects/:slug/rounds', requireProject, (req, res) => {
    const body = z
      .object({
        name: z.string().default(''),
        calibrationSize: z.number().int().min(1).max(200),
        heldoutSize: z.number().int().min(0).max(200).default(0),
        strategy: z.enum(['random', 'from_splits']).default('random'),
        sourceRoundId: z.string().nullable().default(null),
        reuseHeldout: z.boolean().default(true),
        seed: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A round needs a calibration size.' });

    const { project } = req as ProjectRequest;
    const rubric = store.currentRubric(db, project.id);
    if (!rubric) return res.status(400).json({ error: 'Write a rubric before running a round.' });

    const traces = store.listTraces(db, project.id);
    if (traces.length === 0) return res.status(400).json({ error: 'Add some traces before running a round.' });

    const wanted = body.data.calibrationSize + body.data.heldoutSize;
    if (traces.length < wanted) {
      return res.status(400).json({
        error: `This project has ${traces.length} traces but the round asks for ${wanted}.`,
      });
    }

    let priorSplitTraceIds: string[] = [];
    let reuseHeldoutTraceIds: string[] | undefined;

    if (body.data.strategy === 'from_splits') {
      const source = body.data.sourceRoundId ? store.getRound(db, body.data.sourceRoundId) : null;
      if (!source || source.projectId !== project.id) {
        return res.status(400).json({ error: 'Pick a previous round to draw splits from.' });
      }
      if (source.status !== 'closed') {
        return res.status(400).json({ error: 'The source round is still open, so its splits are not final.' });
      }
      const report = reportRows(db, source.id, rubric.scale);
      priorSplitTraceIds = splitsOf(report).map((r) => r.traceId);

      if (body.data.reuseHeldout) {
        reuseHeldoutTraceIds = store
          .listItems(db, source.id)
          .filter((item) => item.arm === 'heldout')
          .map((item) => item.traceId);
      }
    }

    const seed = body.data.seed ?? `${project.slug}:${Date.now()}`;
    const plan = planSample({
      pool: traces.map((t) => t.id),
      strategy: body.data.strategy,
      priorSplitTraceIds,
      calibrationSize: body.data.calibrationSize,
      heldoutSize: body.data.heldoutSize,
      reuseHeldoutTraceIds,
      seed,
    });

    const { round, items } = store.createRound(db, {
      projectId: project.id,
      rubricVersionId: rubric.id,
      name: body.data.name,
      strategy: body.data.strategy,
      seed,
      samplingNote: plan.explanation,
      sourceRoundId: body.data.sourceRoundId,
      calibration: plan.calibration,
      heldout: plan.heldout,
    });

    res.status(201).json({
      round,
      itemCount: items.length,
      samplingNote: plan.explanation,
      attention: attentionEstimate(items.length),
    });
  });

  api.get('/rounds/:roundId', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    const items = store.listItems(db, round.id);
    res.json({
      round,
      samplingNote: store.roundSamplingNote(db, round.id),
      itemCount: items.length,
      arms: {
        calibration: items.filter((i) => i.arm === 'calibration').length,
        heldout: items.filter((i) => i.arm === 'heldout').length,
      },
      attention: attentionEstimate(items.length),
      // Counts only. Who has finished is not a verdict, so this is safe while open.
      progress: store.roundProgress(db, round.id),
      rubric: store.getRubric(db, round.rubricVersionId),
    });
  });

  /**
   * The grading queue. Returns the grader's own grades and nothing else — no
   * other grader appears in this payload at all, so there is nothing to anchor
   * on even if the client is modified.
   */
  api.get('/rounds/:roundId/queue', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    const graderId = String(req.query.graderId ?? '');
    const grader = store.getGrader(db, graderId);
    if (!grader || grader.projectId !== round.projectId) {
      return res.status(400).json({ error: 'Join the round with a name first.' });
    }

    const mine = new Map(store.gradesForGrader(db, round.id, graderId).map((g) => [g.itemId, g]));
    const items = store.listItems(db, round.id).map((item) => {
      const trace = store.getTrace(db, item.traceId);
      const own = mine.get(item.id);
      return {
        itemId: item.id,
        position: item.position,
        // The arm is deliberately withheld: a grader who knows an item is held
        // out grades it differently, which is exactly what held out must not be.
        title: trace?.title ?? 'Missing trace',
        content: trace?.content ?? '',
        meta: trace?.meta ?? {},
        myVerdict: own?.verdict ?? null,
        myNote: own?.note ?? '',
      };
    });

    res.json({
      round: { id: round.id, name: round.name, status: round.status },
      rubric: store.getRubric(db, round.rubricVersionId),
      grader,
      items,
      done: items.filter((i) => i.myVerdict).length,
      attention: attentionEstimate(items.length),
    });
  });

  api.post('/rounds/:roundId/grades', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    if (round.status === 'closed') {
      return res.status(409).json({ error: 'This round is closed. Its report is visible, so it cannot take new grades.' });
    }

    const body = z
      .object({
        graderId: z.string().min(1),
        itemId: z.string().min(1),
        verdict: z.string().min(1),
        note: z.string().default(''),
        elapsedMs: z.number().int().min(0).default(0),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A grade needs a grader, an item, and a verdict.' });

    const grader = store.getGrader(db, body.data.graderId);
    if (!grader || grader.projectId !== round.projectId) {
      return res.status(403).json({ error: 'That grader does not belong to this project.' });
    }

    const item = store.getItem(db, body.data.itemId);
    if (!item || item.roundId !== round.id) return res.status(404).json({ error: 'That item is not in this round.' });

    const rubric = store.getRubric(db, round.rubricVersionId);
    const allowed = new Set([...(rubric?.scale ?? DEFAULT_SCALE).map((s) => s.id), ABSTAIN]);
    if (!allowed.has(body.data.verdict)) return res.status(400).json({ error: 'That verdict is not on this scale.' });

    const grade = store.submitGrade(db, body.data);
    const done = store.gradesForGrader(db, round.id, body.data.graderId).length;
    res.json({ grade, done, total: store.listItems(db, round.id).length });
  });

  api.post('/rounds/:roundId/close', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    const participants = store.participantsOf(db, round.id);
    if (participants.length < 2) {
      return res.status(400).json({
        error: 'A round needs at least two graders before it can be closed — agreement is not defined for one.',
      });
    }
    res.json({ round: store.closeRound(db, round.id) });
  });

  /** The report, and the only place another grader's verdict is ever returned. */
  api.get('/rounds/:roundId/report', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    if (round.status !== 'closed') {
      return res.status(409).json({
        error: 'This round is still open. Verdicts stay hidden until it closes — that is what makes the number mean anything.',
      });
    }

    const rubric = store.getRubric(db, round.rubricVersionId);
    const scale = rubric?.scale ?? DEFAULT_SCALE;
    const graders = store.participantsOf(db, round.id);
    const graderIds = graders.map((g) => g.id);
    const verdicts = store.verdictsForRound(db, round.id);
    const allRows = buildSplitReport(verdicts, itemContexts(db, round.id), scale);

    // A trace that is also sitting in a round somebody is still grading has its
    // verdicts withheld here. Otherwise reusing a held-out set — which is how
    // before-and-after is measured on the same cases — would hand the later
    // round's graders last round's answers.
    const embargoed = traceIdsInOpenRounds(db, round.projectId, round.id);
    const rows = allRows.map((row) =>
      embargoed.has(row.traceId) ? { ...row, byGrader: {}, embargoed: true } : row,
    );
    const embargoedItemIds = new Set(rows.filter((r) => r.embargoed).map((r) => r.itemId));

    // Aggregate statistics are computed from the unredacted verdicts, so a
    // closed round's numbers do not shift around depending on what happens to
    // be open right now. Only the per-item detail is withheld.

    const byArm = (arm: 'calibration' | 'heldout') => {
      const ids = new Set(rows.filter((r) => r.arm === arm).map((r) => r.itemId));
      const subset = verdicts.filter((v) => ids.has(v.itemId));
      return {
        agreement: agreementStats(subset, scale, graderIds),
        coverage: coverageStats(subset, graderIds, clauseCoveredItems(rubric, ids)),
      };
    };

    // Held-out splits are counted but never offered for resolution. Writing a
    // rubric clause about a trace you are measuring on is teaching to the test,
    // and it would make the primary metric improve for the wrong reason.
    const resolvable = rows.filter((r) => r.arm === 'calibration' && !r.embargoed);

    res.json({
      round,
      rubric,
      graders,
      samplingNote: store.roundSamplingNote(db, round.id),
      rows,
      clusters: clusterSplits(resolvable),
      splitCount: splitsOf(resolvable).length,
      heldoutSplitCount: splitsOf(rows.filter((r) => r.arm === 'heldout')).length,
      embargoedCount: rows.filter((r) => r.embargoed).length,
      overall: {
        agreement: agreementStats(verdicts, scale, graderIds),
        coverage: coverageStats(verdicts, graderIds, clauseCoveredItems(rubric, new Set(rows.map((r) => r.itemId)))),
      },
      calibration: byArm('calibration'),
      heldout: byArm('heldout'),
      resolutions: store.resolutionsForRound(db, round.id),
      notes: store
        .allGradesForRound(db, round.id)
        .filter((g) => g.note.trim() && !embargoedItemIds.has(g.itemId)),
    });
  });

  /* ---- Resolutions and shipping ----------------------------------------- */

  api.post('/rounds/:roundId/items/:itemId/resolve', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    if (round.status !== 'closed') {
      return res.status(409).json({ error: 'Resolve splits after the round closes, not during it.' });
    }

    const body = z
      .object({
        agreedVerdict: z.string().min(1),
        clauseText: z.string().min(3).max(600),
        rationale: z.string().default(''),
        resolvedBy: z.string().default(''),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: 'A resolution needs an agreed verdict and the sentence the rubric was missing.',
      });
    }

    const item = store.getItem(db, req.params.itemId!);
    if (!item || item.roundId !== round.id) return res.status(404).json({ error: 'That item is not in this round.' });

    // Held-out traces are graded but never discussed. A clause written about
    // one would be a rubric edit aimed at the measurement set, and the
    // before-and-after number would improve because of the teaching, not the
    // calibration.
    if (item.arm === 'heldout') {
      return res.status(400).json({
        error:
          'This trace is in the held-out arm. Held-out cases are what the primary metric is measured on, so resolving one would be writing the rubric against your own test set.',
      });
    }

    res.json({ resolution: store.saveResolution(db, { itemId: item.id, ...body.data }) });
  });

  api.delete('/rounds/:roundId/items/:itemId/resolve', requireRound, (req, res) => {
    const ok = store.deleteResolution(db, req.params.itemId!);
    res.status(ok ? 204 : 404).end();
  });

  /** Turn this round's resolutions into the next rubric version. */
  api.post('/rounds/:roundId/ship', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    const { project } = req as ProjectRequest;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Close the round first.' });

    const base = store.getRubric(db, round.rubricVersionId);
    if (!base) return res.status(404).json({ error: 'The round has no rubric to build on.' });

    const resolutions = store.resolutionsForRound(db, round.id);
    if (resolutions.length === 0) {
      return res.status(400).json({ error: 'Resolve at least one split before shipping a revision.' });
    }

    const existing = new Set(base.clauses.map((c) => c.text.trim().toLowerCase()));
    const additions = resolutions
      .filter((r) => !existing.has(r.clauseText.trim().toLowerCase()))
      .map((r) => ({ text: r.clauseText, originItemId: r.itemId, originRoundId: round.id }));

    const shipped = store.createRubricVersion(db, {
      projectId: project.id,
      name: base.name,
      preamble: base.preamble,
      scale: base.scale,
      criteria: base.criteria,
      parentVersionId: base.id,
      clauses: [
        ...base.clauses.map((c) => ({
          text: c.text,
          originItemId: c.originItemId,
          originRoundId: c.originRoundId,
        })),
        ...additions,
      ],
    });

    res.status(201).json({ rubric: shipped, added: additions.length, from: base.version });
  });

  /* ---- Judge ------------------------------------------------------------ */

  api.get('/judge/provider', (_req, res) => {
    const provider = resolveProvider();
    res.json({ provider: provider.id, model: provider.model, real: provider.real });
  });

  api.post('/rounds/:roundId/judge', requireRound, async (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    const { project } = req as ProjectRequest;
    if (round.status !== 'closed') {
      return res.status(409).json({ error: 'Run the judge against a closed round, so there are human verdicts to compare with.' });
    }

    const body = z
      .object({
        rubricVersionId: z.string().min(1),
        arm: z.enum(['calibration', 'heldout']).default('heldout'),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Pick a rubric version to build the judge from.' });

    const rubric = store.getRubric(db, body.data.rubricVersionId);
    if (!rubric || rubric.projectId !== project.id) return res.status(404).json({ error: 'No such rubric version.' });

    const items = store.listItems(db, round.id).filter((i) => i.arm === body.data.arm);
    if (items.length === 0) return res.status(400).json({ error: `This round has no ${body.data.arm} items.` });

    const provider = resolveProvider();
    const runId = store.createJudgeRun(db, {
      projectId: project.id,
      roundId: round.id,
      rubricVersionId: rubric.id,
      provider: provider.id,
      model: provider.model,
      arm: body.data.arm,
    });

    try {
      const results = await mapLimit(items, 4, async (item) => {
        const trace = store.getTrace(db, item.traceId);
        if (!trace) return { itemId: item.id, verdict: ABSTAIN, rationale: 'Trace missing.' };
        const graded = await provider.grade(rubric, trace);
        return { itemId: item.id, ...graded };
      });
      for (const r of results) store.saveJudgeVerdict(db, runId, r.itemId, r.verdict, r.rationale);
    } catch (error) {
      if (error instanceof JudgeError) return res.status(502).json({ error: error.message, code: error.code });
      throw error;
    }

    res.status(201).json({ runId, provider: provider.id, model: provider.model, real: provider.real });
  });

  api.get('/rounds/:roundId/judge', requireRound, (req, res) => {
    const round = (req as Request & { round: ReturnType<typeof store.getRound> }).round!;
    const rubricScale = store.getRubric(db, round.rubricVersionId)?.scale ?? DEFAULT_SCALE;
    const verdicts = store.verdictsForRound(db, round.id);
    const byItem = new Map(verdicts.map((v) => [v.itemId, v.byGrader]));
    const items = store.listItems(db, round.id);
    const armOf = new Map(items.map((i) => [i.id, i.arm]));

    const runs = store.listJudgeRuns(db, round.id).map((run) => {
      const judged = store.judgeVerdicts(db, run.id);
      const scoped = judged.filter((j) => armOf.get(j.itemId) === run.arm);

      // The judge is treated as one more rater on the same units, so its
      // agreement with humans is computed the same way theirs is with each
      // other. Anything else would not be comparable.
      const units: ItemVerdicts[] = scoped.map((j) => ({
        itemId: j.itemId,
        byGrader: { ...(byItem.get(j.itemId) ?? {}), __judge: j.verdict },
      }));
      const humanIds = [...new Set(units.flatMap((u) => Object.keys(u.byGrader).filter((k) => k !== '__judge')))];
      const stats = agreementStats(units, rubricScale, [...humanIds, '__judge']);

      const versusHuman = Object.entries(stats.pairwise)
        .filter(([key]) => key.includes('__judge'))
        .map(([key, value]) => ({ graderId: key.replace('|__judge', '').replace('__judge|', ''), ...value }));

      const compared = versusHuman.reduce((sum, p) => sum + p.compared, 0);
      const agreed = versusHuman.reduce((sum, p) => sum + p.agreed, 0);

      return {
        ...run,
        rubricVersion: store.getRubric(db, run.rubricVersionId)?.version ?? null,
        itemCount: scoped.length,
        judgeAbstentions: scoped.filter((j) => j.verdict === ABSTAIN).length,
        agreementWithHumans: compared === 0 ? null : agreed / compared,
        comparisons: compared,
        perGrader: versusHuman,
        verdicts: scoped,
      };
    });

    res.json({ runs, real: resolveProvider().real });
  });

  app.use('/api', api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(500).json({ error: message });
  });

  return app;
}

/* ---- Helpers ------------------------------------------------------------ */

function itemContexts(db: DB, roundId: string): Map<string, ItemContext> {
  const resolved = new Set(store.resolutionsForRound(db, roundId).map((r) => r.itemId));
  const map = new Map<string, ItemContext>();
  for (const item of store.listItems(db, roundId)) {
    const trace = store.getTrace(db, item.traceId);
    map.set(item.id, {
      itemId: item.id,
      traceId: item.traceId,
      title: trace?.title ?? 'Missing trace',
      arm: item.arm,
      resolved: resolved.has(item.id),
    });
  }
  return map;
}

/**
 * Traces currently sitting in a round somebody is still grading. Their verdicts
 * are withheld from every other round's report until that round closes.
 */
function traceIdsInOpenRounds(db: DB, projectId: string, exceptRoundId: string): Set<string> {
  const ids = new Set<string>();
  for (const round of store.listRounds(db, projectId)) {
    if (round.status !== 'open' || round.id === exceptRoundId) continue;
    for (const item of store.listItems(db, round.id)) ids.add(item.traceId);
  }
  return ids;
}

function reportRows(db: DB, roundId: string, scale: { id: string; label: string; rank: number }[]) {
  return buildSplitReport(store.verdictsForRound(db, roundId), itemContexts(db, roundId), scale);
}

/**
 * Which items the rubric's clauses claim to cover. A clause knows the item it
 * came from, so coverage here means "this case has been argued about and the
 * rubric now says something about it" — not a semantic match.
 */
function clauseCoveredItems(
  rubric: { clauses: { originItemId: string | null }[] } | null,
  itemIds: Set<string>,
): Set<string> {
  const covered = new Set<string>();
  for (const clause of rubric?.clauses ?? []) {
    if (clause.originItemId && itemIds.has(clause.originItemId)) covered.add(clause.originItemId);
  }
  return covered;
}
