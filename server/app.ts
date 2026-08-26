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

import { createHash, randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DB } from './db.js';
import { newId, newSlug, newToken, resolveConnection } from './db.js';
import * as store from './store.js';
import { seedDemoProject } from './seed.js';
import { parseImport } from './import.js';
import { JudgeError, mapLimit, resolveProvider } from './judge.js';
import { DrafterError, resolveDrafter } from './drafter.js';
import { offlineScenarist, resolveScenarist } from './scenarist.js';
import { adapterFor, availableFamilies, offlineAdapter, offlinePanelWriter, resolvePanelWriter } from './panelists.js';
import { renderOgSvg, renderStandardsPage, type StandardsView } from './standards.js';
import { createSpendGuard } from './spend.js';
import {
  ABSTAIN,
  DEFAULT_SCALE,
  agreementStats,
  attentionEstimate,
  buildJudgeSystemPrompt,
  buildEvalSet,
  buildSoloEvalSet,
  buildSplitReport,
  clusterSplits,
  evalSetToJsonl,
  soloEvalSetToJsonl,
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
  gwetAC1,
  krippendorffAlpha,
} from '../shared/index.js';
import { ARCHETYPES, REQUIRED_SEAT, archetype } from '../shared/panel.js';
import { groundEvidence, isTheater, patchIsGrounded, readCase, type SeatVote } from '../shared/panelmap.js';
import { renderApiDocs } from './apidocs.js';

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

/** Older clients fold the limits into the description; recover them. */
function extractLimits(description: string): string {
  return description.match(/Hard limits:\s*([\s\S]+)$/i)?.[1] ?? '';
}

/**
 * The owner's limits, split into one clause per sentence. "Skip", or anything
 * too short to be a rule, yields nothing: a rubric clause that says "skip"
 * would be worse than an empty rubric.
 */
function splitIntoClauses(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length < 12 || /^skip\b/i.test(trimmed)) return [];
  return trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .slice(0, 5);
}

