/**
 * Tacit as a tool an agent can operate.
 *
 * An agent is a real user of this product. It can read a company's policies,
 * pull transcripts, draft a rubric, open a round and read the report — all of
 * which is ordinary operation with no methodological hazard.
 *
 * There is one thing it deliberately cannot do, and the omission is the whole
 * design of this file: **an agent cannot join a round as a grader.**
 *
 * The product's central number is agreement between independent human raters.
 * If a model quietly becomes one of those raters, "your team agreed 72% of the
 * time" turns into "two people and a language model agreed 72% of the time",
 * which is a different claim that nobody asked for and no caller would notice.
 * The API is happy to let anything join with any name, so the guard has to live
 * where the agent actually is — here.
 *
 * Agents that want a model's verdicts have a correct path already: `run_judge`
 * builds a judge from the rubric and scores it *against* the humans on cases it
 * has not seen. Scored against, never counted among. That is the same
 * distinction the rest of the product makes between `graders` and `judge_runs`,
 * and this server refuses to blur it.
 *
 * Talks to the HTTP API rather than the database, so the same server works
 * against a local dev instance or the deployed one — point GR_BASE_URL at
 * whichever.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.GR_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['x-gr-token'] = opts.token;

  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text || res.statusText);
    return text as unknown as T;
  }

  const parsed = await res.json();
  if (!res.ok) throw new ApiError(res.status, parsed?.error ?? res.statusText);
  return parsed as T;
}

/** Tool results are read by a model, so they are JSON it can act on rather than prose. */
function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const project = {
  slug: z.string().min(1).describe('Project slug, from create_project or the shared link.'),
  token: z.string().min(1).describe('Project token, from create_project or the ?k= in the shared link.'),
};

