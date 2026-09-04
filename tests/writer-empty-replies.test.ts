/**
 * "The writer did not return JSON after two attempts (the reply was empty)."
 *
 * Both writers failed with that line while the router answered 200 with a
 * body, because the gateway read one field and treated every other shape as
 * an empty string. These pin down each shape the router actually sends, and
 * that a failure names its stage: the call or the parse.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { callModel, readReply, resetLearnedCapabilities, type GatewayTransport } from '../server/gateway.js';
import { openrouterJson } from '../server/openrouter.js';
import { DrafterError } from '../server/drafter.js';

const ok = (json: unknown): GatewayTransport => ({ post: async () => ({ status: 200, json }) });

const scripted = (replies: unknown[]): { transport: GatewayTransport; sent: object[] } => {
  const sent: object[] = [];
  return {
    sent,
    transport: {
      post: async (body) => {
        sent.push(body);
        return { status: 200, json: replies[Math.min(sent.length - 1, replies.length - 1)] };
      },
    },
  };
};

const req = { pin_id: 'anthropic-frontier-1', messages: [{ role: 'user' as const, content: 'x' }], caller: { kind: 'creator' as const } };
const env = { apiKey: 'k', sleep: async () => undefined };

beforeEach(() => resetLearnedCapabilities());

describe('readReply reads every shape a 200 arrives in', () => {
  it('plain string content', () => {
    expect(readReply({ choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }] })).toEqual({ text: '{"a":1}', finish_reason: 'stop', error: null });
  });

  it('content as an array of parts', () => {
    const r = readReply({ choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }] });
    expect(r.text).toBe('{"a":1}');
    expect(r.error).toBeNull();
  });

  it('a structured reply delivered as a tool call', () => {
    const r = readReply({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: 'result', arguments: '{"seats":[]}' } }] } }] });
    expect(r.text).toBe('{"seats":[]}');
    expect(r.error).toBeNull();
  });

  it('a top-level error under a 200 is an error, in the router’s words', () => {
    const r = readReply({ error: { message: 'Provider returned error', code: 502, metadata: { raw: 'overloaded' } }, choices: [] });
    expect(r.text).toBe('');
    expect(r.error).toContain('Provider returned error');
    expect(r.error).toContain('overloaded');
  });

  it('a choice-level error with finish_reason error', () => {
    const r = readReply({ choices: [{ finish_reason: 'error', error: { message: 'upstream timed out' }, message: { content: '' } }] });
    expect(r.error).toBe('upstream timed out');
    expect(r.finish_reason).toBe('error');
  });

  it('a 200 whose body was not JSON quotes the body and its content type', () => {
    const r = readReply({ non_json_body: '<html><body>502 Bad Gateway</body></html>', content_type: 'text/html' });
    expect(r.error).toContain('not JSON (text/html)');
    expect(r.error).toContain('502 Bad Gateway');
  });

  it('an error object without a message is still an error, with the object quoted', () => {
    const r = readReply({ error: { code: 400, type: 'invalid_request' } });
    expect(r.error).toContain('without a message');
    expect(r.error).toContain('invalid_request');
  });

  it('no choices names the keys that were there instead', () => {
    expect(readReply({ id: 'gen-1', object: 'chat.completion' }).error).toContain('body keys: id, object');
  });

  it('a refusal is an error, not an empty answer', () => {
    expect(readReply({ choices: [{ message: { content: '', refusal: 'I cannot help with that.' } }] }).error).toContain('refused');
  });
});

describe('callModel turns a 200 with no answer into a failed call', () => {
  it('quotes the router error instead of returning empty text', async () => {
    const res = await callModel(req, { ...env, transport: ok({ error: { message: 'Provider returned error' }, choices: [] }) });
    expect(res.error?.kind).toBe('provider_error');
    expect(res.error?.message).toContain('Provider returned error');
    expect(res.error?.message).toContain('anthropic/claude-opus-5');
  });

  it('quotes the body when the reply is blank with no explanation', async () => {
    const res = await callModel(req, { ...env, transport: ok({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }) });
    expect(res.error?.kind).toBe('provider_error');
    expect(res.error?.message).toMatch(/no text/);
    expect(res.error?.message).toContain('finish_reason=stop');
    expect(res.error?.message).toContain('"choices"');
  });

  it('records the attempt as a provider error, not a success', async () => {
    const rows: { error_kind: string | null }[] = [];
    await callModel(req, { ...env, transport: ok({ choices: [{ message: { content: '' } }] }), recorder: async (a) => { rows.push(a); } });
    expect(rows.map((r) => r.error_kind)).toEqual(['provider_error']);
  });

  it('flags a reply cut off at max_tokens', async () => {
    const res = await callModel(req, { ...env, transport: ok({ choices: [{ finish_reason: 'length', message: { content: '{"seats":[{"name":"The imp' } }], usage: { completion_tokens: 4096 } }) });
    expect(res.error).toBeUndefined();
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('The imp');
  });
});

describe('openrouterJson names the stage that failed', () => {
  it('a router-side failure is a call failure, and is not re-asked as-is', async () => {
    const s = scripted([{ error: { message: 'Provider returned error', metadata: { raw: 'overloaded' } }, choices: [] }]);
    const err = await openrouterJson({ system: 's', user: 'u', schema: { type: 'object', properties: {}, additionalProperties: false, required: [] }, gateway: { ...env, transport: s.transport } }).catch((e: Error) => e) as Error;
    expect(err).toBeInstanceOf(DrafterError);
    expect(err.message).toMatch(/^Model call failed: /);
    expect(err.message).toContain('overloaded');
    // The gateway retries 429/5xx itself; a 200 carrying an error is final, so
    // exactly one request went out and nothing was re-sent unchanged.
    expect(s.sent).toHaveLength(1);
  });

  it('a truncated reply is a call failure that names max_tokens', async () => {
    const s = scripted([{ choices: [{ finish_reason: 'length', message: { content: '{"seats":[' } }], usage: { completion_tokens: 512 } }]);
    const err = await openrouterJson({ system: 's', user: 'u', maxTokens: 512, gateway: { ...env, transport: s.transport } }).catch((e: Error) => e) as Error;
    expect(err.message).toMatch(/^Model call failed: .*cut off at max_tokens=512/);
    expect(s.sent).toHaveLength(1);
  });

  it('prose that never becomes JSON is a parse failure that quotes the reply', async () => {
    const s = scripted([{ choices: [{ finish_reason: 'stop', message: { content: 'Sure! Here you go, but in prose.' } }] }]);
    const err = await openrouterJson({ system: 's', user: 'u', gateway: { ...env, transport: s.transport } }).catch((e: Error) => e) as Error;
    expect(err.message).toMatch(/^Parse failed: /);
    expect(err.message).toContain('Sure! Here you go');
    expect(s.sent).toHaveLength(2);
  });

  it('a tool-call reply parses like any other', async () => {
    const s = scripted([{ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { arguments: '{"seats":[{"name":"x"}]}' } }] } }] }]);
    const value = await openrouterJson<{ seats: { name: string }[] }>({ system: 's', user: 'u', gateway: { ...env, transport: s.transport } });
    expect(value.seats[0]?.name).toBe('x');
    expect(s.sent).toHaveLength(1);
  });
});
