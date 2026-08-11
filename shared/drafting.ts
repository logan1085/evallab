/**
 * Drafting a rubric from examples — the step for teams who have nothing yet.
 *
 * The rest of the product assumes a rubric exists and asks whether two people
 * apply it the same way. This module handles the case before that: a team with
 * an agent, some transcripts, and no written standard at all.
 *
 * The design constraint is that a drafted rubric must not feel finished. A model
 * handed twelve transcripts can produce something that reads authoritative and
 * is, in the places that matter, a guess. So the draft is required to carry its
 * own gaps: alongside the scale and criteria it returns the questions the
 * examples do not answer. Those questions are the honest output. They are also
 * the useful one, because they predict where the first round will split.
 *
 * Everything here is pure — prompt construction, schema, and normalisation of
 * whatever comes back. The provider lives in `server/drafter.ts`.
 */

import {
  DEFAULT_SCALE,
  type DraftQuestion,
  type RubricCriterion,
  type VerdictLevel,
} from './types.js';

/** Enough examples to see a pattern, few enough to stay inside a sane request. */
export const MAX_DRAFT_EXAMPLES = 12;
/** Per-transcript character budget. Long traces are trimmed, and the draft says so. */
export const EXAMPLE_CHAR_BUDGET = 6000;
export const MIN_SCALE_LEVELS = 2;
export const MAX_SCALE_LEVELS = 5;
export const MAX_CRITERIA = 6;
export const MAX_QUESTIONS = 6;

export interface DraftExample {
  title: string;
  content: string;
}

export interface DraftRequest {
  /** One or two sentences on what the agent is supposed to do. */
  description: string;
  examples: DraftExample[];
}

export interface RubricDraft {
  name: string;
  preamble: string;
  scale: VerdictLevel[];
  criteria: RubricCriterion[];
  openQuestions: DraftQuestion[];
}

/* ---- Example preparation ------------------------------------------------ */

export interface PreparedExamples {
  examples: DraftExample[];
  /** True when any transcript was trimmed, or examples were dropped past the cap. */
  truncated: boolean;
}

/**
 * Trim to fit, and report it. Silently truncating the evidence a rubric was
 * drafted from would make the provenance record a lie.
 */
export function prepareExamples(
  examples: DraftExample[],
  opts: { max?: number; budget?: number } = {},
): PreparedExamples {
  const max = opts.max ?? MAX_DRAFT_EXAMPLES;
  const budget = opts.budget ?? EXAMPLE_CHAR_BUDGET;

  let truncated = examples.length > max;
  const kept = examples.slice(0, max).map((ex) => {
    if (ex.content.length <= budget) return ex;
    truncated = true;
    return { title: ex.title, content: `${ex.content.slice(0, budget)}\n…[transcript trimmed to fit]` };
  });

  return { examples: kept, truncated };
}

/* ---- Prompts ------------------------------------------------------------ */

/**
 * The product's opinion, written down.
 *
 * The load-bearing instruction is the one forbidding a criterion that is really
 * a question. Without it a model resolves ambiguity by picking a side and
 * stating it as though the examples had settled it, which is precisely the
 * afternoon-rubric failure the whole product is a response to.
 */
export function buildDrafterSystemPrompt(): string {
  return [
    'You are helping a team write their first grading rubric for an AI agent. They have transcripts and no written standard.',
    '',
    'Write the smallest rubric that would let two people on that team grade these transcripts the same way.',
    '',
    '## Rules',
    '',
    '1. Ground every criterion in the transcripts you were given. If nothing in the examples bears on something, leave it out — a plausible-sounding criterion with no evidence behind it is worse than a short rubric.',
    '2. Never write a criterion that is really a question. If the examples do not tell you which way a case should go, that belongs in openQuestions, not in the rubric as a decision you made on the team\'s behalf.',
    '3. Write criteria as tests someone can apply to a transcript in under a minute, not as aspirations. "The agent states which parts of the request it did not complete" is a test. "The agent is helpful and transparent" is not.',
    '4. Order the scale from worst to best. Three levels unless the transcripts clearly call for more or fewer.',
    '5. The preamble says what a grader is deciding, in one or two plain sentences. No jargon.',
    '',
    '## openQuestions is the most important field',
    '',
    'A handful of transcripts cannot settle every case. Name the decisions they leave open — the ones where two careful people reading this rubric would land in different places. Be concrete and specific to these transcripts; "what counts as a good response" is useless, "whether an agent that solves the problem but ignores the constraint the user gave counts as a pass" is useful.',
    '',
    'For each, say what in the examples left it open: an example that shows the case without resolving it, a case the examples never show at all, or two examples that seem to point different ways.',
    '',
    'Write plainly. The people reading this are not machine-learning researchers.',
  ].join('\n');
}

