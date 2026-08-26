/**
 * Rubric drafting — the entry point for a team with no rubric at all.
 *
 * Two providers, same shape as the judge:
 *   - openrouter  a real model on a pinned version, through callModel
 *   - offline     a blank scale plus the questions teams always argue about first
 *
 * The offline provider does not pretend. It cannot read the transcripts, so it
 * does not invent criteria from them; it returns a starting skeleton and says
 * that is what it is. An invented rubric that looks drafted from your data would
 * be worse than no rubric, because the team would trust it.
 */

import { CREATOR_PIN, openrouterJson, openrouterKey } from './openrouter.js';
import type { GatewayOptions } from './gateway.js';
import { resolvePin } from './pins.js';
import {
  buildDrafterSystemPrompt,
  buildDrafterUserPrompt,
  type DraftRequest,
  type RubricDraft,
  draftJsonSchema,
  normalizeDraft,
} from '../shared/drafting.js';
import { DEFAULT_SCALE } from '../shared/types.js';

export const DEFAULT_DRAFT_MODEL = 'openrouter';

export interface DrafterProvider {
  id: string;
  model: string;
  /** True when a model actually read the transcripts. The UI gates its claims on it. */
  real: boolean;
  draft(req: DraftRequest, gateway?: GatewayOptions): Promise<RubricDraft>;
}

export function resolveDrafter(_model = process.env.GR_DRAFT_MODEL ?? DEFAULT_DRAFT_MODEL): DrafterProvider {
  if (openrouterKey()) return openrouterDrafter();
  return offlineDrafter();
}

/* ---- OpenRouter --------------------------------------------------------- */

function openrouterDrafter(): DrafterProvider {
  return {
    id: 'openrouter',
    model: resolvePin(CREATOR_PIN).openrouter_model_id,
    real: true,
    async draft(req, gateway) {
      // openrouterJson throws DrafterError already, with the router's own
      // error kind preserved: this path adds no error taxonomy of its own.
      const parsed = await openrouterJson<unknown>({
        system: buildDrafterSystemPrompt(),
        user: buildDrafterUserPrompt(req),
        schema: draftJsonSchema(),
        gateway,
        // A scale, up to six criteria with bodies, and six questions with
        // reasons, plus reasoning tokens, which count against this budget.
        maxTokens: 8192,
      });
      return normalizeDraft(parsed, 'Rubric');
    },
  };
}

/* ---- Offline ------------------------------------------------------------ */

/**
 * The questions almost every team turns out to disagree about on their first
 * round, regardless of what their agent does.
 *
 * These are not drafted from anyone's transcripts and the provider reports
 * `real: false` so the UI can say so. They earn their place by being true often
 * enough to be a better starting point than an empty page.
 */
const COMMON_QUESTIONS: { question: string; why: string }[] = [
  {
    question: 'When the agent does part of the task and leaves the rest, is that the middle verdict or a fail?',
    why: 'Partial work is where most teams split first, and having a middle level on the scale does not by itself say when to reach for it.',
  },
  {
    question: 'Does a correct outcome delivered badly (wrong tone, no explanation, six steps where one would do) change the verdict?',
    why: 'Teams usually assume they agree on this and find out during a round that they do not.',
  },
  {
    question: 'When the request was ambiguous, is the agent judged on what the user asked for or on what they meant?',
    why: 'Both readings are defensible, so graders pick different ones and neither thinks it is a judgment call.',
  },
  {
    question: 'If the agent refuses, escalates, or asks a clarifying question instead of acting, how is that graded?',
    why: 'It is a common outcome and rarely covered by a rubric written before anyone looked at the transcripts.',
  },
  {
    question: 'Does an error the user would never notice count the same as one they would?',
    why: 'Graders reading for correctness and graders reading for user impact reach different verdicts on the same transcript.',
  },
];

function offlineDrafter(): DrafterProvider {
  return {
    id: 'offline',
    model: 'offline',
    real: false,
    async draft(req) {
      return {
        name: 'Rubric v1',
        preamble: req.description.trim(),
        scale: DEFAULT_SCALE,
        // Deliberately empty. Criteria are the part that has to come from the
        // transcripts, and this provider has not read them.
        criteria: [],
        // Finding a contradiction requires reading the documents, which this
        // provider cannot do. Reporting none is the honest answer, not evidence
        // that the operating rules are consistent.
        conflicts: [],
        openQuestions: COMMON_QUESTIONS.map((q, i) => ({ id: `q${i + 1}`, ...q })),
      };
    },
  };
}

export class DrafterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DrafterError';
  }
}
