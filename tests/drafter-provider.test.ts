/**
 * The Anthropic drafter, exercised against a stand-in API.
 *
 * Everything in `anthropicDrafter` only runs when a key is set, which means it
 * only runs in production unless something like this stands in for the service.
 * The server here speaks just enough of the Messages API to drive the request
 * shape, the refusal path, and the parse failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DrafterError, resolveDrafter } from '../server/drafter.js';
import { MAX_QUESTIONS } from '../shared/drafting.js';

let server: Server;
let received: { path: string; body: Record<string, unknown> } | null = null;
let reply: { status: number; body: unknown } = { status: 200, body: {} };

const savedEnv = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };

function message(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

beforeEach(async () => {
  received = null;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received = { path: req.url ?? '', body: raw ? JSON.parse(raw) : {} };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.key;
  if (savedEnv.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedEnv.base;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const request = {
  description: 'A support agent that issues refunds.',
  examples: [{ title: 'Refund approved', content: 'user: refund please' }],
};

describe('the anthropic drafter', () => {
  it('is chosen over the offline provider once a key is set', () => {
    expect(resolveDrafter().real).toBe(true);
  });

  it('sends the rubric, the transcripts, and a schema that constrains the answer', async () => {
    reply = {
      status: 200,
      body: message(
        JSON.stringify({
          name: 'Refund rubric',
          preamble: 'Decide whether the refund was handled.',
          scale: [{ label: 'fail' }, { label: 'partial' }, { label: 'pass' }],
          criteria: [{ title: 'Names the amount', body: 'The agent states the refunded amount.' }],
          openQuestions: [{ question: 'Is an escalation a pass?', why: 'Only one example escalates.' }],
        }),
      ),
    };

    const draft = await resolveDrafter('claude-opus-5').draft(request);

    expect(received?.path).toContain('/v1/messages');
    expect(received?.body.model).toBe('claude-opus-5');
    expect(String(received?.body.system)).toMatch(/never write a criterion that is really a question/i);
    expect(JSON.stringify(received?.body.messages)).toContain('user: refund please');

    const schema = (received?.body.output_config as { format: { schema: { properties: Record<string, unknown> } } })
      .format.schema;
    expect(Object.keys(schema.properties)).toContain('openQuestions');
    expect((schema.properties.openQuestions as { maxItems: number }).maxItems).toBe(MAX_QUESTIONS);

    expect(draft.name).toBe('Refund rubric');
    expect(draft.scale.map((s) => s.rank)).toEqual([0, 1, 2]);
    expect(draft.openQuestions[0]!.id).toBe('q1');
  });

  it('turns a refusal into an error rather than an empty rubric', async () => {
    reply = { status: 200, body: message('', 'refusal') };
    await expect(resolveDrafter().draft(request)).rejects.toMatchObject({ code: 'refusal' });
  });

  it('reports unparseable output instead of returning a blank draft', async () => {
    reply = { status: 200, body: message('I have decided not to use JSON today.') };
    await expect(resolveDrafter().draft(request)).rejects.toMatchObject({ code: 'parse' });
  });

  it('names a rejected key rather than surfacing an SDK stack trace', async () => {
    reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'nope' } } };
    const error = await resolveDrafter()
      .draft(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrafterError);
    expect((error as DrafterError).code).toBe('auth');
    expect((error as DrafterError).message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('tells the team to wait rather than retrying into the same limit', async () => {
    reply = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } };
    await expect(resolveDrafter().draft(request)).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
