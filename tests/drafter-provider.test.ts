/**
 * The drafter, exercised against a scripted router.
 *
 * Everything in `openrouterDrafter` only runs when a key is set, which means
 * it only runs in production unless something stands in for the service. The
 * gateway's fake transport does that: it speaks the router's response shape,
 * so the request body, the schema contract, the retry ladder and the failure
 * translation are all exercised without a network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeTransport } from '../server/gateway.js';
import { CREATOR_PIN } from '../server/openrouter.js';
import { DrafterError, resolveDrafter } from '../server/drafter.js';
import { MAX_QUESTIONS } from '../shared/drafting.js';

const saved = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'or-test';
});

afterEach(() => {
  if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved;
});

const REQUEST = {
  description: 'A support agent that answers billing questions and refunds up to $50.',
  examples: [],
  documents: [],
};

const GOOD_DRAFT = JSON.stringify({
  name: 'Rubric v1',
  preamble: 'Grade the agent on what it did.',
  scale: [
    { id: 'fail', label: 'fail', rank: 0, description: 'no' },
    { id: 'pass', label: 'pass', rank: 1, description: 'yes' },
  ],
  criteria: [{ id: 'c1', title: 'Answer first', body: 'The answer comes first.' }],
  conflicts: [],
  openQuestions: [{ id: 'q1', question: 'What counts as partial?', why: 'Teams split here.' }],
});

describe('the drafter through the router', () => {
  it('drafts from a well-formed reply', async () => {
    const drafter = resolveDrafter();
    expect(drafter.real).toBe(true);
    const draft = await drafter.draft(REQUEST, {
      transport: fakeTransport([{ pin_id: CREATOR_PIN, text: GOOD_DRAFT }]),
    });
    expect(draft.criteria[0]!.body).toBe('The answer comes first.');
    expect(draft.openQuestions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it('turns a router error into a typed drafter error, never a raw failure', async () => {
    const drafter = resolveDrafter();
    await expect(
      drafter.draft(REQUEST, {
        transport: fakeTransport([{ pin_id: CREATOR_PIN, text: GOOD_DRAFT, status: 401 }]),
      }),
    ).rejects.toBeInstanceOf(DrafterError);
  });

  it('reports unparseable output as a parse failure rather than an empty rubric', async () => {
    const drafter = resolveDrafter();
    const error = await drafter
      .draft(REQUEST, { transport: fakeTransport([{ pin_id: CREATOR_PIN, text: 'not json at all' }]) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrafterError);
    expect((error as DrafterError).code).toBe('parse');
  });

  it('retries a rate limit and succeeds, rather than surfacing the first 429', async () => {
    const drafter = resolveDrafter();
    const draft = await drafter.draft(REQUEST, {
      transport: fakeTransport([{ pin_id: CREATOR_PIN, text: GOOD_DRAFT, failFirst: 2, status: 429 }]),
      sleep: async () => undefined,
    });
    expect(draft.criteria.length).toBe(1);
  });

  it('falls back to the honest skeleton with no key, and never invents criteria', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const drafter = resolveDrafter();
    expect(drafter.real).toBe(false);
    const draft = await drafter.draft(REQUEST);
    expect(draft.criteria).toEqual([]);
    expect(draft.openQuestions.length).toBeGreaterThan(0);
  });
});
