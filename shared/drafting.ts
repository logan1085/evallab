/**
 * Turning a company's written operations into something gradable.
 *
 * Most teams already have the decisions written down — a refund policy, an
 * escalation SOP, a QA checklist, the thread where someone settled what
 * "resolved" means. What they do not have is an eval. This module does that
 * translation, and the translation has exactly three possible outcomes for any
 * given sentence of policy:
 *
 *   criterion      it can be checked against a transcript, so it becomes a test
 *                  carrying the sentence it came from, quoted
 *   conflict       it contradicts another document, or nobody could check it
 *                  from a transcript — handed back, never quietly converted
 *   open question  the documents simply do not cover the case
 *
 * Keeping those three apart is the whole design. A drafter that produced a
 * clean rubric from a messy policy would be hiding the most valuable thing it
 * found: written operations contradict themselves constantly, and a company
 * usually learns this the first time somebody tries to automate them.
 *
 * Transcripts are still accepted alongside the documents, and they do different
 * work. The documents say what the company believes it does. The transcripts
 * show what actually happened. Where those disagree is worth naming.
 *
 * Everything here is pure — prompt construction, schema, and normalisation of
 * whatever comes back. The provider lives in `server/drafter.ts`.
 */

import {
  DEFAULT_SCALE,
  type DocumentKind,
  type DraftConflict,
  type CriterionSource,
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
export const MAX_CRITERIA = 8;
export const MAX_QUESTIONS = 6;
export const MAX_CONFLICTS = 6;
/** Policies are longer than transcripts and carry more signal per character. */
export const MAX_DRAFT_DOCUMENTS = 8;
export const DOCUMENT_CHAR_BUDGET = 14000;

export interface DraftExample {
  title: string;
  content: string;
}

export interface DraftDocument {
  title: string;
  kind: DocumentKind;
  content: string;
}

export interface DraftRequest {
  /** One or two sentences on what the agent is supposed to do. */
  description: string;
  /** The written operations. The main input once a team has any. */
  documents?: DraftDocument[];
  /** Transcripts. What actually happened, as against what the documents claim. */
  examples: DraftExample[];
}

export interface RubricDraft {
  name: string;
  preamble: string;
  scale: VerdictLevel[];
  criteria: RubricCriterion[];
  openQuestions: DraftQuestion[];
  /** Policy that could not become a test. Never silently dropped. */
  conflicts: DraftConflict[];
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
 * Document preparation, mirroring prepareExamples.
 *
 * Trimming a policy is more consequential than trimming a transcript: the
 * sentence that got cut may be the one that contradicts another document. So a
 * trimmed document says so inline, and the provenance record carries the flag.
 */
export interface PreparedDocuments {
  documents: DraftDocument[];
  truncated: boolean;
}

export function prepareDocuments(
  documents: DraftDocument[],
  opts: { max?: number; budget?: number } = {},
): PreparedDocuments {
  const max = opts.max ?? MAX_DRAFT_DOCUMENTS;
  const budget = opts.budget ?? DOCUMENT_CHAR_BUDGET;

  let truncated = documents.length > max;
  const kept = documents.slice(0, max).map((doc) => {
    if (doc.content.length <= budget) return doc;
    truncated = true;
    return { ...doc, content: `${doc.content.slice(0, budget)}\n…[document trimmed to fit]` };
  });

  return { documents: kept, truncated };
}

/* ---- Prompts ------------------------------------------------------------ */

/**
 * The product's opinion, written down.
 *
 * Two instructions carry the whole design. The first forbids a criterion that
 * is really a question: without it a model resolves ambiguity by picking a side
 * and stating it as though the documents had settled it, which is exactly the
 * afternoon-rubric failure this product exists to answer. The second forbids
 * repairing a contradiction: a model asked to turn a messy policy into a clean
 * rubric will happily reconcile two conflicting rules and hand back something
 * tidy, which destroys the single most valuable finding — that the company's
 * written operations do not agree with themselves.
 */
export function buildDrafterSystemPrompt(): string {
  return [
    "You are turning a company's written operating rules into a grading rubric: something two people could apply to the same transcript and reach the same verdict.",
    '',
    'You may be given policies, SOPs, checklists, and records of past decisions, and you may be given transcripts of what the agent actually did. The documents say what the company believes it does. The transcripts show what happened. They are not the same thing and you should not assume they agree.',
    '',
    '## Every rule you read has exactly one of three fates',
    '',
    '**criteria**: the rule can be checked against a transcript. Write it as a test, and quote the sentence it came from, verbatim, in `source.quote`, with the document title in `source.document`. If you cannot quote a specific sentence, it is not a criterion.',
    '',
    "**conflicts**: the rule contradicts another rule, or nobody could check it from a transcript. Do not repair it. Do not pick the version you prefer. Report it and let the team settle it. Use kind `contradiction` when two rules disagree, `untestable` when a rule is real but unverifiable from a transcript alone (\"agents should use good judgment\", or anything requiring data the transcript does not contain).",
    '',
    '**openQuestions**: the documents simply do not cover the case. Name the decision that is missing.',
    '',
    'Never move a rule out of `conflicts` to make the rubric look cleaner. A rubric that hides a contradiction produces a number that means nothing.',
    '',
    '## Rules',
    '',
    '1. Ground every criterion in the material you were given. A plausible-sounding criterion with nothing behind it is worse than a short rubric.',
    "2. Never write a criterion that is really a question. If the material does not tell you which way a case should go, that is an openQuestion, not a decision you made on the team's behalf.",
    '3. Write criteria as tests someone can apply in under a minute. "The agent states which parts of the request it did not complete" is a test. "The agent is helpful and transparent" is not.',
    '4. If a transcript shows the agent doing something the documents forbid, that is worth a criterion. The documents already settled it, and the eval should catch it.',
    '5. Order the scale from worst to best. Three levels unless the material clearly calls for more or fewer.',
    '6. The preamble says what a grader is deciding, in one or two plain sentences. No jargon.',
    '',
    '## openQuestions',
    '',
    'Be concrete. "What counts as a good response" is useless. "Whether an agent that refunds inside the limit but never checks the purchase date counts as a pass" is useful, because a team can answer it. For each, say what left it open: a case the documents never mention, a rule that stops short, or two examples pointing different ways.',
    '',
    'Write plainly. The people reading this run the operation; they are not machine-learning researchers.',
  ].join('\n');
}

export function buildDrafterUserPrompt(req: DraftRequest): string {
  const lines: string[] = [];
  const documents = req.documents ?? [];

  lines.push('## What the agent is supposed to do');
  lines.push('');
  lines.push(req.description.trim());
  lines.push('');

  if (documents.length > 0) {
    lines.push(`## Operating documents (${documents.length})`);
    lines.push('');
    documents.forEach((doc, i) => {
      lines.push(`### Document ${i + 1}: ${doc.title} (${doc.kind})`);
      lines.push('');
      lines.push('```');
      lines.push(doc.content);
      lines.push('```');
      lines.push('');
    });
  }

  if (req.examples.length > 0) {
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
  }

  lines.push(
    documents.length > 0
      ? 'Turn these operating rules into a rubric. Quote the sentence behind every criterion, and report anything that cannot become a test.'
      : 'Draft the rubric.',
  );
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
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            source: {
              type: ['object', 'null'],
              description: 'The document sentence this criterion encodes. Null only when nothing was quoted.',
              properties: {
                document: { type: 'string' },
                quote: { type: 'string', description: 'Verbatim, from the document.' },
              },
              required: ['document', 'quote'],
              additionalProperties: false,
            },
          },
          required: ['title', 'body', 'source'],
          additionalProperties: false,
        },
      },
      conflicts: {
        type: 'array',
        maxItems: MAX_CONFLICTS,
        description: 'Rules that cannot become a test. Never repaired into criteria.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['contradiction', 'untestable'] },
            statement: { type: 'string' },
            detail: { type: 'string' },
            documents: { type: 'array', items: { type: 'string' } },
          },
          required: ['kind', 'statement', 'detail', 'documents'],
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
    required: ['name', 'preamble', 'scale', 'criteria', 'conflicts', 'openQuestions'],
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
  const conflicts = normalizeConflicts(obj.conflicts);

  return {
    name: text(obj.name) || fallbackName,
    preamble: text(obj.preamble),
    scale,
    criteria,
    openQuestions,
    conflicts,
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
    .map((c) => ({ title: text(c.title), body: text(c.body), source: normalizeSource(c.source) }))
    .filter((c) => c.title.length > 0)
    .slice(0, MAX_CRITERIA);
  const ids = uniqueIds(entries.map((c) => c.title));
  return entries.map((c, i) => ({ id: ids[i]!, title: c.title, body: c.body, source: c.source }));
}

/**
 * A citation with no quote is worse than no citation: it claims provenance the
 * reader cannot check. Both halves or neither.
 */
function normalizeSource(raw: unknown): CriterionSource | null {
  if (!isRecord(raw)) return null;
  const document = text(raw.document);
  const quote = text(raw.quote);
  if (!document || !quote) return null;
  return { document, quote };
}

function normalizeConflicts(raw: unknown): DraftConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((c) => ({
      kind: c.kind === 'contradiction' ? ('contradiction' as const) : ('untestable' as const),
      statement: text(c.statement),
      detail: text(c.detail),
      documents: Array.isArray(c.documents) ? c.documents.map((d) => text(d)).filter(Boolean) : [],
    }))
    .filter((c) => c.statement.length > 0)
    .slice(0, MAX_CONFLICTS)
    .map((c, i) => ({ id: `x${i + 1}`, ...c }));
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