export function buildServer() {
  const server = new McpServer({ name: 'grading-room', version: '1.0.0' });

  server.registerTool(
    'create_project',
    {
      title: 'Create a project',
      description:
        'Start an eval project for a company. Pass a description of what the company does and what its AI handles — scenarios for the team poll are written from it automatically. Returns a slug and token; the token is the only credential.',
      inputSchema: {
        name: z.string().min(1).max(120).describe('The company or team, e.g. "Acme support".'),
        description: z
          .string()
          .max(2000)
          .default('')
          .describe('What the company does and what its AI is supposed to handle. Ten or more characters triggers automatic scenario writing.'),
      },
    },
    async ({ name, description }) => {
      try {
        const made = await call<{
          project: { slug: string; token: string; name: string };
          scenarioCount: number;
        }>('/projects', { method: 'POST', body: { name, description } });
        return result({
          slug: made.project.slug,
          token: made.project.token,
          shareLink: `${BASE}/p/${made.project.slug}?k=${made.project.token}`,
          scenariosWritten: made.scenarioCount,
          next:
            made.scenarioCount > 0
              ? 'Scenarios are ready. Open a poll with create_round and send the grade link to the team.'
              : 'Add operating documents, then generate_scenarios, then open a poll with create_round.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'add_operating_documents',
    {
      title: 'Add written operating rules',
      description:
        'Add the policies, procedures and decision records that already say how this company decides things. These are read to draft the rubric and are never graded.',
      inputSchema: {
        ...project,
        documents: z
          .array(
            z.object({
              title: z.string().min(1),
              kind: z.enum(['policy', 'sop', 'decision', 'other']).default('policy'),
              content: z.string().min(1).describe('The document text, verbatim. Do not summarise it.'),
            }),
          )
          .min(1),
      },
    },
    async ({ slug, token, documents }) => {
      try {
        const added = await call<{ documents: { id: string; title: string }[] }>(`/projects/${slug}/documents`, {
          method: 'POST',
          token,
          body: { documents },
        });
        return result({ added: added.documents.map((d) => ({ id: d.id, title: d.title })) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'add_traces',
    {
      title: 'Add conversations to grade',
      description:
        'Add agent transcripts. These are the cases people will grade — what actually happened, as against what the documents claim.',
      inputSchema: {
        ...project,
        traces: z.array(z.object({ title: z.string().default(''), content: z.string().min(1) })).min(1),
      },
    },
    async ({ slug, token, traces }) => {
      try {
        const added = await call<{ traces: { id: string }[] }>(`/projects/${slug}/traces`, {
          method: 'POST',
          token,
          body: { traces },
        });
        return result({ added: added.traces.length });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'draft_rubric',
    {
      title: 'Translate the operating rules into a rubric',
      description:
        'Turn the documents (and any transcripts) into a gradable rubric. Every rule lands in exactly one of three places: a criterion quoting the sentence it came from, a conflict that contradicts another rule or cannot be checked from a transcript, or an open question the documents never cover. Nothing is written until save_rubric.',
      inputSchema: {
        ...project,
        description: z.string().min(10).max(2000).describe('One or two sentences on what the agent is supposed to do.'),
        documentIds: z.array(z.string()).optional().describe('Omit to use every document in the project.'),
        traceIds: z.array(z.string()).optional(),
      },
    },
    async ({ slug, token, description, documentIds, traceIds }) => {
      try {
        const docs =
          documentIds ??
          (await call<{ documents: { id: string }[] }>(`/projects/${slug}/documents`, { token })).documents.map(
            (d) => d.id,
          );
        const draft = await call<Record<string, unknown>>(`/projects/${slug}/rubric/draft`, {
          method: 'POST',
          token,
          body: { description, documentIds: docs, traceIds: traceIds ?? [] },
        });
        return result({
          ...draft,
          next: 'Review the conflicts with a human before calling save_rubric. They are unreconciled on purpose.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'save_rubric',
    {
      title: 'Save a rubric version',
      description:
        'Store a rubric. Pass the draft back through unchanged unless a human has edited it. A version a round has already used is immutable — saving forks a new one.',
      inputSchema: {
        ...project,
        name: z.string().min(1),
        preamble: z.string().default(''),
        scale: z.array(z.object({ id: z.string(), label: z.string(), rank: z.number().int() })).optional(),
        criteria: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              body: z.string().default(''),
              source: z.object({ document: z.string(), quote: z.string() }).nullable().optional(),
            }),
          )
          .optional(),
        openQuestions: z
          .array(z.object({ id: z.string(), question: z.string(), why: z.string().default('') }))
          .optional(),
        conflicts: z
          .array(
            z.object({
              id: z.string(),
              kind: z.enum(['contradiction', 'untestable']),
              statement: z.string(),
              detail: z.string().default(''),
              documents: z.array(z.string()).default([]),
            }),
          )
          .optional(),
      },
    },
    async ({ slug, token, ...patch }) => {
      try {
        const saved = await call<{ rubric: { id: string; version: number }; forked: boolean }>(
          `/projects/${slug}/rubric`,
          { method: 'PUT', token, body: patch },
        );
        return result({ rubricId: saved.rubric.id, version: saved.rubric.version, forked: saved.forked });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'generate_scenarios',
    {
      title: 'Write the poll scenarios',
      description:
        'Generate concrete situations for the team to vote on, from the project description and its operating documents. Scenarios never contain their own answer. They are saved immediately and can be removed before polling.',
      inputSchema: {
        ...project,
        description: z.string().min(10).max(2000).describe('What the AI under evaluation is supposed to do.'),
        count: z.number().int().min(4).max(16).optional(),
      },
    },
    async ({ slug, token, description, count }) => {
      try {
        const made = await call<Record<string, unknown>>(`/projects/${slug}/scenarios`, {
          method: 'POST',
          token,
          body: { description, count },
        });
        return result({ ...made, next: 'Open a poll with create_round, then send the grade link to the team.' });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'export_evalset',
    {
      title: 'Export the eval set',
      description:
        'Extract test cases from a closed poll. Unanimous votes and settled disagreements become cases; live disagreement is excluded rather than averaged; held-back scenarios never export. Format json includes the judge prompt; jsonl is one case per line for eval harnesses.',
      inputSchema: {
        ...project,
        roundId: z.string().min(1),
        format: z.enum(['json', 'jsonl']).default('json'),
      },
    },
    async ({ token, roundId, format }) => {
      try {
        const out = await call<unknown>(`/rounds/${roundId}/evalset?format=${format}`, { token });
        if (typeof out === 'string') return { content: [{ type: 'text' as const, text: out }] };
        return result(out);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'create_round',
    {
      title: 'Open a grading round',
      description:
        'Open a blind round over a sample. Then send the share link to at least two people — a round cannot close with fewer than two graders, because agreement is not defined for one.',
      inputSchema: {
        ...project,
        calibrationSize: z.number().int().min(1).default(8).describe('Cases used to fix the rubric.'),
        heldoutSize: z.number().int().min(0).default(4).describe('Cases never discussed, used to measure improvement.'),
        strategy: z.enum(['random', 'from_splits']).default('random'),
        sourceRoundId: z.string().nullable().optional().describe('Required when strategy is from_splits.'),
        reuseHeldout: z.boolean().default(true).describe('Keep the same held-out cases so before and after compare.'),
      },
    },
    async ({ slug, token, ...body }) => {
      try {
        const made = await call<{ round: { id: string; name: string } }>(`/projects/${slug}/rounds`, {
          method: 'POST',
          token,
          body,
        });
        return result({
          roundId: made.round.id,
          name: made.round.name,
          gradeLink: `${BASE}/p/${slug}/grade/${made.round.id}?k=${token}`,
          next: 'Send gradeLink to the people who will grade. You cannot grade it yourself — see why in the server description.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'close_round',
    {
      title: 'Close a round',
      description:
        'Stop accepting grades and unlock the report. Only do this when everyone has finished — the number is computed from whatever was submitted.',
      inputSchema: { ...project, roundId: z.string().min(1) },
    },
    async ({ token, roundId }) => {
      try {
        return result(await call(`/rounds/${roundId}/close`, { method: 'POST', token }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_report',
    {
      title: 'Read a closed round',
      description:
        'The disagreements first, then the agreement statistics and their caveats. Only works on a closed round: while a round is open no endpoint will return another grader\'s verdict.',
      inputSchema: { ...project, roundId: z.string().min(1) },
    },
    async ({ token, roundId }) => {
      try {
        const report = await call<Record<string, unknown>>(`/rounds/${roundId}/report`, { token });
        return result(report);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_trajectory',
    {
      title: 'Did calibration actually help?',
      description:
        'Held-out agreement across rounds. Reports rounds as incomparable rather than plotting a delta when the held-out set or the panel changed, because then the difference is measuring something other than the rubric.',
      inputSchema: { ...project },
    },
    async ({ slug, token }) => {
      try {
        return result(await call(`/projects/${slug}/trajectory`, { token }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'run_judge',
    {
      title: 'Score a model against the humans',
      description:
        'Build an LLM judge from a rubric version and grade a closed round with it. This is how a model gets to produce verdicts here: scored against the human panel on cases it has not seen, never counted as one of them. Capped at 40 items per run.',
      inputSchema: {
        ...project,
        roundId: z.string().min(1),
        rubricVersionId: z.string().min(1),
        arm: z.enum(['calibration', 'heldout']).default('heldout'),
      },
    },
    async ({ token, roundId, rubricVersionId, arm }) => {
      try {
        await call(`/rounds/${roundId}/judge`, { method: 'POST', token, body: { rubricVersionId, arm } });
        return result(await call(`/rounds/${roundId}/judge`, { token }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'export_rubric',
    {
      title: 'Export a rubric',
      description:
        'Get a rubric as markdown (for people, including its conflicts and open questions), as JSON, or as the judge prompt built from it.',
      inputSchema: {
        ...project,
        rubricId: z.string().min(1),
        format: z.enum(['md', 'json', 'judge']).default('md'),
      },
    },
    async ({ token, rubricId, format }) => {
      try {
        const text = await call<string>(`/rubrics/${rubricId}/export?format=${format}`, { token });
        return { content: [{ type: 'text' as const, text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

/* c8 ignore start — process wiring, exercised by the integration test via buildServer */
if (process.env.GR_MCP_NO_LISTEN !== '1') {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
/* c8 ignore stop */
