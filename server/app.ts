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
import { newId, newSlug, newToken } from './db.js';
import * as store from './store.js';
import { seedDemoProject } from './seed.js';
import { parseImport } from './import.js';
import { JudgeError, mapLimit, resolveProvider } from './judge.js';
import { DrafterError, resolveDrafter } from './drafter.js';
import { resolveScenarist } from './scenarist.js';
import {
  ABSTAIN,
  DEFAULT_SCALE,
  agreementStats,
  attentionEstimate,
  buildJudgeSystemPrompt,
  buildEvalSet,
  buildSplitReport,
  clusterSplits,
  evalSetToJsonl,
  coverageStats,
  type ItemContext,
  type ItemVerdicts,
  type DocumentKind,
  planSample,
  prepareDocuments,
  prepareExamples,
  renderRubricMarkdown,
  splitsOf,
  type Project,
} from '../shared/index.js';

interface ProjectRequest extends Request {
  project: Project;
}

/**
 * Items a single judge run will grade.
 *
 * Derived, not picked. Items run four at a time, so N items is ceil(N/4) waves;
 * a judge call with thinking on takes roughly 5-12s. Sixteen is four waves, so
 * about 48s at the pessimistic end — inside a 60s function with room to spare.
 * Forty would have been ten waves and up to two minutes, which is a timeout
 * dressed as a limit.
 *
 * Nothing real wants more than this anyway. A round is bounded by the
 * thirty-minute attention budget at ~24 traces, and a judge run scores one arm
 * of one round. The statistics want *enough*, not many: five comparable items
 * before alpha is reported at all, eight before an interval is. Sixteen clears
 * both with headroom.
 *
 * A queue lifts the ceiling. Until then the API refuses above it rather than
 * starting a run it cannot finish.
 */
export const MAX_JUDGE_BATCH = 16;

