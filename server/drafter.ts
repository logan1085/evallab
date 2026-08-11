/**
 * Rubric drafting — the entry point for a team with no rubric at all.
 *
 * Two providers, same shape as the judge:
 *   - anthropic  a real model, used when ANTHROPIC_API_KEY is set
 *   - offline    a blank scale plus the questions teams always argue about first
 *
 * The offline provider does not pretend. It cannot read the transcripts, so it
 * does not invent criteria from them; it returns a starting skeleton and says
 * that is what it is. An invented rubric that looks drafted from your data would
 * be worse than no rubric, because the team would trust it.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildDrafterSystemPrompt,
  buildDrafterUserPrompt,
  type DraftRequest,
  type RubricDraft,
  draftJsonSchema,
  normalizeDraft,
} from '../shared/drafting.js';
import { DEFAULT_SCALE } from '../shared/types.js';

export const DEFAULT_DRAFT_MODEL = 'claude-opus-5';

export interface DrafterProvider {
  id: string;
  model: string;
  /** True when a model actually read the transcripts. The UI gates its claims on it. */
  real: boolean;
  draft(req: DraftRequest): Promise<RubricDraft>;
}

export function resolveDrafter(model = process.env.GR_DRAFT_MODEL ?? DEFAULT_DRAFT_MODEL): DrafterProvider {
  if (process.env.ANTHROPIC_API_KEY) return anthropicDrafter(model);
  return offlineDrafter();
}

/* ---- Anthropic ---------------------------------------------------------- */

function anthropicDrafter(model: string): DrafterProvider {
  const client = new Anthropic();

  return {
    id: 'anthropic',
    model,
    real: true,
    async draft(req) {
      let response;
      try {
        response = await client.messages.create({
          model,
          // A scale, up to six criteria with bodies, and six questions with
          // reasons — plus thinking, which counts against this budget.
          max_tokens: 8192,
          system: buildDrafterSystemPrompt(),
          messages: [{ role: 'user', content: buildDrafterUserPrompt(req) }],
          output_config: { format: { type: 'json_schema', schema: draftJsonSchema() } },
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
          throw new DrafterError('rate_limited', 'The drafter was rate limited. Wait a moment and try again.');
        }
        if (error instanceof Anthropic.AuthenticationError) {
          throw new DrafterError('auth', 'ANTHROPIC_API_KEY was rejected.');
        }
        if (error instanceof Anthropic.APIConnectionError) {
          throw new DrafterError('network', 'Could not reach the Anthropic API.');
        }
        throw new DrafterError('api', error instanceof Error ? error.message : 'The draft request failed.');
      }

      // Unlike a judge refusal, there is no useful partial result to record —
      // an empty rubric is not an outcome, so this surfaces as an error.
      if (response.stop_reason === 'refusal') {
        throw new DrafterError(
          'refusal',
          'The model declined to draft a rubric from these transcripts. Check what is in them, or write the first version by hand.',
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DrafterError('parse', 'The drafter returned output that was not the expected JSON object.');
      }

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
    question: 'Does a correct outcome delivered badly — wrong tone, no explanation, six steps where one would do — change the verdict?',
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
