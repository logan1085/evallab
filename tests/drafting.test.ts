import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CHAR_BUDGET,
  EXAMPLE_CHAR_BUDGET,
  MAX_CONFLICTS,
  prepareDocuments,
  MAX_CRITERIA,
  MAX_DRAFT_EXAMPLES,
  MAX_QUESTIONS,
  buildDrafterSystemPrompt,
  buildDrafterUserPrompt,
  normalizeDraft,
  prepareExamples,
} from '../shared/drafting.js';
import { DEFAULT_SCALE } from '../shared/types.js';

describe('prepareExamples', () => {
  it('leaves short examples alone and reports no truncation', () => {
    const { examples, truncated } = prepareExamples([{ title: 'A', content: 'short' }]);
    expect(examples).toEqual([{ title: 'A', content: 'short' }]);
    expect(truncated).toBe(false);
  });

  it('trims a long transcript and says it did', () => {
    const { examples, truncated } = prepareExamples([{ title: 'A', content: 'x'.repeat(EXAMPLE_CHAR_BUDGET + 500) }]);
    expect(truncated).toBe(true);
    expect(examples[0]!.content).toContain('transcript trimmed to fit');
    expect(examples[0]!.content.length).toBeLessThan(EXAMPLE_CHAR_BUDGET + 100);
  });

  it('caps the number of examples and says it did', () => {
    const many = Array.from({ length: MAX_DRAFT_EXAMPLES + 4 }, (_, i) => ({ title: `T${i}`, content: 'body' }));
    const { examples, truncated } = prepareExamples(many);
    expect(examples).toHaveLength(MAX_DRAFT_EXAMPLES);
    expect(truncated).toBe(true);
  });
});

describe('normalizeDraft', () => {
  it('assigns ranks from array position, worst first', () => {
    const draft = normalizeDraft({
      name: 'Support rubric',
      preamble: 'Decide whether the agent resolved the ticket.',
      scale: [{ label: 'unusable' }, { label: 'needs work' }, { label: 'ready to send' }],
      criteria: [],
      openQuestions: [],
    });

    expect(draft.scale.map((s) => [s.label, s.rank])).toEqual([
      ['unusable', 0],
      ['needs work', 1],
      ['ready to send', 2],
    ]);
  });

  it('slugifies labels into ids', () => {
    const draft = normalizeDraft({ scale: [{ label: 'Needs work!' }, { label: 'Ready to send' }] });
    expect(draft.scale.map((s) => s.id)).toEqual(['needs-work', 'ready-to-send']);
  });

  it('suffixes colliding ids rather than dropping a level', () => {
    // Two labels that slugify identically. Dropping one would silently change
    // the scale the team agreed to; merging them would merge stored grades.
    const draft = normalizeDraft({ scale: [{ label: 'needs work' }, { label: 'needs-work' }, { label: 'good' }] });
    expect(draft.scale).toHaveLength(3);
    expect(new Set(draft.scale.map((s) => s.id)).size).toBe(3);
  });

  it('falls back to the default scale when fewer than two distinct levels come back', () => {
    expect(normalizeDraft({ scale: [{ label: 'pass' }] }).scale).toEqual(DEFAULT_SCALE);
    expect(normalizeDraft({ scale: [{ label: 'Pass' }, { label: 'pass' }] }).scale).toEqual(DEFAULT_SCALE);
    expect(normalizeDraft({}).scale).toEqual(DEFAULT_SCALE);
  });

  it('caps criteria and questions', () => {
    const draft = normalizeDraft({
      criteria: Array.from({ length: MAX_CRITERIA + 3 }, (_, i) => ({ title: `C${i}`, body: 'b' })),
      openQuestions: Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({ question: `Q${i}?`, why: 'w' })),
    });
    expect(draft.criteria).toHaveLength(MAX_CRITERIA);
    expect(draft.openQuestions).toHaveLength(MAX_QUESTIONS);
  });

  it('drops entries with no title or question, and numbers the questions it keeps', () => {
    const draft = normalizeDraft({
      criteria: [{ title: '', body: 'orphan' }, { title: 'Real', body: 'body' }],
      openQuestions: [{ question: '   ', why: 'w' }, { question: 'What about refusals?', why: 'never shown' }],
    });
    expect(draft.criteria.map((c) => c.title)).toEqual(['Real']);
    expect(draft.openQuestions).toEqual([
      { id: 'q1', question: 'What about refusals?', why: 'never shown' },
    ]);
  });

  it('survives garbage without throwing', () => {
    for (const input of [null, 'nope', 42, [], { scale: 'not an array', criteria: 7, openQuestions: null }]) {
      const draft = normalizeDraft(input);
      expect(draft.scale.length).toBeGreaterThanOrEqual(2);
      expect(draft.criteria).toEqual([]);
      expect(draft.openQuestions).toEqual([]);
    }
  });

  it('uses the fallback name when none comes back', () => {
    expect(normalizeDraft({}, 'Rubric v1').name).toBe('Rubric v1');
  });
});