export function createApp(db: DB) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const api = express.Router();

  /** Liveness plus a real read, so a wedged database fails the check. */
  api.get('/health', async (_req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      res.json({ ok: true, judge: resolveProvider().id });
    } catch (error) {
      res.status(503).json({ ok: false, error: error instanceof Error ? error.message : 'database unavailable' });
    }
  });

  /* ---- Project scoping -------------------------------------------------- */

  async function requireProject(req: Request, res: Response, next: NextFunction) {
    const slug = req.params.slug!;
    const project = await store.getProjectBySlug(db, slug);
    if (!project) return res.status(404).json({ error: 'No project with that link.' });

    const token = (req.header('x-gr-token') ?? req.query.k ?? '') as string;
    if (token !== project.token) {
      return res.status(403).json({ error: 'This link is missing its key, or the key is wrong.' });
    }
    (req as ProjectRequest).project = project;
    next();
  }

  /** Round routes are reached by round id, so the project is resolved from the round. */
  async function requireRound(req: Request, res: Response, next: NextFunction) {
    const round = await store.getRound(db, req.params.roundId!);
    if (!round) return res.status(404).json({ error: 'No such poll.' });
    const project = await store.getProjectBySlug(db, await store.getProjectSlug(db, round.projectId) ?? '');
    if (!project) return res.status(404).json({ error: 'No such project.' });

    const token = (req.header('x-gr-token') ?? req.query.k ?? '') as string;
    if (token !== project.token) return res.status(403).json({ error: 'Wrong or missing key.' });

    (req as ProjectRequest).project = project;
    (req as Request & { round: typeof round }).round = round;
    next();
  }

  /* ---- Projects --------------------------------------------------------- */

  /**
   * The arrival moment. A company explains what it is and what its AI does, and
   * leaves this call holding a poll's worth of scenarios — the description is
   * enough to write them, so nothing asks for transcripts a new team does not
   * have. Scenario writing is best-effort on purpose: if the model is down, the
   * company still gets its project and writes scenarios from the tab instead of
   * losing the sign-up to a provider error.
   */
  api.post('/projects', async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).default(''),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A project name is required.' });

    const project = await store.createProject(db, {
      slug: newSlug(body.data.name),
      token: newToken(),
      name: body.data.name,
      description: body.data.description.trim(),
    });
    const rubric = await store.createRubricVersion(db, {
      projectId: project.id,
      name: 'Your standards',
      preamble: body.data.description.trim(),
      scale: DEFAULT_SCALE,
      criteria: [],
    });

    let scenarioCount = 0;
    let scenariosReal = false;
    if (project.description.length >= 10) {
      try {
        const scenarist = resolveScenarist();
        const scenarios = await scenarist.write({ description: project.description });
        await store.addTraces(
          db,
          project.id,
          scenarios.map((s) => ({
            title: s.title,
            content: s.content,
            source: 'scenario',
            meta: { probe: s.probe, generated: true, real: scenarist.real },
          })),
        );
        scenarioCount = scenarios.length;
        scenariosReal = scenarist.real;
      } catch {
        // The project stands; scenarios can be written from the Scenarios tab.
      }
    }

    res.status(201).json({ project, rubric, scenarioCount, scenariosReal });
  });

  api.post('/projects/demo', async (req, res) => {
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : undefined;
    const seeded = await seedDemoProject(db, name);
    res.status(201).json(seeded);
  });

  api.get('/projects/:slug', requireProject, async (req, res) => {
    const { project } = req as ProjectRequest;
    res.json({
      project,
      rubric: await store.currentRubric(db, project.id),
      traceCount: (await store.listTraces(db, project.id)).length,
      documentCount: (await store.listDocuments(db, project.id)).length,
      graders: await store.listGraders(db, project.id),
      rounds: await Promise.all(
        (await store.listRounds(db, project.id)).map(async (round) => ({
          ...round,
          items: (await store.listItems(db, round.id)).length,
          samplingNote: await store.roundSamplingNote(db, round.id),
          // Each round pins its own rubric version, so this has to come from the
          // round rather than from whatever the current version happens to be.
          rubricVersion: (await store.getRubric(db, round.rubricVersionId))?.version ?? null,
        })),
      ),
    });
  });

  /**
   * Round-over-round trajectory — the view that answers the question the whole
   * product exists to answer, and the one that makes a second round worth
   * running.
   *
   * The care here is in refusing to draw a line between two points that are not
   * comparable. Held-out agreement only means "the rubric got better" if the
   * later round graded the same held-out traces with the same panel. Change
   * either and the delta is measuring something else, so it is reported as
   * incomparable rather than plotted.
   */
  api.get('/projects/:slug/trajectory', requireProject, async (req, res) => {
    const { project } = req as ProjectRequest;
    const closed = (await store.listRounds(db, project.id)).filter((r) => r.status === 'closed');

    const points = await Promise.all(
      closed.map(async (round) => {
      const rubric = await store.getRubric(db, round.rubricVersionId);
      const scale = rubric?.scale ?? DEFAULT_SCALE;
      const graders = await store.participantsOf(db, round.id);
      const graderIds = graders.map((g) => g.id);
      const verdicts = await store.verdictsForRound(db, round.id);
      const items = await store.listItems(db, round.id);

      const idsFor = (arm: 'calibration' | 'heldout') =>
        new Set(items.filter((i) => i.arm === arm).map((i) => i.id));
      const armStats = (arm: 'calibration' | 'heldout') => {
        const ids = idsFor(arm);
        const subset = verdicts.filter((v) => ids.has(v.itemId));
        return {
          agreement: agreementStats(subset, scale, graderIds),
          coverage: coverageStats(subset, graderIds),
        };
      };

      const rows = buildSplitReport(verdicts, await itemContexts(db, round.id), scale);
      const resolutions = await store.resolutionsForRound(db, round.id);

      return {
        roundId: round.id,
        index: round.index,
        name: round.name,
        closedAt: round.closedAt,
        strategy: round.strategy,
        rubricVersion: rubric?.version ?? null,
        clauseCount: rubric?.clauses.length ?? 0,
        graderIds,
        graderNames: graders.map((g) => g.name),
        heldout: armStats('heldout'),
        calibration: armStats('calibration'),
        splitCount: splitsOf(rows.filter((r) => r.arm === 'calibration')).length,
        resolvedCount: resolutions.length,
        /** Identity of the held-out set. Two rounds only compare if these match. */
        heldoutSignature: items
          .filter((i) => i.arm === 'heldout')
          .map((i) => i.traceId)
          .sort()
          .join('|'),
        };
      }),
    );

    const series = points.map((point, i) => {
      const previous = i > 0 ? points[i - 1]! : null;
      const reasons: string[] = [];

      if (previous) {
        if (!point.heldoutSignature || !previous.heldoutSignature) {
          reasons.push('One of the two rounds reserved no held-out traces.');
        } else if (point.heldoutSignature !== previous.heldoutSignature) {
          reasons.push(
            'The held-out traces are not the same ones, so this is a different measurement rather than a before and after.',
          );
        }
        const gained = point.graderNames.filter((n) => !previous.graderNames.includes(n));
        const lost = previous.graderNames.filter((n) => !point.graderNames.includes(n));
        if (gained.length || lost.length) {
          reasons.push(
            `The panel changed${gained.length ? `: ${gained.join(', ')} joined` : ''}${
              lost.length ? `${gained.length ? ' and' : ':'} ${lost.join(', ')} did not grade` : ''
            }. Some of any movement is the people, not the rubric.`,
          );
        }
        if (point.heldout.agreement.units === 0 || previous.heldout.agreement.units === 0) {
          reasons.push('One of the two rounds has no comparable held-out items.');
        }
      }

      const comparable = previous !== null && reasons.length === 0;
      return {
        ...point,
        comparableToPrevious: comparable,
        comparabilityNotes: reasons,
        heldoutDelta:
          comparable && previous ? point.heldout.agreement.observed - previous.heldout.agreement.observed : null,
      };
    });

    res.json({ series, roundsClosed: closed.length });
  });

  /* ---- Traces ----------------------------------------------------------- */

  api.get('/projects/:slug/traces', requireProject, async (req, res) => {
    res.json({ traces: await store.listTraces(db, (req as ProjectRequest).project.id) });
  });

  api.post('/projects/:slug/traces', requireProject, async (req, res) => {
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
    if (!body.success) return res.status(400).json({ error: 'Each scenario needs content.' });

    const traces = await store.addTraces(db, (req as ProjectRequest).project.id, body.data.traces);
    res.status(201).json({ traces });
  });

  /**
   * The system writes the poll's questions. Saved immediately — a scenario is
   * a question, not a standard, so the accept-before-save ceremony the rubric
   * gets would be friction with nothing to protect.
   */
  api.post('/projects/:slug/scenarios', requireProject, async (req, res) => {
    const body = z
      .object({
        description: z.string().min(10).max(2000),
        count: z.number().int().min(1).max(32).optional(),
        documentIds: z.array(z.string().min(1)).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'Describe what your AI is supposed to do, in a sentence or two.' });
    }

    const { project } = req as ProjectRequest;
    const allDocs = await store.listDocuments(db, project.id);
    const chosen = body.data.documentIds
      ? allDocs.filter((d) => body.data.documentIds!.includes(d.id))
      : allDocs;
    if (body.data.documentIds && chosen.length !== body.data.documentIds.length) {
      return res.status(404).json({ error: 'One of those documents is not in this project.' });
    }

    const scenarist = resolveScenarist();
    try {
      const prepared = prepareDocuments(chosen.map((d) => ({ title: d.title, kind: d.kind, content: d.content })));
      const scenarios = await scenarist.write({
        description: body.data.description,
        documents: prepared.documents,
        count: body.data.count,
      });
      if (scenarios.length === 0) {
        return res.status(502).json({ error: 'No usable scenarios came back. Try a more specific description.' });
      }
      const saved = await store.addTraces(
        db,
        project.id,
        scenarios.map((s) => ({
          title: s.title,
          content: s.content,
          source: 'scenario',
          // The probe never reaches a voter: the grading queue omits meta by
          // showing it collapsed, but scenarios carry it for the owner's view.
          meta: { probe: s.probe, generated: true, real: scenarist.real },
        })),
      );
      res.status(201).json({
        scenarios: saved.map((t, i) => ({ id: t.id, title: t.title, content: t.content, probe: scenarios[i]!.probe })),
        provider: { id: scenarist.id, model: scenarist.model, real: scenarist.real },
      });
    } catch (error) {
      if (error instanceof DrafterError) {
        return res.status(error.code === 'auth' ? 401 : 502).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  /* ---- Operating documents ---------------------------------------------- */

  api.get('/projects/:slug/documents', requireProject, async (req, res) => {
    const { project } = req as ProjectRequest;
    res.json({ documents: await store.listDocuments(db, project.id) });
  });

  api.post('/projects/:slug/documents', requireProject, async (req, res) => {
    const body = z
      .object({
        documents: z
          .array(
            z.object({
              title: z.string().default(''),
              kind: z.enum(['policy', 'sop', 'decision', 'other']).default('policy'),
              content: z.string().min(1),
            }),
          )
          .min(1),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A document needs some text in it.' });

    const { project } = req as ProjectRequest;
    const documents = await store.addDocuments(db, project.id, body.data.documents);
    res.status(201).json({ documents });
  });

  api.delete('/projects/:slug/documents/:documentId', requireProject, async (req, res) => {
    const { project } = req as ProjectRequest;
    const removed = await store.deleteDocument(db, project.id, req.params.documentId!);
    if (!removed) return res.status(404).json({ error: 'No such document.' });
    res.status(204).end();
  });

  api.post('/projects/:slug/traces/import', requireProject, async (req, res) => {
    const body = z
      .object({ format: z.enum(['jsonl', 'csv', 'paste']), body: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Give a format and a body to parse.' });

    const parsed = parseImport(body.data.format, body.data.body);
    if (parsed.traces.length === 0) {
      return res.status(422).json({
        error: 'Nothing in that input looked like a conversation.',
        skipped: parsed.skipped,
      });
    }

    const traces = await store.addTraces(
      db,
      (req as ProjectRequest).project.id,
      parsed.traces.map((t) => ({ ...t, source: body.data.format })),
    );
    res.status(201).json({ traces, skipped: parsed.skipped });
  });

  api.delete('/projects/:slug/traces/:traceId', requireProject, async (req, res) => {
    const ok = await store.deleteTrace(db, (req as ProjectRequest).project.id, req.params.traceId!);
    res.status(ok ? 204 : 404).end();
  });

  /* ---- Rubric ----------------------------------------------------------- */

  api.get('/projects/:slug/rubrics', requireProject, async (req, res) => {
    res.json({ rubrics: await store.listRubrics(db, (req as ProjectRequest).project.id) });
  });

  /**
   * Draft a first rubric from transcripts. Deliberately does not write anything:
   * a rubric nobody read is not a rubric, so accepting the draft is a separate,
   * human act (the PUT below).
   */
  api.post('/projects/:slug/rubric/draft', requireProject, async (req, res) => {
    const body = z
      .object({
        description: z.string().min(10).max(2000),
        documentIds: z.array(z.string().min(1)).optional(),
        traceIds: z.array(z.string().min(1)).optional(),
        examples: z.array(z.object({ title: z.string().default(''), content: z.string().min(1) })).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'Describe what the agent is meant to do, in a sentence or two.' });
    }

    const { project } = req as ProjectRequest;
    const chosen: { title: string; content: string }[] = [];
    const usedTraceIds: string[] = [];
    const chosenDocs: { title: string; kind: DocumentKind; content: string }[] = [];
    const usedDocumentIds: string[] = [];

    for (const documentId of body.data.documentIds ?? []) {
      const doc = await store.getDocument(db, documentId);
      if (!doc || doc.projectId !== project.id) {
        return res.status(404).json({ error: 'One of those documents is not in this project.' });
      }
      chosenDocs.push({ title: doc.title, kind: doc.kind, content: doc.content });
      usedDocumentIds.push(doc.id);
    }

    for (const traceId of body.data.traceIds ?? []) {
      const trace = await store.getTrace(db, traceId);
      // Scoped by hand: getTrace is keyed on the trace id alone, so without this
      // a valid link to one project could draft from another project's traces.
      if (!trace || trace.projectId !== project.id) {
        return res.status(404).json({ error: 'One of those conversations is not in this project.' });
      }
      chosen.push({ title: trace.title, content: trace.content });
      usedTraceIds.push(trace.id);
    }
    for (const example of body.data.examples ?? []) {
      chosen.push({ title: example.title || 'Pasted conversation', content: example.content });
    }

    if (chosen.length === 0 && chosenDocs.length === 0) {
      return res
        .status(400)
        .json({ error: 'Pick at least one operating document or conversation to draft from.' });
    }

    const prepared = prepareExamples(chosen);
    const preparedDocs = prepareDocuments(chosenDocs);
    const drafter = resolveDrafter();

    try {
      const draft = await drafter.draft({
        description: body.data.description,
        documents: preparedDocs.documents,
        examples: prepared.examples,
      });
      res.json({
        draft,
        provider: { id: drafter.id, model: drafter.model, real: drafter.real },
        draftedFrom: {
          provider: drafter.id,
          model: drafter.model,
          describedAs: body.data.description.trim(),
          documentCount: preparedDocs.documents.length,
          exampleCount: prepared.examples.length,
          truncated: prepared.truncated || preparedDocs.truncated,
          createdAt: new Date().toISOString(),
        },
        usedDocumentIds,
        usedTraceIds,
      });
    } catch (error) {
      if (error instanceof DrafterError) {
        return res.status(error.code === 'auth' ? 401 : 502).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  api.put('/projects/:slug/rubric', requireProject, async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(160),
        preamble: z.string().default(''),
        scale: z
          .array(z.object({ id: z.string().min(1), label: z.string().min(1), rank: z.number().int() }))
          .min(2)
          .optional(),
        criteria: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string().min(1),
              body: z.string().default(''),
              // Without this the citation is silently stripped, and a criterion
              // drafted from a policy loses the sentence that justifies it.
              source: z
                .object({ document: z.string().min(1), quote: z.string().min(1) })
                .nullable()
                .optional(),
            }),
          )
          .optional(),
        openQuestions: z
          .array(z.object({ id: z.string().min(1), question: z.string().min(1), why: z.string().default('') }))
          .optional(),
        conflicts: z
          .array(
            z.object({
              id: z.string().min(1),
              kind: z.enum(['contradiction', 'untestable']),
              statement: z.string().min(1),
              detail: z.string().default(''),
              documents: z.array(z.string()).default([]),
            }),
          )
          .optional(),
        draftedFrom: z
          .object({
            provider: z.string(),
            model: z.string(),
            describedAs: z.string(),
            documentCount: z.number().int().nonnegative().default(0),
            exampleCount: z.number().int().nonnegative(),
            truncated: z.boolean(),
            createdAt: z.string(),
          })
          .nullable()
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Your standards need a name and at least two verdict levels.' });

    const { project } = req as ProjectRequest;
    const current = await store.currentRubric(db, project.id);
    if (!current) return res.status(404).json({ error: 'This project has no standards yet.' });

    // A version a round has already pinned is immutable — otherwise a closed
    // round's numbers would silently start referring to a rubric nobody graded
    // against. Editing one forks a new version instead.
    if (await store.rubricIsPinned(db, current.id)) {
      const forked = await store.createRubricVersion(db, {
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
        openQuestions: body.data.openQuestions ?? current.openQuestions,
        conflicts: body.data.conflicts ?? current.conflicts,
        draftedFrom: body.data.draftedFrom === undefined ? current.draftedFrom : body.data.draftedFrom,
      });
      return res.json({ rubric: forked, forked: true });
    }

    const updated = await store.updateRubricInPlace(db, current.id, body.data);
    res.json({ rubric: updated, forked: false });
  });

  api.get('/rubrics/:rubricId/export', async (req, res) => {
    const rubric = await store.getRubric(db, req.params.rubricId!);
    if (!rubric) return res.status(404).json({ error: 'No such version of the standards.' });
    const project = await store.getProjectById(db, rubric.projectId);
    const token = (req.header('x-gr-token') ?? req.query.k ?? '') as string;
    if (!project || token !== project.token) return res.status(403).json({ error: 'Wrong or missing key.' });

    // Open questions travel with the human-readable exports but never with the
    // judge prompt — see the note on buildJudgeSystemPrompt.
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
    res.send(renderRubricMarkdown(rubric, { includeProvenance: false, includeOpenQuestions: true, includeConflicts: true }));
  });

  /* ---- Graders ---------------------------------------------------------- */

  api.post('/projects/:slug/graders', requireProject, async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Enter a name so your votes can be told apart.' });
    res.status(201).json({ grader: await store.upsertGrader(db, (req as ProjectRequest).project.id, body.data.name) });
  });

  /* ---- Rounds ----------------------------------------------------------- */

  api.post('/projects/:slug/rounds', requireProject, async (req, res) => {
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
    if (!body.success) return res.status(400).json({ error: 'A poll needs at least one scenario to discuss.' });

    const { project } = req as ProjectRequest;
    const rubric = await store.currentRubric(db, project.id);
    if (!rubric) return res.status(400).json({ error: 'Set up your standards before opening a poll.' });

    const traces = await store.listTraces(db, project.id);
    if (traces.length === 0) return res.status(400).json({ error: 'Add or write some scenarios before opening a poll.' });

    const wanted = body.data.calibrationSize + body.data.heldoutSize;
    if (traces.length < wanted) {
      return res.status(400).json({
        error: `This project has ${traces.length} traces but the round asks for ${wanted}.`,
      });
    }

    let priorSplitTraceIds: string[] = [];
    let reuseHeldoutTraceIds: string[] | undefined;

    if (body.data.strategy === 'from_splits') {
      const source = body.data.sourceRoundId ? await store.getRound(db, body.data.sourceRoundId) : null;
      if (!source || source.projectId !== project.id) {
        return res.status(400).json({ error: 'Pick a previous poll to draw disagreements from.' });
      }
      if (source.status !== 'closed') {
        return res.status(400).json({ error: 'That poll is still open, so its disagreements are not final.' });
      }
      const report = await reportRows(db, source.id, rubric.scale);
      priorSplitTraceIds = splitsOf(report).map((r) => r.traceId);

      if (body.data.reuseHeldout) {
        reuseHeldoutTraceIds = (await store.listItems(db, source.id))
          .filter((item) => item.arm === 'heldout')
          .map((item) => item.traceId);
      }
    }

    // Random component, not just a timestamp: two rounds created in the same
    // millisecond would otherwise draw the identical sample. The seed is stored
    // on the round, so the draw stays reproducible and auditable afterwards.
    const seed = body.data.seed ?? `${project.slug}:${Date.now()}:${newId()}`;
    const plan = planSample({
      pool: traces.map((t) => t.id),
      strategy: body.data.strategy,
      priorSplitTraceIds,
      calibrationSize: body.data.calibrationSize,
      heldoutSize: body.data.heldoutSize,
      reuseHeldoutTraceIds,
      seed,
    });

    const { round, items } = await store.createRound(db, {
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

  api.get('/rounds/:roundId', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const items = await store.listItems(db, round.id);
    res.json({
      round,
      samplingNote: await store.roundSamplingNote(db, round.id),
      itemCount: items.length,
      arms: {
        calibration: items.filter((i) => i.arm === 'calibration').length,
        heldout: items.filter((i) => i.arm === 'heldout').length,
      },
      attention: attentionEstimate(items.length),
      // Counts only. Who has finished is not a verdict, so this is safe while open.
      progress: await store.roundProgress(db, round.id),
      rubric: await store.getRubric(db, round.rubricVersionId),
    });
  });

  /**
   * The grading queue. Returns the grader's own grades and nothing else — no
   * other grader appears in this payload at all, so there is nothing to anchor
   * on even if the client is modified.
   */
  api.get('/rounds/:roundId/queue', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const graderId = String(req.query.graderId ?? '');
    const grader = await store.getGrader(db, graderId);
    if (!grader || grader.projectId !== round.projectId) {
      return res.status(400).json({ error: 'Join with your name first, so your votes can be counted.' });
    }

    const mine = new Map((await store.gradesForGrader(db, round.id, graderId)).map((g) => [g.itemId, g]));
    const items = await Promise.all(
      (await store.listItems(db, round.id)).map(async (item) => {
      const trace = await store.getTrace(db, item.traceId);
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
      }),
    );

    res.json({
      round: { id: round.id, name: round.name, status: round.status },
      rubric: await store.getRubric(db, round.rubricVersionId),
      grader,
      items,
      done: items.filter((i) => i.myVerdict).length,
      attention: attentionEstimate(items.length),
    });
  });

  api.post('/rounds/:roundId/grades', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status === 'closed') {
      return res.status(409).json({ error: 'This poll has closed. Its results are visible, so it cannot take new votes.' });
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

    const grader = await store.getGrader(db, body.data.graderId);
    if (!grader || grader.projectId !== round.projectId) {
      return res.status(403).json({ error: 'That grader does not belong to this project.' });
    }

    const item = await store.getItem(db, body.data.itemId);
    if (!item || item.roundId !== round.id) return res.status(404).json({ error: 'That item is not in this round.' });

    const rubric = await store.getRubric(db, round.rubricVersionId);
    const allowed = new Set([...(rubric?.scale ?? DEFAULT_SCALE).map((s) => s.id), ABSTAIN]);
    if (!allowed.has(body.data.verdict)) return res.status(400).json({ error: 'That verdict is not on this scale.' });

    const grade = await store.submitGrade(db, body.data);
    const done = (await store.gradesForGrader(db, round.id, body.data.graderId)).length;
    res.json({ grade, done, total: (await store.listItems(db, round.id)).length });
  });

  api.post('/rounds/:roundId/close', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const participants = await store.participantsOf(db, round.id);
    if (participants.length < 2) {
      return res.status(400).json({
        error: 'A poll needs votes from at least two people before it can close. Agreement is not defined for one.',
      });
    }
    res.json({ round: await store.closeRound(db, round.id) });
  });

  /** The report, and the only place another grader's verdict is ever returned. */
  api.get('/rounds/:roundId/report', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') {
      return res.status(409).json({
        error: 'This poll is still open. Votes stay hidden until it closes. That is what makes the result mean anything.',
      });
    }

    const rubric = await store.getRubric(db, round.rubricVersionId);
    const scale = rubric?.scale ?? DEFAULT_SCALE;
    const graders = await store.participantsOf(db, round.id);
    const graderIds = graders.map((g) => g.id);
    const verdicts = await store.verdictsForRound(db, round.id);
    const allRows = buildSplitReport(verdicts, await itemContexts(db, round.id), scale);

    // A trace that is also sitting in a round somebody is still grading has its
    // verdicts withheld here. Otherwise reusing a held-out set — which is how
    // before-and-after is measured on the same cases — would hand the later
    // round's graders last round's answers.
    const embargoed = await traceIdsInOpenRounds(db, round.projectId, round.id);
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
      samplingNote: await store.roundSamplingNote(db, round.id),
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
      resolutions: await store.resolutionsForRound(db, round.id),
      notes: (await store.allGradesForRound(db, round.id)).filter(
        (g) => g.note.trim() && !embargoedItemIds.has(g.itemId),
      ),
    });
  });

  /* ---- Resolutions and shipping ----------------------------------------- */

  /**
   * The deliverable: a closed poll as an eval set. Unanimity and explicit
   * resolutions become test cases; live disagreement is excluded rather than
   * averaged, because an eval exported over a split would hold the AI to a
   * standard the team itself has not met.
   */
  api.get('/rounds/:roundId/evalset', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') {
      return res.status(409).json({ error: 'Close the poll first. An eval set is extracted from finished votes.' });
    }

    const items = await store.listItems(db, round.id);
    const traceList = await Promise.all(items.map((i) => store.getTrace(db, i.traceId)));
    const traces = new Map(traceList.filter((t): t is NonNullable<typeof t> => t !== null).map((t) => [t.id, t]));
    const set = buildEvalSet({
      items,
      traces,
      verdicts: await store.verdictsForRound(db, round.id),
      resolutions: await store.resolutionsForRound(db, round.id),
      grades: await store.allGradesForRound(db, round.id),
      embargoed: await traceIdsInOpenRounds(db, round.projectId, round.id),
    });

    const rubric = await store.getRubric(db, round.rubricVersionId);
    const format = String(req.query.format ?? 'json');
    if (format === 'jsonl') {
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="evalset-${round.id}.jsonl"`);
      return res.send(evalSetToJsonl(set));
    }
    res.json({
      round: { id: round.id, name: round.name },
      rubricVersion: rubric?.version ?? null,
      judgeSystemPrompt: rubric ? buildJudgeSystemPrompt(rubric) : null,
      caseCount: set.cases.length,
      cases: set.cases,
      excluded: set.excluded,
    });
  });

  api.post('/rounds/:roundId/items/:itemId/resolve', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
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

    const item = await store.getItem(db, req.params.itemId!);
    if (!item || item.roundId !== round.id) return res.status(404).json({ error: 'That item is not in this round.' });

    // Held-out traces are graded but never discussed. A clause written about
    // one would be a rubric edit aimed at the measurement set, and the
    // before-and-after number would improve because of the teaching, not the
    // calibration.
    if (item.arm === 'heldout') {
      return res.status(400).json({
        error:
          'This scenario is held back. Held-back cases are how the next poll measures improvement, so settling one here would be writing your standards against your own test set.',
      });
    }

    res.json({ resolution: await store.saveResolution(db, { itemId: item.id, ...body.data }) });
  });

  api.delete('/rounds/:roundId/items/:itemId/resolve', requireRound, async (req, res) => {
    const ok = await store.deleteResolution(db, req.params.itemId!);
    res.status(ok ? 204 : 404).end();
  });

  /** Turn this round's resolutions into the next rubric version. */
  api.post('/rounds/:roundId/ship', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const { project } = req as ProjectRequest;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Close the round first.' });

    const base = await store.getRubric(db, round.rubricVersionId);
    if (!base) return res.status(404).json({ error: 'The round has no rubric to build on.' });

    const resolutions = await store.resolutionsForRound(db, round.id);
    if (resolutions.length === 0) {
      return res.status(400).json({ error: 'Resolve at least one split before shipping a revision.' });
    }

    const existing = new Set(base.clauses.map((c) => c.text.trim().toLowerCase()));
    const additions = resolutions
      .filter((r) => !existing.has(r.clauseText.trim().toLowerCase()))
      .map((r) => ({ text: r.clauseText, originItemId: r.itemId, originRoundId: round.id }));

    const shipped = await store.createRubricVersion(db, {
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

  api.get('/judge/provider', async (_req, res) => {
    const provider = resolveProvider();
    res.json({ provider: provider.id, model: provider.model, real: provider.real });
  });

  api.post('/rounds/:roundId/judge', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const { project } = req as ProjectRequest;
    if (round.status !== 'closed') {
      return res.status(409).json({ error: 'Run the judge against a closed poll, so there are human votes to compare with.' });
    }

    const body = z
      .object({
        rubricVersionId: z.string().min(1),
        arm: z.enum(['calibration', 'heldout']).default('heldout'),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Pick a rubric version to build the judge from.' });

    const rubric = await store.getRubric(db, body.data.rubricVersionId);
    if (!rubric || rubric.projectId !== project.id) return res.status(404).json({ error: 'No such version of the standards.' });

    const items = (await store.listItems(db, round.id)).filter((i) => i.arm === body.data.arm);
    if (items.length === 0) return res.status(400).json({ error: `This round has no ${body.data.arm} items.` });

    // A judge batch is the one thing here that does not fit request/response.
    // Four at a time at a few seconds each puts ~40 items near the platform's
    // function ceiling, and a run that dies halfway leaves a partial set of
    // verdicts that would be scored as though it were the whole arm. Refusing
    // is better than silently reporting agreement computed over the items that
    // happened to finish first. Above this, the run needs a queue.
    if (items.length > MAX_JUDGE_BATCH) {
      return res.status(413).json({
        error: `This arm has ${items.length} items, and a judge run is capped at ${MAX_JUDGE_BATCH} so it finishes inside the request. Run the judge on a smaller round. ${MAX_JUDGE_BATCH} items is already more than the statistics need.`,
        code: 'batch_too_large',
        limit: MAX_JUDGE_BATCH,
      });
    }

    const provider = resolveProvider();
    const runId = await store.createJudgeRun(db, {
      projectId: project.id,
      roundId: round.id,
      rubricVersionId: rubric.id,
      provider: provider.id,
      model: provider.model,
      arm: body.data.arm,
    });

    try {
      const results = await mapLimit(items, 4, async (item) => {
        const trace = await store.getTrace(db, item.traceId);
        if (!trace) return { itemId: item.id, verdict: ABSTAIN, rationale: 'Trace missing.' };
        const graded = await provider.grade(rubric, trace);
        return { itemId: item.id, ...graded };
      });
      for (const r of results) await store.saveJudgeVerdict(db, runId, r.itemId, r.verdict, r.rationale);
    } catch (error) {
      if (error instanceof JudgeError) return res.status(502).json({ error: error.message, code: error.code });
      throw error;
    }

    res.status(201).json({ runId, provider: provider.id, model: provider.model, real: provider.real });
  });

  api.get('/rounds/:roundId/judge', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const rubricScale = (await store.getRubric(db, round.rubricVersionId))?.scale ?? DEFAULT_SCALE;
    const verdicts = await store.verdictsForRound(db, round.id);
    const byItem = new Map(verdicts.map((v) => [v.itemId, v.byGrader]));
    const items = await store.listItems(db, round.id);
    const armOf = new Map(items.map((i) => [i.id, i.arm]));

    const runs = await Promise.all(
      (await store.listJudgeRuns(db, round.id)).map(async (run) => {
      const judged = await store.judgeVerdicts(db, run.id);
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
        rubricVersion: (await store.getRubric(db, run.rubricVersionId))?.version ?? null,
        itemCount: scoped.length,
        judgeAbstentions: scoped.filter((j) => j.verdict === ABSTAIN).length,
        agreementWithHumans: compared === 0 ? null : agreed / compared,
        comparisons: compared,
        perGrader: versusHuman,
        verdicts: scoped,
        };
      }),
    );

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

async function itemContexts(db: DB, roundId: string): Promise<Map<string, ItemContext>> {
  const resolved = new Set((await store.resolutionsForRound(db, roundId)).map((r) => r.itemId));
  const map = new Map<string, ItemContext>();
  for (const item of await store.listItems(db, roundId)) {
    const trace = await store.getTrace(db, item.traceId);
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
async function traceIdsInOpenRounds(db: DB, projectId: string, exceptRoundId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const round of await store.listRounds(db, projectId)) {
    if (round.status !== 'open' || round.id === exceptRoundId) continue;
    for (const item of await store.listItems(db, round.id)) ids.add(item.traceId);
  }
  return ids;
}

async function reportRows(db: DB, roundId: string, scale: { id: string; label: string; rank: number }[]) {
  return buildSplitReport(await store.verdictsForRound(db, roundId), await itemContexts(db, roundId), scale);
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