export function createApp(db: DB) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  // The public Standards page uses plain HTML forms for its owner controls.
  app.use(express.urlencoded({ extended: false }));

  const api = express.Router();

  /**
   * Liveness plus a real read, so a wedged database fails the check — and an
   * honest answer to "will anything I make here survive?". The in-memory
   * fallback is a developer convenience; reporting it as healthy in production
   * would be lying, so a deployed instance without Postgres reads not-ok.
   */
  /** The API documents itself; no key needed to read how to get one. */
  api.get('/docs', (req, res) => {
    const proto = req.header('x-forwarded-proto') ?? req.protocol;
    // text/plain so a browser shows it inline instead of downloading a file.
    res.type('text/plain; charset=utf-8').send(renderApiDocs(`${proto}://${req.get('host')}`));
  });

  api.get('/health', async (_req, res) => {
    const conn = resolveConnection();
    const deployed = !!process.env.VERCEL;
    try {
      await db.get('SELECT 1 AS ok');
      res.status(conn.url || !deployed ? 200 : 503).json({
        ok: !!conn.url || !deployed,
        judge: resolveProvider().id,
        database: conn.url
          ? { driver: 'postgres', via: conn.via, pooled: conn.pooled }
          : { driver: 'memory', warning: 'No Postgres connection string set. Data is lost when the process ends.' },
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: error instanceof Error ? error.message : 'database unavailable' });
    }
  });

  /* ---- Project scoping -------------------------------------------------- */

  const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

  /** The credential, wherever the caller put it: Bearer, header, or link. */
  function credentialOf(req: Request): string | null {
    const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const raw = bearer ?? req.header('x-gr-token') ?? (typeof req.query.k === 'string' ? req.query.k : '');
    const cred = raw.trim();
    return cred === '' ? null : cred;
  }

  /**
   * Three credentials open a project: the token from the secret link (which is
   * also the master API key the create call returns), a minted `gr_` key, and
   * nothing else. Missing reads as 401 with the fix; wrong reads as 403.
   * Unknown and revoked keys are indistinguishable on purpose.
   */
  async function authorizeProject(req: Request, res: Response, project: Project): Promise<boolean> {
    const cred = credentialOf(req);
    if (!cred) {
      res.status(401).json({
        error:
          'No API key. Send Authorization: Bearer <key> (mint one from the project page or POST /api/v1/projects/:slug/keys), or use the k parameter from your project link.',
      });
      return false;
    }
    if (cred === project.token) return true;
    if (cred.startsWith('gr_') && (await store.projectIdForKeyHash(db, hashKey(cred))) === project.id) {
      return true;
    }
    res.status(403).json({ error: 'That key does not open this project.' });
    return false;
  }

  async function requireProject(req: Request, res: Response, next: NextFunction) {
    const slug = req.params.slug!;
    const project = await store.getProjectBySlug(db, slug);
    if (!project) return res.status(404).json({ error: 'No project with that link.' });
    if (!(await authorizeProject(req, res, project))) return;
    (req as ProjectRequest).project = project;
    next();
  }

  /** Round routes are reached by round id, so the project is resolved from the round. */
  async function requireRound(req: Request, res: Response, next: NextFunction) {
    const round = await store.getRound(db, req.params.roundId!);
    if (!round) return res.status(404).json({ error: 'No such poll.' });
    const project = await store.getProjectBySlug(db, await store.getProjectSlug(db, round.projectId) ?? '');
    if (!project) return res.status(404).json({ error: 'No such project.' });
    if (!(await authorizeProject(req, res, project))) return;

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
        /** The answer to "anything it must never do?", kept apart on purpose. */
        limits: z.string().max(1000).default(''),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A project name is required.' });

    const description = body.data.description.trim();
    const project = await store.createProject(db, {
      slug: newSlug(body.data.name),
      token: newToken(),
      name: body.data.name,
      description,
    });

    // The hard limits the owner typed are already rubric sentences: they are
    // the one thing at setup that is written in their own words about what
    // counts as failure. They become clauses verbatim rather than being
    // paraphrased, so v1 is a framework rather than an empty preamble, and so
    // the literalist has something real to hold the panel to. Nothing else is
    // invented here; an unwritten rubric is the panel's job to fill.
    const limits = (body.data.limits || extractLimits(description)).trim();
    const criteria = splitIntoClauses(limits).map((body_) => ({
      id: newId(),
      title: 'Your hard limit',
      body: body_,
    }));

    const rubric = await store.createRubricVersion(db, {
      projectId: project.id,
      name: 'Your standards',
      preamble: description,
      scale: DEFAULT_SCALE,
      criteria,
    });

    // No model calls here, deliberately. Seating a panel and writing scenarios
    // are one model call each, and doing both inside the create request put
    // two of them in series behind a serverless function's wall clock, which
    // is how this route started returning 504s under real models. They are
    // now their own endpoints, called in sequence by setup, which also lets
    // the page report each one as it actually finishes instead of claiming
    // both up front. Their work is unchanged; only who waits for it moved.
    res.status(201).json({ project, rubric, scenarioCount: 0, scenariosReal: false, seatCount: 0 });
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

  /** Optional email capture at setup: somewhere for the link to be re-sent.
   *  Captured, not yet sent anywhere; the link stays the credential. */
  api.post('/projects/:slug/email', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const body = z.object({ email: z.string().email().max(200) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'That does not read as an email address.' });
    await store.setOwnerEmail(db, project.id, body.data.email);
    res.json({ ok: true });
  });

  api.post('/projects/:slug/visibility', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const body = z.object({ public: z.boolean() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'public: true or false.' });
    await store.setProjectPublic(db, project.id, body.data.public);
    res.json({ ok: true, isPublic: body.data.public });
  });

  /* ---- API keys ---------------------------------------------------------- */

  /**
   * Mint a key for /api/v1. The full key crosses the wire exactly once, here;
   * the row keeps its hash and an 11-character prefix for the list view.
   * Minting requires an existing credential, so a leaked slug alone mints
   * nothing.
   */
  api.post('/projects/:slug/keys', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : 'unnamed key';
    const key = `gr_${randomBytes(24).toString('hex')}`;
    const record = await store.createApiKey(db, {
      projectId: project.id,
      name,
      keyHash: hashKey(key),
      prefix: key.slice(0, 11),
    });
    res.status(201).json({
      key,
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      createdAt: record.createdAt,
      note: 'Store this key now. Only its hash is kept, so it cannot be shown again.',
    });
  });

  api.get('/projects/:slug/keys', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    res.json({ keys: await store.listApiKeys(db, project.id) });
  });

  api.delete('/projects/:slug/keys/:keyId', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const revoked = await store.revokeApiKey(db, project.id, req.params.keyId!);
    if (!revoked) return res.status(404).json({ error: 'No live key with that id on this project.' });
    res.status(204).end();
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

  /**
   * The owner's call on one scenario: what should happen, and why. Null verdict
   * withdraws the call, which also pulls the case back out of the eval set.
   */
  api.patch('/projects/:slug/traces/:traceId/expected', requireProject, async (req, res) => {
    const body = z
      .object({ verdict: z.string().min(1).nullable(), reason: z.string().max(2000).default('') })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A call needs a verdict, or null to withdraw one.' });

    const project = (req as ProjectRequest).project;
    if (body.data.verdict !== null) {
      const rubric = await store.currentRubric(db, project.id);
      const scale = rubric?.scale ?? DEFAULT_SCALE;
      if (!scale.some((level) => level.id === body.data.verdict)) {
        return res.status(400).json({ error: `The verdict must be one of: ${scale.map((l) => l.id).join(', ')}.` });
      }
    }
    const trace = await store.setTraceExpected(db, project.id, req.params.traceId!, {
      verdict: body.data.verdict,
      reason: body.data.reason.trim(),
    });
    if (!trace) return res.status(404).json({ error: 'No such scenario in this project.' });
    res.json({ trace });
  });

  /**
   * The solo deliverable: every scenario the owner has made a call on, as an
   * eval set. ?format=jsonl downloads; the JSON form carries the judge prompt.
   */
  api.get('/projects/:slug/evalset', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const set = buildSoloEvalSet(await store.listTraces(db, project.id));
    if (req.query.format === 'jsonl') {
      res
        .type('application/jsonl')
        .setHeader('Content-Disposition', `attachment; filename="${project.slug}-evalset.jsonl"`)
        .send(soloEvalSetToJsonl(set));
      return;
    }
    const rubric = await store.currentRubric(db, project.id);
    res.json({
      cases: set.cases,
      unanswered: set.unanswered,
      judgeSystemPrompt: rubric ? buildJudgeSystemPrompt(rubric) : null,
    });
  });

  /* ---- The panel --------------------------------------------------------- */

  /**
   * Seat a fresh panel: project-specific seats from the writer, one model
   * family each, plus the literalist, which is seated structurally rather than
   * left to a model to propose. Callers must check for an existing panel
   * first; this never regenerates over user edits.
   *
   * The assignment is the point. Six seats backed by one model is one judge
   * wearing six hats: it agrees with itself for reasons that have nothing to
   * do with the rubric. So each seat takes a different family, and the
   * literalist takes the cheapest of them, because its job is the mechanical
   * one (does the written rubric decide this case?) and it runs on every case.
   */
  async function seatPanel(project: Project) {
    const families = availableFamilies();
    const writer = resolvePanelWriter();
    let proposed: { name: string; objective: string; failsFor: string }[];
    try {
      proposed = await writer.write(project.description || project.name, 5);
    } catch {
      // Explicitly the offline writer, not another resolve: re-resolving would
      // hand back the same writer that just failed and retry the identical
      // call. A router hiccup should cost a bespoke panel, never the panel.
      proposed = await offlinePanelWriter().write('', 5);
    }

    const lit = archetype(REQUIRED_SEAT)!;
    const seatSpecs = [
      { name: lit.name, objective: lit.objective, failsFor: lit.failsFor, archetypeId: lit.id, origin: 'archetype' as const },
      ...proposed
        .filter((p) => !p.name.toLowerCase().includes('literalist'))
        .map((p) => ({ ...p, archetypeId: null, origin: 'generated' as const })),
    ];

    // families arrives cheapest-first, so the literalist (always seat 0) takes
    // the cheapest family and the rest spread across the others in order.
    const seats = [];
    for (const [i, spec] of seatSpecs.entries()) {
      const fam = families[i % families.length]!;
      seats.push(
        await store.insertGrader(db, {
          projectId: project.id,
          name: spec.name,
          kind: 'panelist',
          objective: spec.objective,
          failsFor: spec.failsFor,
          model: fam.model,
          family: fam.family,
          origin: spec.origin,
          archetypeId: spec.archetypeId,
        }),
      );
    }
    return { seats, families, real: writer.real };
  }

  api.post('/projects/:slug/panel', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const existing = (await store.listGraders(db, project.id)).filter((g) => g.kind === 'panelist');
    if (existing.length > 0) {
      return res.json({ seats: existing, families: availableFamilies().map((f) => f.family), generated: false });
    }

    const { seats, families, real } = await seatPanel(project);
    res.status(201).json({
      seats,
      families: families.map((f) => f.family),
      familiesShort: Math.max(0, 3 - new Set(families.filter((f) => f.real).map((f) => f.family)).size),
      generated: true,
      real,
    });
  });

  api.get('/projects/:slug/panel/archetypes', requireProject, async (_req, res) => {
    res.json({ archetypes: ARCHETYPES });
  });

  /** Add a seat: from the archetype library, or authored. Logged as signal. */
  api.post('/projects/:slug/panel/seats', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const body = z
      .object({
        archetypeId: z.string().optional(),
        name: z.string().min(1).max(80).optional(),
        objective: z.string().max(300).optional(),
        failsFor: z.string().max(300).optional(),
        note: z.string().max(300).default(''),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A seat needs an archetype id, or a name with an objective.' });

    let spec: { name: string; objective: string; failsFor: string; archetypeId: string | null; origin: 'archetype' | 'user' };
    if (body.data.archetypeId) {
      const a = archetype(body.data.archetypeId);
      if (!a) return res.status(404).json({ error: 'No such archetype in the library.' });
      spec = { name: a.name, objective: a.objective, failsFor: a.failsFor, archetypeId: a.id, origin: 'archetype' };
    } else if (body.data.name && body.data.objective && body.data.failsFor) {
      spec = { name: body.data.name, objective: body.data.objective, failsFor: body.data.failsFor, archetypeId: null, origin: 'user' };
    } else {
      return res.status(400).json({ error: 'A seat needs an archetype id, or a name, an objective, and a failure trigger.' });
    }

    const fams = availableFamilies();
    const existing = (await store.listGraders(db, project.id)).filter((g) => g.kind === 'panelist');
    const fam = fams[existing.length % fams.length]!;
    const seat = await store.insertGrader(db, {
      projectId: project.id,
      name: spec.name,
      kind: 'panelist',
      objective: spec.objective,
      failsFor: spec.failsFor,
      model: fam.model,
      family: fam.family,
      origin: spec.origin,
      archetypeId: spec.archetypeId,
    });
    await store.recordPanelEdit(db, {
      projectId: project.id,
      seatName: seat.name,
      action: 'add',
      after: `${seat.objective} / ${seat.failsFor}`,
      note: body.data.note,
    });
    res.status(201).json({ seat });
  });

  api.patch('/projects/:slug/panel/seats/:seatId', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        objective: z.string().min(1).max(300).optional(),
        failsFor: z.string().min(1).max(300).optional(),
        note: z.string().max(300).default(''),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Nothing to change.' });

    const before = await store.getGrader(db, req.params.seatId!);
    if (!before || before.projectId !== project.id || before.kind !== 'panelist') {
      return res.status(404).json({ error: 'No such seat.' });
    }
    const seat = await store.updateSeat(db, project.id, req.params.seatId!, body.data);
    await store.recordPanelEdit(db, {
      projectId: project.id,
      seatName: before.name,
      action: 'rewrite',
      before: `${before.name}: ${before.objective} / ${before.failsFor}`,
      after: `${seat!.name}: ${seat!.objective} / ${seat!.failsFor}`,
      note: body.data.note,
    });
    res.json({ seat });
  });

  api.delete('/projects/:slug/panel/seats/:seatId', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const before = await store.getGrader(db, req.params.seatId!);
    if (!before || before.projectId !== project.id || before.kind !== 'panelist') {
      return res.status(404).json({ error: 'No such seat.' });
    }
    await store.recordPanelEdit(db, {
      projectId: project.id,
      seatName: before.name,
      action: 'delete',
      before: `${before.objective} / ${before.failsFor}`,
      note: typeof req.query.note === 'string' ? req.query.note : '',
    });
    await store.deleteSeat(db, project.id, req.params.seatId!);
    res.status(204).end();
  });

  /**
   * A panel round: every seat grades every case, blind. Cases are capped at 30
   * and all count; there is no held-out arm here, because the owner's ten
   * (below) is what keeps the panel honest instead.
   */
  api.post('/projects/:slug/panel-rounds', requireProject, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const seats = (await store.listGraders(db, project.id)).filter((g) => g.kind === 'panelist');
    if (seats.length < 3) {
      return res.status(400).json({ error: 'A panel needs at least three seats before it can grade. Generate or add seats first.' });
    }
    // Fewer than three real families is quietly seating one family twice,
    // which is the thing family diversity exists to prevent. Zero real
    // families is the labeled simulation and allowed; one or two is blocked
    // loudly rather than papered over.
    const realFamilies = new Set(availableFamilies().filter((f) => f.real).map((f) => f.family));
    if (realFamilies.size > 0 && realFamilies.size < 3) {
      return res.status(409).json({
        error: `Only ${realFamilies.size} real model famil${realFamilies.size === 1 ? 'y is' : 'ies are'} reachable (${[...realFamilies].join(', ')}). The panel needs three disjoint families; add OPENROUTER_API_KEY for all three through one key, or run with no keys for the labeled simulation.`,
      });
    }
    const rubric = await store.currentRubric(db, project.id);
    if (!rubric) return res.status(400).json({ error: 'This project has no rubric to grade against.' });
    const traces = (await store.listTraces(db, project.id)).slice(0, 30);
    if (traces.length < 2) return res.status(400).json({ error: 'Add or generate at least two cases first.' });

    const { round } = await store.createRound(db, {
      projectId: project.id,
      rubricVersionId: rubric.id,
      name: '',
      strategy: 'random',
      seed: newId(),
      samplingNote: `Panel round: ${seats.length} seats over ${traces.length} cases, every seat grading every case, blind.`,
      sourceRoundId: null,
      calibration: traces.map((t) => t.id),
      heldout: [],
    });
    // Pin every seat's model at round start. A round whose panel silently
    // changed composition has a worthless history.
    await store.setRoundPinnedModels(
      db,
      round.id,
      Object.fromEntries(seats.map((s) => [s.name, `${s.family}:${adapterFor(s.family).model}`])),
    );
    res.status(201).json({ round, seats: seats.map((s) => ({ id: s.id, name: s.name })), cases: traces.length });
  });

  /**
   * Run one seat over every case in the round, inline and batched. The client
   * calls this once per seat, which is what makes per-seat progress real
   * rather than reported. When the last seat finishes, the round closes
   * itself: a panel does not linger the way a human round must.
   */
  api.post('/rounds/:roundId/panel-run', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status === 'closed') return res.status(409).json({ error: 'This round has already closed.' });

    const body = z.object({ seatId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Which seat runs?' });
    const seat = await store.getGrader(db, body.data.seatId);
    if (!seat || seat.projectId !== round.projectId || seat.kind !== 'panelist') {
      return res.status(404).json({ error: 'No such seat on this panel.' });
    }

    const rubric = await store.getRubric(db, round.rubricVersionId);
    const rubricMarkdown = rubric ? renderRubricMarkdown(rubric) : '';
    const adapter = adapterFor(seat.family);
    const items = await store.listItems(db, round.id);

    // The gateway context for this seat: telemetry, the spend guard, and the
    // user's own key when they sent one. The key lives in this request and
    // nowhere else.
    const byok = req.header('x-openrouter-key');
    const gateway = {
      ...(byok ? { apiKey: byok } : {}),
      recorder: (a: Parameters<typeof store.recordModelCall>[1]) => store.recordModelCall(db, a),
      guard: createSpendGuard(db),
      roundId: round.id,
    };

    // Case order shuffled per seat (position bias): a cheap deterministic
    // shuffle keyed on the seat id.
    const shuffled = [...items].sort((a, b) => {
      const ha = `${seat.id}|${a.id}`.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
      const hb = `${seat.id}|${b.id}`.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
      return ha - hb;
    });

    let graded = 0;
    // Concurrency 6: a full 30-case seat is five waves, roughly 30 seconds at
    // real-model latency, comfortably inside the 60 second function ceiling.
    await mapLimit(shuffled, 6, async (item) => {
      const trace = await store.getTrace(db, item.traceId);
      if (!trace) return;
      const verdict = await adapter.score(
        {
          seat,
          rubricMarkdown,
          caseId: item.traceId,
          caseTitle: trace.title,
          caseContent: trace.content,
        },
        gateway,
      );
      if (!adapter.real) {
        // The simulation records telemetry too, at zero cost, so the running
        // cost machinery is exercised on every surface it will later report.
        await store.recordModelCall(db, {
          call_id: `sim_${item.id}_${seat.id}`,
          attempt_no: 1,
          caller_kind: 'grader',
          round_id: round.id,
          panelist_id: seat.id,
          case_id: item.traceId,
          pin_id: 'simulated',
          model_family: 'offline',
          openrouter_model_id: 'simulated',
          provider_slug: null,
          prompt_tokens: Math.ceil(trace.content.length / 4),
          completion_tokens: 24,
          total_tokens: Math.ceil(trace.content.length / 4) + 24,
          cost_credits: 0,
          upstream_inference_cost: null,
          generation_id: null,
          latency_ms: 0,
          http_status: 200,
          error_kind: null,
        });
      }
      await store.submitGrade(db, {
        itemId: item.id,
        graderId: seat.id,
        verdict: verdict.verdict,
        note: verdict.reason,
        outputLength: trace.content.length,
      });
      graded++;
    });

    // The repeat sample: this seat re-grades 20% of its cases, and the rate
    // at which it agrees with itself decides whether its disagreement gets
    // treated as signal. Below threshold, the seat is flagged and its weight
    // halved, and that action is recorded like any other panel change.
    const sample = shuffled.slice(0, Math.max(1, Math.ceil(shuffled.length * 0.2)));
    let agreements = 0;
    const firstPass = new Map(
      (await store.gradesForGrader(db, round.id, seat.id)).map((g) => [g.itemId, g.verdict]),
    );
    for (const item of sample) {
      const trace = await store.getTrace(db, item.traceId);
      if (!trace) continue;
      const repeat = await adapter.score(
        { seat, rubricMarkdown, caseId: item.traceId, caseTitle: trace.title, caseContent: trace.content },
        gateway,
      );
      if (repeat.verdict === firstPass.get(item.id)) agreements++;
    }
    const threshold = Number(process.env.GR_CONSISTENCY_THRESHOLD ?? '0.7');
    const rate = sample.length === 0 ? 1 : agreements / sample.length;
    const flagged = rate < threshold;
    await store.saveSelfConsistency(db, {
      roundId: round.id,
      graderId: seat.id,
      sampleSize: sample.length,
      agreements,
      flagged,
    });
    if (flagged && seat.weight === 1) {
      await store.setSeatWeight(db, seat.id, 0.5);
      await store.recordPanelEdit(db, {
        projectId: round.projectId,
        seatName: seat.name,
        action: 'down_weight',
        before: 'weight 1',
        after: `weight 0.5 (self-consistency ${(rate * 100).toFixed(0)}% under ${(threshold * 100).toFixed(0)}%)`,
        note: 'Automatic: a seat that cannot agree with itself is not signal.',
      });
    }

    // Close the round once every seat has graded every item.
    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const progress = await store.roundProgress(db, round.id);
    const complete = seats.every((s) => (progress.find((p) => p.graderId === s.id)?.done ?? 0) >= items.length);
    if (complete) await store.closeRound(db, round.id);

    const cost = await store.costForRound(db, round.id);
    res.json({
      seat: seat.name,
      graded,
      simulated: !adapter.real,
      closed: complete,
      cost: { totalCredits: cost.totalCredits, totalTokens: cost.totalTokens },
    });
  });

  /**
   * The disagreement map. Settled, persona-driven, contested, blind spot, per
   * case, with the agreement numbers that are honest under skew: AC1 next to
   * alpha, never alpha alone.
   */
  api.get('/rounds/:roundId/map', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') {
      return res.status(409).json({ error: 'The panel is still grading. The map appears when every seat has finished.' });
    }
    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatById = new Map(seats.map((s) => [s.id, s]));
    // Seats from the system-under-test's family are excluded from the pattern
    // math by default (self-preference contaminates the obvious setup); the
    // toggle shows what changes, it does not change the default.
    const includeSameFamily = req.query.includeSameFamily === '1';
    const scoringSeatIds = new Set(
      seats.filter((s) => includeSameFamily || !s.sameFamilyAsSut).map((s) => s.id),
    );
    const literalistName =
      seats.find((s) => s.archetypeId === 'literalist' || /literalist/i.test(s.name))?.name ?? null;
    const items = await store.listItems(db, round.id);
    const grades = await store.allGradesForRound(db, round.id);
    const byItem = new Map<string, typeof grades>();
    for (const g of grades) {
      if (!seatById.has(g.graderId)) continue;
      byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);
    }

    const userVerdicts = await store.listUserVerdicts(db, round.id);
    const checked = new Set(userVerdicts.map((v) => v.itemId));

    const cases = [];
    const units: string[][] = [];
    for (const item of items) {
      const trace = await store.getTrace(db, item.traceId);
      const votes: SeatVote[] = (byItem.get(item.id) ?? []).map((g) => ({
        seatId: g.graderId,
        seatName: seatById.get(g.graderId)?.name ?? 'unknown seat',
        verdict: g.verdict,
        reason: g.note,
      }));
      const scoringVotes = votes.filter((v) => scoringSeatIds.has(v.seatId));
      const reading = readCase(item.id, scoringVotes);
      const theater =
        reading.pattern === 'persona-driven' && reading.dissenter
          ? isTheater(scoringVotes, reading.dissenter, literalistName)
          : false;
      units.push(scoringVotes.map((v) => v.verdict));
      cases.push({
        itemId: item.id,
        traceId: item.traceId,
        title: trace?.title ?? 'Missing case',
        content: trace?.content ?? '',
        votes,
        pattern: reading.pattern,
        dissenter: reading.dissenter,
        theater,
        provisional: reading.provisional && !checked.has(item.id),
        checkedByOwner: checked.has(item.id),
      });
    }

    const categories = (await store.getRubric(db, round.rubricVersionId))?.scale.map((l) => l.id) ?? ['fail', 'recoverable', 'pass'];
    const counts = {
      settled: cases.filter((c) => c.pattern === 'settled').length,
      personaDriven: cases.filter((c) => c.pattern === 'persona-driven').length,
      contested: cases.filter((c) => c.pattern === 'contested').length,
      blindSpots: cases.filter((c) => c.pattern === 'blind-spot').length,
    };
    const consistency = await store.listSelfConsistency(db, round.id);
    const consistencyBySeat = new Map(consistency.map((c) => [c.graderId, c]));
    res.json({
      round: { id: round.id, name: round.name, status: round.status },
      pinnedModels: await store.getRoundPinnedModels(db, round.id),
      cost: await store.costForRound(db, round.id),
      seats: seats.map((s) => ({
        id: s.id,
        name: s.name,
        family: s.family,
        model: s.model,
        objective: s.objective,
        weight: s.weight,
        sameFamilyAsSut: s.sameFamilyAsSut,
        excludedFromSettled: !scoringSeatIds.has(s.id),
        selfConsistency: consistencyBySeat.get(s.id) ?? null,
      })),
      includeSameFamily,
      cases,
      counts,
      agreement: {
        observed: units.length ? units.filter((u) => new Set(u.filter((v) => v !== ABSTAIN)).size === 1).length / units.length : 0,
        alpha: krippendorffAlpha(units, categories, 'nominal'),
        ac1: gwetAC1(units, categories),
      },
      simulated: !availableFamilies().some((f) => f.real),
    });
  });

  /**
   * The rubric diff: propose sentences mined from contested and persona-driven
   * cases. The grounding gate is structural: a patch that cannot quote at
   * least two verdict reasons verbatim is dropped, and the drop is counted in
   * the response, because plausible ungrounded rubric language is the exact
   * failure this product exists to prevent.
   */
  /** Mine the missing sentences from a closed round. Shared by the patches
   *  route and the one-click standards write; grounding rules identical. */
  async function minePatchesForRound(round: NonNullable<Awaited<ReturnType<typeof store.getRound>>>) {
    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatById = new Map(seats.map((s) => [s.id, s]));
    const items = await store.listItems(db, round.id);
    const grades = await store.allGradesForRound(db, round.id);
    const byItem = new Map<string, typeof grades>();
    for (const g of grades) {
      if (!seatById.has(g.graderId)) continue;
      byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);
    }

    const reasonIndex = new Map<string, string>();
    interface Disputed {
      itemId: string;
      title: string;
      dissenter: ReturnType<typeof seatById.get> | null;
      votes: SeatVote[];
    }
    const disputed: Disputed[] = [];
    let contestedTotal = 0;
    for (const item of items) {
      const votes: SeatVote[] = (byItem.get(item.id) ?? []).map((g) => ({
        seatId: g.graderId,
        seatName: seatById.get(g.graderId)?.name ?? 'unknown',
        verdict: g.verdict,
        reason: g.note,
      }));
      for (const v of votes) reasonIndex.set(`${item.id}|${v.seatName}`, v.reason);
      const reading = readCase(item.id, votes);
      const litName = seats.find((s) => s.archetypeId === 'literalist' || /literalist/i.test(s.name))?.name ?? null;
      const theater =
        reading.pattern === 'persona-driven' && reading.dissenter
          ? isTheater(votes, reading.dissenter, litName)
          : false;
      if (theater) continue; // shown on the map, never mined into the rubric
      if (reading.pattern === 'persona-driven' || reading.pattern === 'contested') {
        contestedTotal++;
        const trace = await store.getTrace(db, item.traceId);
        disputed.push({
          itemId: item.id,
          title: trace?.title ?? 'Case',
          dissenter: reading.dissenter ? seats.find((s) => s.name === reading.dissenter) : null,
          votes,
        });
      }
    }

    // Group persona-driven cases by the dissenting seat; each group proposes
    // the concrete clause that seat's stake implies, quoting the room.
    const byDissenter = new Map<string, Disputed[]>();
    const freeContested: Disputed[] = [];
    for (const d of disputed) {
      if (d.dissenter) byDissenter.set(d.dissenter.id, [...(byDissenter.get(d.dissenter.id) ?? []), d]);
      else freeContested.push(d);
    }

    // Projected lift is a real recomputation, not an estimate: rebuild the
    // verdict units with the patch's covered cases decided the way the patch
    // decides them, and diff the agreement statistic (AC1, the skew-honest
    // one) against today's. A fixture pins that it moves when coverage moves.
    const scale = (await store.getRubric(db, round.rubricVersionId))?.scale.map((l) => l.id) ?? ['fail', 'recoverable', 'pass'];
    const allUnits: { itemId: string; unit: string[] }[] = [];
    for (const item of items) {
      allUnits.push({ itemId: item.id, unit: (byItem.get(item.id) ?? []).map((g) => g.verdict) });
    }
    const currentAC1 = gwetAC1(allUnits.map((u) => u.unit), scale);
    const liftFor = (coveredItemIds: Set<string>, decidedVerdict: string): number | null => {
      if (currentAC1 === null) return null;
      const patched = allUnits.map((u) =>
        coveredItemIds.has(u.itemId) ? u.unit.map(() => decidedVerdict) : u.unit,
      );
      const next = gwetAC1(patched, scale);
      return next === null ? null : next - currentAC1;
    };

    let dropped = 0;
    const stored = [];

    for (const [seatId, group] of byDissenter) {
      const seat = seatById.get(seatId)!;
      const dissents = group.flatMap((g) => g.votes.filter((v) => v.seatId === seatId).map((v) => ({ itemId: g.itemId, seat: v.seatName, quote: v.reason })));
      const others = group.flatMap((g) => g.votes.filter((v) => v.seatId !== seatId).slice(0, 1).map((v) => ({ itemId: g.itemId, seat: v.seatName, quote: v.reason })));
      const evidence = groundEvidence([...dissents, ...others], reasonIndex).slice(0, 4);
      if (!patchIsGrounded(evidence)) {
        dropped++;
        continue;
      }
      const text = `Decide ${seat.name.toLowerCase()}'s stake on purpose: ${seat.failsFor.replace(/^Fails /, 'an answer that ').replace(/\.$/, '')} is at most recoverable, or say explicitly that this does not count against an answer.`;
      stored.push(
        await store.insertPatch(db, {
          projectId: round.projectId,
          roundId: round.id,
          text,
          evidence,
          seatsSided: [seat.name],
          projectedLift: liftFor(
            new Set(group.map((g) => g.itemId)),
            group[0]!.votes.find((v) => v.seatId === seatId)?.verdict ?? 'recoverable',
          ),
        }),
      );
    }

    if (freeContested.length >= 2) {
      const evidence = groundEvidence(
        freeContested.slice(0, 2).map((g) => ({ itemId: g.itemId, seat: g.votes[0]!.seatName, quote: g.votes[0]!.reason })),
        reasonIndex,
      );
      if (patchIsGrounded(evidence)) {
        stored.push(
          await store.insertPatch(db, {
            projectId: round.projectId,
            roundId: round.id,
            text: `Cases like "${freeContested[0]!.title}" are decided by this rubric, not left to the grader's judgment: name which stake wins there, in one sentence, and grade every case of that shape the same way.`,
            evidence,
            seatsSided: [],
            projectedLift: liftFor(
              new Set(freeContested.map((g) => g.itemId)),
              freeContested[0]!.votes[0]?.verdict ?? 'pass',
            ),
          }),
        );
      } else {
        dropped++;
      }
    }

    // The deleted-seat signal: an edit is a statement, and a deleted seat
    // whose stake keeps showing up in contested reasons is a flag that the
    // user cut a stakeholder who mattered. Surfaced with that framing, under
    // the same grounding gate as everything else.
    const edits = await store.listPanelEdits(db, round.projectId);
    for (const edit of edits.filter((e) => e.action === 'delete')) {
      const stakeWords = edit.before
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 5);
      const hits: { itemId: string; seat: string; quote: string }[] = [];
      for (const d of disputed) {
        for (const v of d.votes) {
          if (stakeWords.some((w) => v.reason.toLowerCase().includes(w))) {
            hits.push({ itemId: d.itemId, seat: v.seatName, quote: v.reason });
            break;
          }
        }
      }
      const evidence = groundEvidence(hits, reasonIndex).slice(0, 3);
      if (evidence.length >= 2) {
        stored.push(
          await store.insertPatch(db, {
            projectId: round.projectId,
            roundId: round.id,
            text: `You removed the seat "${edit.seatName}", but its stake keeps appearing in the room's contested reasons. Decide it on purpose: either write its rule into the rubric, or write down that it does not count.`,
            evidence,
            seatsSided: [edit.seatName],
            projectedLift: null,
          }),
        );
      }
    }

    return { stored, dropped, contestedTotal };
  }

  api.post('/rounds/:roundId/patches', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Patches are mined from a finished round.' });

    const existing = await store.listPatches(db, round.id);
    if (existing.length > 0) return res.json({ patches: existing, dropped: 0, regenerated: false });

    const { stored, dropped, contestedTotal } = await minePatchesForRound(round);
    res.status(201).json({ patches: stored, dropped, contestedTotal, regenerated: true });
  });

  /**
   * The handoff: every grounded split becomes a sentence in one new Standards
   * version. Nothing is edited here; the owner approves on the Standards page
   * by publishing it. Idempotent per round: writing twice returns the version
   * the round already produced.
   */
  api.post('/rounds/:roundId/standards', requireRound, async (req, res) => {
    const project = (req as ProjectRequest).project;
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Standards are written from a finished round.' });

    let patches = await store.listPatches(db, round.id);
    if (patches.length === 0) patches = (await minePatchesForRound(round)).stored;

    const already = patches.find((p) => p.status === 'accepted' && p.resolvedRubricVersionId);
    if (already) {
      const version = await store.getRubric(db, already.resolvedRubricVersionId!);
      return res.json({ rubric: version, url: `/s/${project.slug}`, sentences: 0, alreadyWritten: true });
    }

    const proposed = patches.filter((p) => p.status === 'proposed');
    const current = await store.currentRubric(db, round.projectId);
    if (!current) return res.status(400).json({ error: 'No rubric to write into.' });
    if (proposed.length === 0) {
      return res.status(409).json({
        error: 'No split produced a grounded sentence, so there is nothing honest to write. The framework stands as it is.',
      });
    }

    const version = await store.createRubricVersion(db, {
      projectId: round.projectId,
      name: current.name,
      preamble: current.preamble,
      scale: current.scale,
      criteria: [
        ...current.criteria,
        ...proposed.map((p) => ({ id: newId(), title: 'Added after a split', body: p.text })),
      ],
      parentVersionId: current.id,
      changelog: `Standards v${current.version + 1}: ${proposed.length} sentence${proposed.length === 1 ? '' : 's'} written from the splits of ${round.name || `Round ${round.index}`}.`,
    });
    for (const p of proposed) await store.setPatchStatus(db, p.id, 'accepted', version.id);

    res.status(201).json({ rubric: version, url: `/s/${project.slug}`, sentences: proposed.length, alreadyWritten: false });
  });

  api.get('/rounds/:roundId/patches', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    res.json({ patches: await store.listPatches(db, round.id) });
  });

  /** Accept writes rubric v(n+1) with the patch as a criterion; reject records the decision. */
  api.patch('/rounds/:roundId/patches/:patchId', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const body = z
      .object({ action: z.enum(['accept', 'reject']), text: z.string().min(10).max(600).optional() })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'accept or reject, with optional edited text.' });

    const patch = await store.getPatch(db, req.params.patchId!);
    if (!patch || patch.roundId !== round.id) return res.status(404).json({ error: 'No such patch on this round.' });
    if (patch.status !== 'proposed') return res.status(409).json({ error: `This patch was already ${patch.status}.` });

    if (body.data.action === 'reject') {
      await store.setPatchStatus(db, patch.id, 'rejected', null);
      return res.json({ patch: { ...patch, status: 'rejected' } });
    }

    const current = await store.currentRubric(db, round.projectId);
    if (!current) return res.status(400).json({ error: 'No rubric to patch.' });
    const text = body.data.text ?? patch.text;
    const next = await store.createRubricVersion(db, {
      projectId: round.projectId,
      name: current.name,
      preamble: current.preamble,
      scale: current.scale,
      criteria: [
        ...current.criteria,
        { id: newId(), title: 'From the panel', body: text },
      ],
      parentVersionId: current.id,
      changelog: `From ${round.name}: added "${text}"`,
    });
    await store.setPatchStatus(db, patch.id, 'accepted', next.id);
    res.json({ patch: { ...patch, status: 'accepted', resolvedRubricVersionId: next.id }, rubric: next });
  });

  /**
   * The owner's ten: four contested, four settled, two from the rest, drawn
   * from the round for the user to grade themselves. Blind: no votes ride
   * along. This step is mandatory in the product because a panel can be
   * confidently wrong together, and the false settles it surfaces are the one
   * output only a human can produce.
   */
  api.get('/rounds/:roundId/self-check', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Grade your ten after the panel finishes.' });

    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatIds = new Set(seats.map((s) => s.id));
    const items = await store.listItems(db, round.id);
    const grades = (await store.allGradesForRound(db, round.id)).filter((g) => seatIds.has(g.graderId));
    const byItem = new Map<string, typeof grades>();
    for (const g of grades) byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);

    const readings = items.map((item) => ({
      item,
      reading: readCase(
        item.id,
        (byItem.get(item.id) ?? []).map((g) => ({ seatId: g.graderId, seatName: g.graderId, verdict: g.verdict, reason: g.note })),
      ),
    }));
    const pick = (patterns: string[], n: number, taken: Set<string>) =>
      readings
        .filter((r) => patterns.includes(r.reading.pattern) && !taken.has(r.item.id))
        .slice(0, n)
        .map((r) => r.item);

    const taken = new Set<string>();
    const chosen = [];
    for (const item of pick(['contested', 'persona-driven'], 4, taken)) { taken.add(item.id); chosen.push(item); }
    for (const item of pick(['settled'], 4, taken)) { taken.add(item.id); chosen.push(item); }
    for (const item of pick(['blind-spot', 'settled', 'contested', 'persona-driven'], 2, taken)) { taken.add(item.id); chosen.push(item); }

    const existing = new Map((await store.listUserVerdicts(db, round.id)).map((v) => [v.itemId, v]));
    const cases = [];
    for (const item of chosen) {
      const trace = await store.getTrace(db, item.traceId);
      cases.push({
        itemId: item.id,
        title: trace?.title ?? 'Case',
        content: trace?.content ?? '',
        myVerdict: existing.get(item.id)?.verdict ?? null,
        myReason: existing.get(item.id)?.reason ?? '',
      });
    }
    res.json({ cases, done: cases.filter((c) => c.myVerdict).length });
  });

  api.post('/rounds/:roundId/self-check', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Grade your ten after the panel finishes.' });
    const body = z
      .object({ itemId: z.string().min(1), verdict: z.enum(['pass', 'recoverable', 'fail']), reason: z.string().max(600).default('') })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'A call needs an item and a verdict.' });
    const item = await store.getItem(db, body.data.itemId);
    if (!item || item.roundId !== round.id) return res.status(404).json({ error: 'No such case in this round.' });
    await store.saveUserVerdict(db, { roundId: round.id, itemId: body.data.itemId, verdict: body.data.verdict, reason: body.data.reason });
    res.json({ ok: true });
  });

  /**
   * Who speaks for you, and where the panel was confidently wrong. False
   * settles are the headline: every one is a rubric clause the panel could
   * never have found, because it lives in the owner's head or their business.
   */
  api.get('/rounds/:roundId/alignment', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const userVerdicts = await store.listUserVerdicts(db, round.id);
    if (userVerdicts.length === 0) return res.json({ graded: 0, seats: [], falseSettles: [] });

    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatIds = new Set(seats.map((s) => s.id));
    const grades = (await store.allGradesForRound(db, round.id)).filter((g) => seatIds.has(g.graderId));
    const byItem = new Map<string, typeof grades>();
    for (const g of grades) byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);

    const perSeat = seats.map((seat) => {
      let agree = 0;
      let total = 0;
      for (const uv of userVerdicts) {
        const g = (byItem.get(uv.itemId) ?? []).find((x) => x.graderId === seat.id);
        if (!g) continue;
        total++;
        if (g.verdict === uv.verdict) agree++;
      }
      return { seatId: seat.id, name: seat.name, family: seat.family, agree, total, rate: total ? agree / total : null };
    });

    const falseSettles = [];
    for (const uv of userVerdicts) {
      const votes = (byItem.get(uv.itemId) ?? []);
      const distinct = new Set(votes.map((v) => v.verdict));
      if (votes.length >= 2 && distinct.size === 1 && !distinct.has(uv.verdict)) {
        const item = await store.getItem(db, uv.itemId);
        const trace = item ? await store.getTrace(db, item.traceId) : null;
        falseSettles.push({
          itemId: uv.itemId,
          title: trace?.title ?? 'Case',
          panelVerdict: votes[0]!.verdict,
          yourVerdict: uv.verdict,
          yourReason: uv.reason,
        });
      }
    }
    // The product's honest headline number, recorded on the round: of the
    // cases the panel unanimously settled and the owner checked, what share
    // did the owner overrule?
    const settledChecked = userVerdicts.filter((uv) => {
      const votes = byItem.get(uv.itemId) ?? [];
      return votes.length >= 2 && new Set(votes.map((v) => v.verdict)).size === 1;
    }).length;
    const falseSettleRate = settledChecked === 0 ? null : falseSettles.length / settledChecked;
    await store.setRoundFalseSettleRate(db, round.id, falseSettleRate);

    res.json({
      graded: userVerdicts.length,
      seats: perSeat,
      falseSettles,
      falseSettleRate,
      settledChecked,
      // Benchmarked against what expert humans reach with each other, never
      // against 100 (MT-Bench: human-human expert agreement 81%).
      humanCeiling: 0.81,
    });
  });

  /**
   * Reweight the panel toward the seats that share the owner's taste. Applied
   * to future rounds only; historical rounds keep the weights they ran with,
   * and every change lands in the panel's edit provenance.
   */
  api.post('/rounds/:roundId/reweight', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const userVerdicts = await store.listUserVerdicts(db, round.id);
    if (userVerdicts.length === 0) {
      return res.status(409).json({ error: 'Grade your ten first; reweighting without your verdicts would be circular.' });
    }
    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatIds = new Set(seats.map((s) => s.id));
    const grades = (await store.allGradesForRound(db, round.id)).filter((g) => seatIds.has(g.graderId));
    const byItem = new Map<string, typeof grades>();
    for (const g of grades) byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);

    const changes = [];
    for (const seat of seats) {
      let agree = 0;
      let total = 0;
      for (const uv of userVerdicts) {
        const g = (byItem.get(uv.itemId) ?? []).find((x) => x.graderId === seat.id);
        if (!g) continue;
        total++;
        if (g.verdict === uv.verdict) agree++;
      }
      if (total === 0) continue;
      const weight = Math.max(0.25, Math.round((agree / total) * 100) / 100);
      if (weight !== seat.weight) {
        await store.setSeatWeight(db, seat.id, weight);
        await store.recordPanelEdit(db, {
          projectId: round.projectId,
          seatName: seat.name,
          action: 'reweight',
          before: `weight ${seat.weight}`,
          after: `weight ${weight} (agreed with you on ${agree} of ${total})`,
          note: 'Reweighted toward the seats that share your taste.',
        });
        changes.push({ seat: seat.name, from: seat.weight, to: weight });
      }
    }
    res.json({ changes });
  });

  /**
   * A false settle becomes a rubric patch in one click. The user's own reason
   * is the first quote; the panel's unanimous reason is the second, so even
   * this patch passes the grounding gate rather than being exempt from it.
   */
  api.post('/rounds/:roundId/false-settle-patch', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const body = z.object({ itemId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Which case?' });

    const uv = (await store.listUserVerdicts(db, round.id)).find((v) => v.itemId === body.data.itemId);
    if (!uv) return res.status(404).json({ error: 'You have not graded that case.' });
    if (!uv.reason.trim() || uv.reason.trim().length < 12) {
      return res.status(400).json({ error: 'Write a sentence of reason on your grade first; the patch quotes it verbatim.' });
    }
    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatIds = new Set(seats.map((s) => s.id));
    const seatById = new Map(seats.map((s) => [s.id, s]));
    const votes = (await store.allGradesForRound(db, round.id)).filter(
      (g) => g.itemId === body.data.itemId && seatIds.has(g.graderId),
    );
    const distinct = new Set(votes.map((v) => v.verdict));
    if (votes.length < 2 || distinct.size !== 1 || distinct.has(uv.verdict)) {
      return res.status(409).json({ error: 'That case is not a false settle: the panel did not unanimously disagree with you.' });
    }
    const item = await store.getItem(db, body.data.itemId);
    const trace = item ? await store.getTrace(db, item.traceId) : null;
    const reasonIndex = new Map<string, string>([
      [`${body.data.itemId}|You`, uv.reason.trim()],
      ...votes.map((v) => [`${body.data.itemId}|${seatById.get(v.graderId)?.name ?? 'seat'}`, v.note] as [string, string]),
    ]);
    const evidence = groundEvidence(
      [
        { itemId: body.data.itemId, seat: 'You', quote: uv.reason.trim() },
        { itemId: body.data.itemId, seat: seatById.get(votes[0]!.graderId)?.name ?? 'seat', quote: votes[0]!.note },
      ],
      reasonIndex,
    );
    if (!patchIsGrounded(evidence)) {
      return res.status(400).json({ error: 'Could not ground this patch in the recorded reasons.' });
    }
    const patch = await store.insertPatch(db, {
      projectId: round.projectId,
      roundId: round.id,
      text: `Cases like "${trace?.title ?? 'this one'}" are ${uv.verdict}, not ${votes[0]!.verdict}, because: ${uv.reason.trim()} The panel could not have known this; it is your business, so it belongs in the rubric.`,
      evidence,
      seatsSided: ['You'],
      projectedLift: null,
    });
    res.status(201).json({ patch });
  });

  /**
   * The export bundle: files, not a dashboard. Rubric, golden set, judge
   * prompt, panel config with its edit provenance, and a re-run script.
   */
  api.get('/rounds/:roundId/bundle', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    if (round.status !== 'closed') return res.status(409).json({ error: 'Export a finished round.' });
    const project = (req as ProjectRequest).project;
    const rubric = await store.getRubric(db, round.rubricVersionId);
    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatIds = new Set(seats.map((s) => s.id));
    const items = await store.listItems(db, round.id);
    const grades = (await store.allGradesForRound(db, round.id)).filter((g) => seatIds.has(g.graderId));
    const byItem = new Map<string, typeof grades>();
    for (const g of grades) byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);
    const checked = new Map((await store.listUserVerdicts(db, round.id)).map((v) => [v.itemId, v]));

    const golden = [];
    for (const item of items) {
      const votes = (byItem.get(item.id) ?? []).map((g) => ({
        seatId: g.graderId, seatName: g.graderId, verdict: g.verdict, reason: g.note,
      }));
      const reading = readCase(item.id, votes);
      if (reading.pattern !== 'settled') continue;
      const uv = checked.get(item.id);
      if (uv && uv.verdict !== votes[0]!.verdict) continue; // a false settle is not golden
      const trace = await store.getTrace(db, item.traceId);
      if (!trace) continue;
      golden.push({
        input: trace.content,
        expected: votes[0]!.verdict,
        title: trace.title,
        basis: uv ? 'panel-settled, owner-checked' : 'panel-settled, provisional',
      });
    }

    // An export without its pinned versions would invite comparisons that
    // mean nothing. Refused, not footnoted.
    const pinnedModels = await store.getRoundPinnedModels(db, round.id);
    if (Object.keys(pinnedModels).length === 0) {
      return res.status(409).json({ error: 'This round has no pinned model map, so its bundle cannot be exported honestly.' });
    }
    const cost = await store.costForRound(db, round.id);
    const perSeatCost = [];
    for (const s of seats) {
      const c = await store.costForPanelist(db, round.id, s.id);
      perSeatCost.push({ seat: s.name, credits: c.totalCredits, tokens: c.totalTokens });
    }
    const roundRow = await store.getRound(db, round.id);

    const payload = {
      project: { name: project.name, slug: project.slug },
      rubricMarkdown: rubric ? renderRubricMarkdown(rubric) : '',
      goldenJsonl: golden.map((g) => JSON.stringify(g)).join('\n'),
      judgeSystemPrompt: rubric ? buildJudgeSystemPrompt(rubric) : '',
      panel: seats.map((s) => ({
        name: s.name, objective: s.objective, failsFor: s.failsFor, model: s.model, family: s.family, origin: s.origin, weight: s.weight,
      })),
      pinnedModels,
      cost: { totalCredits: cost.totalCredits, totalTokens: cost.totalTokens, perSeat: perSeatCost },
      falseSettleRate: roundRow?.falseSettleRate ?? null,
      panelEdits: await store.listPanelEdits(db, round.projectId),
      rerunScript: [
        '#!/usr/bin/env bash',
        '# Re-run this eval: same panel, same rubric version, fresh verdicts.',
        '# Set GR_BASE_URL to your deployment and GR_TOKEN to the project key.',
        `ROUND=$(curl -s -X POST "$GR_BASE_URL/api/projects/${project.slug}/panel-rounds" -H "x-gr-token: $GR_TOKEN" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p' | head -1)`,
        'for SEAT in ' + seats.map((s) => s.id).join(' ') + '; do',
        `  curl -s -X POST "$GR_BASE_URL/api/rounds/$ROUND/panel-run" -H "x-gr-token: $GR_TOKEN" -H "content-type: application/json" -d "{\\"seatId\\":\\"$SEAT\\"}" > /dev/null`,
        'done',
        `curl -s "$GR_BASE_URL/api/rounds/$ROUND/map" -H "x-gr-token: $GR_TOKEN"`,
      ].join('\n'),
    };

    const hashes: Record<string, string> = {};
    const artifacts: [string, string][] = [
      ['rubric.md', payload.rubricMarkdown],
      ['golden-set.jsonl', payload.goldenJsonl],
      ['judge-prompt.txt', payload.judgeSystemPrompt],
      ['panel.json', JSON.stringify({ panel: payload.panel, edits: payload.panelEdits, pinnedModels })],
      ['round.json', JSON.stringify({ cost: payload.cost, falseSettleRate: payload.falseSettleRate, pinnedModels })],
      ['rerun.sh', payload.rerunScript],
    ];
    for (const [name, content] of artifacts) {
      const hash = createHash('sha256').update(content).digest('hex');
      hashes[name] = hash;
      await store.recordExport(db, round.id, name, hash);
    }
    res.json({ ...payload, hashes });
  });

  /**
   * The re-run comparison: same cases, two rounds, and the list of cases
   * whose panel outcome flipped. Refused when either round lacks its pinned
   * model map, because an unpinned comparison is not a comparison.
   */
  api.get('/rounds/:roundId/compare/:otherRoundId', requireRound, async (req, res) => {
    const round = (req as Request & { round: Awaited<ReturnType<typeof store.getRound>> }).round!;
    const other = await store.getRound(db, req.params.otherRoundId!);
    if (!other || other.projectId !== round.projectId) return res.status(404).json({ error: 'No such round to compare.' });
    if (round.status !== 'closed' || other.status !== 'closed') {
      return res.status(409).json({ error: 'Both rounds must be finished before comparing.' });
    }
    const pinsA = await store.getRoundPinnedModels(db, round.id);
    const pinsB = await store.getRoundPinnedModels(db, other.id);
    if (Object.keys(pinsA).length === 0 || Object.keys(pinsB).length === 0) {
      return res.status(409).json({ error: 'A round without pinned model versions cannot be compared. Refused, not footnoted.' });
    }

    const seats = (await store.listGraders(db, round.projectId)).filter((g) => g.kind === 'panelist');
    const seatIds = new Set(seats.map((s) => s.id));
    const outcomeByTrace = async (roundId: string) => {
      const items = await store.listItems(db, roundId);
      const grades = (await store.allGradesForRound(db, roundId)).filter((g) => seatIds.has(g.graderId));
      const byItem = new Map<string, string[]>();
      for (const g of grades) byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g.verdict]);
      const out = new Map<string, string>();
      for (const item of items) {
        const votes = byItem.get(item.id) ?? [];
        const distinct = new Set(votes);
        out.set(item.traceId, votes.length >= 2 && distinct.size === 1 ? votes[0]! : 'split');
      }
      return out;
    };
    const a = await outcomeByTrace(round.id);
    const b = await outcomeByTrace(other.id);

    const flips = [];
    let shared = 0;
    for (const [traceId, fromOutcome] of a) {
      if (!b.has(traceId)) continue;
      shared++;
      const toOutcome = b.get(traceId)!;
      if (toOutcome !== fromOutcome) {
        const trace = await store.getTrace(db, traceId);
        flips.push({ traceId, title: trace?.title ?? 'Case', from: fromOutcome, to: toOutcome });
      }
    }
    res.json({
      from: { roundId: round.id, name: round.name, pinnedModels: pinsA },
      to: { roundId: other.id, name: other.name, pinnedModels: pinsB },
      sharedCases: shared,
      flips,
      stable: flips.length === 0,
    });
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
      // The arm is deliberately withheld: a grader who knows an item is held
      // out grades it differently, which is exactly what held out must not be.
      // The probe is withheld for the same reason: it says what the scenario
      // was written to find out, and a voter who reads it has been told which
      // way to look. Import metadata passes through; authoring metadata does not.
      const { probe: _probe, generated: _generated, real: _real, ...visibleMeta } = trace?.meta ?? {};
      return {
        itemId: item.id,
        position: item.position,
        title: trace?.title ?? 'Missing trace',
        content: trace?.content ?? '',
        meta: visibleMeta,
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

  /* ---- The public Standards page ----------------------------------------- */

  /** Owner if the credential opens the project; otherwise public-only access. */
  async function shareAccess(req: Request, project: Project): Promise<'owner' | 'public' | null> {
    const cred = credentialOf(req) ?? (typeof req.body?.k === 'string' ? req.body.k.trim() : '');
    if (cred) {
      if (cred === project.token) return 'owner';
      if (cred.startsWith('gr_') && (await store.projectIdForKeyHash(db, hashKey(cred))) === project.id) return 'owner';
    }
    return project.isPublic ? 'public' : null;
  }

  /** Everything the Standards document renders, assembled from the store. */
  async function standardsView(project: Project, owner: boolean, k: string | null): Promise<StandardsView | null> {
    const version = await store.currentRubric(db, project.id);
    if (!version) return null;
    const parent = version.parentVersionId ? await store.getRubric(db, version.parentVersionId) : null;
    const parentIds = new Set((parent?.criteria ?? []).map((c) => c.id));
    const addedIds = new Set(parent ? version.criteria.filter((c) => !parentIds.has(c.id)).map((c) => c.id) : []);
    const patches = await store.patchesForVersion(db, version.id);
    const seats = (await store.listGraders(db, project.id)).filter((g) => g.kind === 'panelist');

    // Split count from the round the version came from, or the latest closed
    // round when the framework predates its first patch.
    const roundId =
      patches[0]?.roundId ??
      (await store.listRounds(db, project.id)).filter((r) => r.status === 'closed').at(-1)?.id ??
      null;
    let cases = 0;
    let splits = 0;
    if (roundId) {
      const items = await store.listItems(db, roundId);
      cases = items.length;
      const seatIds = new Set(seats.map((s) => s.id));
      const seatName = new Map(seats.map((s) => [s.id, s.name]));
      const grades = (await store.allGradesForRound(db, roundId)).filter((g) => seatIds.has(g.graderId));
      const byItem = new Map<string, SeatVote[]>();
      for (const g of grades) {
        byItem.set(g.itemId, [
          ...(byItem.get(g.itemId) ?? []),
          { seatId: g.graderId, seatName: seatName.get(g.graderId) ?? 'seat', verdict: g.verdict, reason: g.note },
        ]);
      }
      for (const item of items) {
        if (readCase(item.id, byItem.get(item.id) ?? []).pattern !== 'settled') splits++;
      }
    }

    return {
      project: { name: project.name, slug: project.slug, isPublic: project.isPublic },
      version: {
        version: version.version,
        preamble: version.preamble,
        criteria: version.criteria,
        changelog: (version as { changelog?: string }).changelog ?? '',
        createdAt: version.createdAt ?? project.createdAt,
      },
      addedIds,
      patches: patches.map((p) => ({ text: p.text, evidence: p.evidence, seatsSided: p.seatsSided })),
      seats: seats.map((s) => ({ name: s.name, objective: s.objective, failsFor: s.failsFor, model: s.model })),
      stats: {
        cases,
        splits,
        sentences: addedIds.size,
        simulated: seats.length > 0 && seats.every((s) => s.model === 'simulated' || s.family === 'offline'),
      },
      owner,
      k,
    };
  }

  /**
   * The worked example behind the landing's "See a real framework" link: a
   * complete offline pass (seats, blind round, splits, standards v2), seeded
   * once and public. Deliberately the deterministic simulation, whatever keys
   * the server holds: the example must cost nothing, finish in one request,
   * and be labeled simulated on the page.
   */
  const EXAMPLE_SLUG = 'meridian-outfitters';
  async function ensureWorkedExample(): Promise<void> {
    if (await store.getProjectBySlug(db, EXAMPLE_SLUG)) return;
    const project = await store.createProject(db, {
      slug: EXAMPLE_SLUG,
      token: newToken(),
      name: 'Meridian Outfitters support agent',
      description:
        'Meridian Outfitters sells outdoor gear online. The AI answers billing and order questions and can refund up to $50 without approval; anything above $50 goes to a human.',
    });
    const rubric = await store.createRubricVersion(db, {
      projectId: project.id,
      name: 'Your standards',
      preamble: project.description,
      scale: DEFAULT_SCALE,
      criteria: [
        { id: newId(), title: 'Answer first', body: 'The answer to the question asked appears in the first two sentences, before any caveat.' },
        { id: newId(), title: 'The refund line', body: 'Refunds up to $50 are issued without asking; a request above $50 is declined and routed to a human, never improvised.' },
        { id: newId(), title: 'No invented policy', body: 'The agent never states a policy, price, or timeline that is not in the operating documents.' },
      ],
    });
    const scenarios = await offlineScenarist().write({ description: project.description });
    await store.addTraces(
      db,
      project.id,
      scenarios.map((s) => ({ title: s.title, content: s.content, source: 'scenario', meta: { probe: s.probe, generated: true, real: false } })),
    );
    const lit = archetype(REQUIRED_SEAT)!;
    const bench = [lit, ...ARCHETYPES.filter((a) => a.id !== REQUIRED_SEAT).slice(0, 5)];
    const seats = [];
    for (const spec of bench) {
      seats.push(
        await store.insertGrader(db, {
          projectId: project.id,
          name: spec.name,
          kind: 'panelist',
          objective: spec.objective,
          failsFor: spec.failsFor,
          model: 'simulated',
          family: 'offline',
          origin: 'archetype',
          archetypeId: spec.id,
        }),
      );
    }
    const traces = await store.listTraces(db, project.id);
    const { round } = await store.createRound(db, {
      projectId: project.id,
      rubricVersionId: rubric.id,
      name: 'Round 1',
      strategy: 'random',
      seed: newId(),
      samplingNote: 'Worked example: the labeled simulation, every seat over every case.',
      sourceRoundId: null,
      calibration: traces.map((t) => t.id),
      heldout: [],
    });
    await store.setRoundPinnedModels(db, round.id, Object.fromEntries(seats.map((s) => [s.name, 'offline:simulated'])));
    const items = await store.listItems(db, round.id);
    const sim = offlineAdapter();
    const rubricMarkdown = renderRubricMarkdown(rubric);
    for (const seat of seats) {
      for (const item of items) {
        const trace = traces.find((t) => t.id === item.traceId);
        if (!trace) continue;
        const verdict = await sim.score({ seat, rubricMarkdown, caseId: item.traceId, caseTitle: trace.title, caseContent: trace.content });
        await store.submitGrade(db, { itemId: item.id, graderId: seat.id, verdict: verdict.verdict, note: verdict.reason, outputLength: trace.content.length });
      }
    }
    await store.closeRound(db, round.id);
    const { stored } = await minePatchesForRound((await store.getRound(db, round.id))!);
    const proposed = stored.filter((p) => p.status === 'proposed');
    if (proposed.length > 0) {
      const version = await store.createRubricVersion(db, {
        projectId: project.id,
        name: rubric.name,
        preamble: rubric.preamble,
        scale: rubric.scale,
        criteria: [...rubric.criteria, ...proposed.map((p) => ({ id: newId(), title: 'Added after a split', body: p.text }))],
        parentVersionId: rubric.id,
        changelog: `Standards v2: ${proposed.length} sentences written from the splits of Round 1.`,
      });
      for (const p of proposed) await store.setPatchStatus(db, p.id, 'accepted', version.id);
    }
    await store.setProjectPublic(db, project.id, true);
  }

  app.get('/s/example', async (_req, res) => {
    try {
      await ensureWorkedExample();
      res.redirect(`/s/${EXAMPLE_SLUG}`);
    } catch {
      res.status(503).type('text/plain').send('The example could not be seeded right now.');
    }
  });

  app.get('/s/:slug', async (req, res) => {
    const project = await store.getProjectBySlug(db, req.params.slug!);
    const access = project ? await shareAccess(req, project) : null;
    if (!project || !access) {
      return res.status(404).type('text/plain').send('This Standards page is private or does not exist.');
    }
    const k = access === 'owner' ? (credentialOf(req) ?? null) : null;
    const view = await standardsView(project, access === 'owner', k);
    if (!view) return res.status(404).type('text/plain').send('This project has no standards yet.');
    const proto = req.header('x-forwarded-proto') ?? req.protocol;
    res.type('html').send(renderStandardsPage(view, `${proto}://${req.get('host')}`));
  });

  app.get('/s/:slug/og.svg', async (req, res) => {
    const project = await store.getProjectBySlug(db, req.params.slug!);
    const access = project ? await shareAccess(req, project) : null;
    if (!project || !access) return res.status(404).end();
    const view = await standardsView(project, false, null);
    if (!view) return res.status(404).end();
    res.type('image/svg+xml').send(renderOgSvg(view));
  });

  app.post('/s/:slug/visibility', async (req, res) => {
    const project = await store.getProjectBySlug(db, req.params.slug!);
    if (!project) return res.status(404).type('text/plain').send('No such project.');
    if ((await shareAccess(req, project)) !== 'owner') {
      return res.status(403).type('text/plain').send('Only the key that owns this project can change its visibility.');
    }
    const makePublic = req.body?.public === '1' || req.body?.public === true;
    await store.setProjectPublic(db, project.id, makePublic);
    const k = typeof req.body?.k === 'string' ? req.body.k : '';
    res.redirect(`/s/${project.slug}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
  });

  // One router, two mounts. /api/v1 is the versioned surface agents build
  // against; /api is what the bundled UI calls. Because they are literally
  // the same router, a fix cannot land on one and miss the other.
  app.use('/api/v1', api);
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
