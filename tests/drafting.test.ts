import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_CHAR_BUDGET,
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