describe('drafter prompts', () => {
  it('forbids stating an unsettled case as a criterion', () => {
    const prompt = buildDrafterSystemPrompt();
    expect(prompt).toMatch(/never write a criterion that is really a question/i);
    expect(prompt).toMatch(/openQuestions/);
  });

  it('includes every example, titled and numbered', () => {
    const prompt = buildDrafterUserPrompt({
      description: 'A refund agent.',
      examples: [
        { title: 'Refund approved', content: 'user: refund please' },
        { title: 'Escalated', content: 'agent: let me get a human' },
      ],
    });
    expect(prompt).toContain('A refund agent.');
    expect(prompt).toContain('### 1. Refund approved');
    expect(prompt).toContain('### 2. Escalated');
    expect(prompt).toContain('user: refund please');
    expect(prompt).toContain('agent: let me get a human');
    expect(prompt).toContain('## Transcripts (2)');
  });
});

describe('translating operating documents', () => {
  it('keeps a citation only when both the document and the quote survive', () => {
    const draft = normalizeDraft({
      criteria: [
        { title: 'Verifies purchase date', body: 'b', source: { document: 'Refund policy', quote: 'Check the date.' } },
        { title: 'No quote', body: 'b', source: { document: 'Refund policy', quote: '   ' } },
        { title: 'No document', body: 'b', source: { quote: 'Check the date.' } },
        { title: 'No source at all', body: 'b' },
      ],
    });

    // A citation with half of itself missing claims provenance the reader
    // cannot check, which is worse than admitting there is none.
    expect(draft.criteria.map((c) => c.source)).toEqual([
      { document: 'Refund policy', quote: 'Check the date.' },
      null,
      null,
      null,
    ]);
  });

  it('normalises conflicts and defaults an unrecognised kind to untestable', () => {
    const draft = normalizeDraft({
      conflicts: [
        { kind: 'contradiction', statement: 'Two limits.', detail: 'One says $50, one says $100.', documents: ['A', 'B'] },
        { kind: 'nonsense', statement: 'Use good judgment.', detail: 'Nothing to check.', documents: ['A'] },
        { kind: 'untestable', statement: '   ', detail: 'dropped', documents: [] },
      ],
    });

    expect(draft.conflicts).toEqual([
      {
        id: 'x1',
        kind: 'contradiction',
        statement: 'Two limits.',
        detail: 'One says $50, one says $100.',
        documents: ['A', 'B'],
      },
      { id: 'x2', kind: 'untestable', statement: 'Use good judgment.', detail: 'Nothing to check.', documents: ['A'] },
    ]);
  });

  it('caps conflicts and survives a missing conflicts field', () => {
    const many = normalizeDraft({
      conflicts: Array.from({ length: MAX_CONFLICTS + 3 }, (_, i) => ({ kind: 'untestable', statement: `S${i}` })),
    });
    expect(many.conflicts).toHaveLength(MAX_CONFLICTS);
    expect(normalizeDraft({}).conflicts).toEqual([]);
  });

  it('trims a long document and says so', () => {
    const { documents, truncated } = prepareDocuments([
      { title: 'Policy', kind: 'policy', content: 'x'.repeat(DOCUMENT_CHAR_BUDGET + 200) },
    ]);
    expect(truncated).toBe(true);
    expect(documents[0]!.content).toContain('document trimmed to fit');
    expect(documents[0]!.kind).toBe('policy');
  });

  it('puts the documents before the transcripts, labelled by kind', () => {
    const prompt = buildDrafterUserPrompt({
      description: 'A refund agent.',
      documents: [{ title: 'Refund policy', kind: 'policy', content: 'Refunds under $50 need no approval.' }],
      examples: [{ title: 'A call', content: 'user: refund please' }],
    });

    expect(prompt.indexOf('Operating documents')).toBeLessThan(prompt.indexOf('Transcripts'));
    expect(prompt).toContain('### Document 1: Refund policy (policy)');
    expect(prompt).toContain('Refunds under $50 need no approval.');
    expect(prompt).toContain('Quote the sentence behind every criterion');
  });

  it('falls back to the plain instruction when there are no documents', () => {
    const prompt = buildDrafterUserPrompt({
      description: 'A refund agent.',
      examples: [{ title: 'A call', content: 'user: refund please' }],
    });
    expect(prompt).not.toContain('Operating documents');
    expect(prompt.trimEnd().endsWith('Draft the rubric.')).toBe(true);
  });

  it('forbids repairing a contradiction into a clean criterion', () => {
    const prompt = buildDrafterSystemPrompt();
    expect(prompt).toMatch(/do not repair it/i);
    expect(prompt).toMatch(/never move a rule out of `?conflicts`?/i);
    expect(prompt).toMatch(/contradiction/);
    expect(prompt).toMatch(/untestable/);
  });
});