export function buildDrafterUserPrompt(req: DraftRequest): string {
  const lines: string[] = [];
  lines.push('## What the agent is supposed to do');
  lines.push('');
  lines.push(req.description.trim());
  lines.push('');
  lines.push(`## Transcripts (${req.examples.length})`);
  lines.push('');
  req.examples.forEach((ex, i) => {
    lines.push(`### ${i + 1}. ${ex.title}`);
    lines.push('');
    lines.push('```');
    lines.push(ex.content);
    lines.push('```');
    lines.push('');
  });
  lines.push('Draft the rubric.');
  return lines.join('\n');
}

/** Enforced server-side by the provider, so a malformed draft is not a failure mode to code around. */
export function draftJsonSchema() {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      preamble: { type: 'string' },
      scale: {
        type: 'array',
        minItems: MIN_SCALE_LEVELS,
        maxItems: MAX_SCALE_LEVELS,
        description: 'Verdict levels ordered worst to best.',
        items: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
      },
      criteria: {
        type: 'array',
        maxItems: MAX_CRITERIA,
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title', 'body'],
          additionalProperties: false,
        },
      },
      openQuestions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            why: { type: 'string', description: 'What in the examples left this open.' },
          },
          required: ['question', 'why'],
          additionalProperties: false,
        },
      },
    },
    required: ['name', 'preamble', 'scale', 'criteria', 'openQuestions'],
    additionalProperties: false,
  };
}

/* ---- Normalisation ------------------------------------------------------ */

/**
 * Turn whatever came back into something the rest of the app can store.
 *
 * Ranks are assigned from array position rather than taken from the model,
 * because rank is load-bearing: split severity and ordinal agreement are both
 * computed from the distance between ranks. A scale numbered wrongly would not
 * error, it would quietly mis-classify polar disagreements as adjacent ones.
 */
export function normalizeDraft(raw: unknown, fallbackName = 'Rubric'): RubricDraft {
  const obj = isRecord(raw) ? raw : {};

  const scale = normalizeScale(obj.scale);
  const criteria = normalizeCriteria(obj.criteria);
  const openQuestions = normalizeQuestions(obj.openQuestions);

  return {
    name: text(obj.name) || fallbackName,
    preamble: text(obj.preamble),
    scale,
    criteria,
    openQuestions,
  };
}

function normalizeScale(raw: unknown): VerdictLevel[] {
  if (!Array.isArray(raw)) return DEFAULT_SCALE;

  const labels: string[] = [];
  for (const entry of raw) {
    const label = text(isRecord(entry) ? entry.label : entry);
    if (label && !labels.some((l) => l.toLowerCase() === label.toLowerCase())) labels.push(label);
  }

  // Below two distinct levels there is no scale to disagree on, so fall back
  // rather than persist something no round could use.
  if (labels.length < MIN_SCALE_LEVELS) return DEFAULT_SCALE;

  const ids = uniqueIds(labels.slice(0, MAX_SCALE_LEVELS));
  return ids.map((id, i) => ({ id, label: labels[i]!, rank: i }));
}

function normalizeCriteria(raw: unknown): RubricCriterion[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw
    .filter(isRecord)
    .map((c) => ({ title: text(c.title), body: text(c.body) }))
    .filter((c) => c.title.length > 0)
    .slice(0, MAX_CRITERIA);
  const ids = uniqueIds(entries.map((c) => c.title));
  return entries.map((c, i) => ({ id: ids[i]!, title: c.title, body: c.body }));
}

function normalizeQuestions(raw: unknown): DraftQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((q) => ({ question: text(q.question), why: text(q.why) }))
    .filter((q) => q.question.length > 0)
    .slice(0, MAX_QUESTIONS)
    .map((q, i) => ({ id: `q${i + 1}`, question: q.question, why: q.why }));
}

/**
 * Verdict ids end up in stored grades, so a collision would merge two levels
 * after the fact. Suffix rather than drop: losing a level silently changes the
 * scale the team agreed to.
 */
function uniqueIds(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label, i) => {
    const base = slug(label) || `level-${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
