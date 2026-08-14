/**
 * The MCP server, driven the way an agent drives it: in-memory client and
 * server joined by a transport pair, talking to a real API over real HTTP.
 *
 * The load-bearing test is the last one. An agent must not be able to become a
 * grader, because the product's central number is agreement between independent
 * humans and a model quietly joining that panel changes what the number means
 * without changing what it is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';

let http: Server;
let client: Client;

beforeAll(async () => {
  const db = await openDb(':memory:');
  http = createServer(createApp(db));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  process.env.GR_BASE_URL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  process.env.GR_MCP_NO_LISTEN = '1';

  const { buildServer } = await import('../mcp/server.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([buildServer().connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((r) => http.close(() => r()));
});

/** Tool results come back as JSON text, which is what an agent parses. */
async function callTool(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content.map((c) => c.text).join('');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* markdown and judge prompts come back as prose */
  }
  return { isError: res.isError === true, text, data: parsed as Record<string, unknown> };
}

describe('an agent operating the product end to end', () => {
  const state: Record<string, string> = {};

  it('creates a project and gets back a share link', async () => {
    const res = await callTool('create_project', { name: 'Refund agent' });
    expect(res.isError).toBe(false);
    expect(res.data.slug).toBeTruthy();
    expect(res.data.shareLink).toContain(String(res.data.slug));
    state.slug = String(res.data.slug);
    state.token = String(res.data.token);
  });

  it('takes the written rules and the conversations separately', async () => {
    const docs = await callTool('add_operating_documents', {
      slug: state.slug,
      token: state.token,
      documents: [
        { title: 'Refund policy', kind: 'policy', content: 'Refunds under $50 need no approval.' },
        { title: 'Escalation SOP', kind: 'sop', content: 'Anything over $100 goes to a human.' },
      ],
    });
    expect(docs.isError).toBe(false);
    expect((docs.data.added as unknown[]).length).toBe(2);

    const traces = await callTool('add_traces', {
      slug: state.slug,
      token: state.token,
      traces: Array.from({ length: 6 }, (_, i) => ({ title: `Call ${i + 1}`, content: `user: refund ${i}` })),
    });
    expect(traces.isError).toBe(false);
    expect(traces.data.added).toBe(6);
  });

  it('drafts a rubric from every document without being told their ids', async () => {
    const res = await callTool('draft_rubric', {
      slug: state.slug,
      token: state.token,
      description: 'A support agent that answers billing questions and can issue refunds.',
    });
    expect(res.isError).toBe(false);
    const from = res.data.draftedFrom as { documentCount: number };
    expect(from.documentCount).toBe(2);
    expect(res.data.next).toMatch(/conflicts/i);

    const draft = res.data.draft as { name: string; scale: unknown[] };
    const saved = await callTool('save_rubric', {
      slug: state.slug,
      token: state.token,
      name: draft.name,
      ...(res.data.draft as Record<string, unknown>),
    });
    expect(saved.isError).toBe(false);
    state.rubricId = String(saved.data.rubricId);
  });

  it('opens a round and hands back a link for people to grade', async () => {
    const res = await callTool('create_round', {
      slug: state.slug,
      token: state.token,
      calibrationSize: 4,
      heldoutSize: 2,
    });
    expect(res.isError).toBe(false);
    expect(res.data.gradeLink).toContain(String(res.data.roundId));
    expect(res.data.next).toMatch(/cannot grade it yourself/i);
    state.roundId = String(res.data.roundId);
  });

  it('will not show a report while the round is still open', async () => {
    const res = await callTool('get_report', { slug: state.slug, token: state.token, roundId: state.roundId });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/still open/i);
    expect(res.text).toMatch(/hidden until it closes/i);
  });

  it('surfaces an API refusal as a tool error rather than a silent empty result', async () => {
    const res = await callTool('add_operating_documents', {
      slug: state.slug,
      token: 'wrong-token',
      documents: [{ title: 'x', kind: 'policy', content: 'y' }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/key/i);
  });

  it('exports the rubric as markdown for people', async () => {
    const res = await callTool('export_rubric', {
      slug: state.slug,
      token: state.token,
      rubricId: state.rubricId,
      format: 'md',
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('## Verdict scale');
  });
});

describe('what the agent is deliberately not given', () => {
  it('exposes no way to join a panel or submit a verdict', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    // If any of these ever appear, a model can be counted as one of the human
    // raters and the agreement statistic silently changes meaning.
    for (const forbidden of ['join_grader', 'add_grader', 'submit_grade', 'grade_trace', 'grade']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names.some((n) => /grade|grader|verdict/.test(n))).toBe(false);
  });

  it('offers run_judge as the sanctioned way for a model to produce verdicts', async () => {
    const { tools } = await client.listTools();
    const judge = tools.find((t) => t.name === 'run_judge');
    expect(judge).toBeDefined();
    // The description has to carry the distinction, because the description is
    // the only thing the calling model reads before choosing a tool.
    expect(judge!.description).toMatch(/scored against/i);
    expect(judge!.description).toMatch(/never counted as one of them/i);
  });

  it('names every tool it does expose, so the surface is reviewable', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_operating_documents',
      'add_traces',
      'close_round',
      'create_project',
      'create_round',
      'draft_rubric',
      'export_evalset',
      'export_rubric',
      'generate_scenarios',
      'get_report',
      'get_trajectory',
      'run_judge',
      'save_rubric',
    ]);
  });
});
