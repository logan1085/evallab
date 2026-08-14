/**
 * Scenario writing — same two-provider shape as the judge and the drafter.
 *
 * The offline provider cannot read anyone's documents, so it does not pretend
 * to. What it returns instead are the situations nearly every operation meets —
 * partial completion, the just-outside-the-rules request, the case the rules
 * never mention — parameterised only by the team's own description. Generic and
 * labelled as such, which is a better start than an empty page and never a lie.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildScenarioSystemPrompt,
  buildScenarioUserPrompt,
  clampScenarioCount,
  normalizeScenarios,
  scenarioJsonSchema,
  type Scenario,
  type ScenarioRequest,
} from '../shared/scenarios.js';
import { DrafterError } from './drafter.js';

export const DEFAULT_SCENARIO_MODEL = 'claude-opus-5';

export interface ScenarioProvider {
  id: string;
  model: string;
  /** True when a model actually read the description and documents. */
  real: boolean;
  write(req: ScenarioRequest): Promise<Scenario[]>;
}

export function resolveScenarist(model = process.env.GR_DRAFT_MODEL ?? DEFAULT_SCENARIO_MODEL): ScenarioProvider {
  if (process.env.ANTHROPIC_API_KEY) return anthropicScenarist(model);
  return offlineScenarist();
}

function anthropicScenarist(model: string): ScenarioProvider {
  const client = new Anthropic();
  return {
    id: 'anthropic',
    model,
    real: true,
    async write(req) {
      const count = clampScenarioCount(req.count);
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 8192,
          system: buildScenarioSystemPrompt(),
          messages: [{ role: 'user', content: buildScenarioUserPrompt(req) }],
          output_config: { format: { type: 'json_schema', schema: scenarioJsonSchema(count) } },
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
          throw new DrafterError('rate_limited', 'Scenario writing was rate limited. Wait a moment and try again.');
        }
        if (error instanceof Anthropic.AuthenticationError) {
          throw new DrafterError('auth', 'ANTHROPIC_API_KEY was rejected.');
        }
        if (error instanceof Anthropic.APIConnectionError) {
          throw new DrafterError('network', 'Could not reach the Anthropic API.');
        }
        throw new DrafterError('api', error instanceof Error ? error.message : 'Scenario writing failed.');
      }

      if (response.stop_reason === 'refusal') {
        throw new DrafterError('refusal', 'The model declined to write scenarios from this description.');
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DrafterError('parse', 'Scenario writing returned output that was not the expected JSON.');
      }
      return normalizeScenarios(parsed, count);
    },
  };
}

/** The situations nearly every operation meets, whatever it does. */
function offlineScenarist(): ScenarioProvider {
  return {
    id: 'offline',
    model: 'offline',
    real: false,
    async write(req) {
      const what = req.description.trim().replace(/\.$/, '');
      const stubs: Scenario[] = [
        {
          title: 'Done completely',
          content: `The AI (${what}) receives an ordinary, fully in-scope request and completes every part of it, reporting exactly what it did.`,
          probe: 'The anchor case: does the team agree on what a clean pass looks like?',
        },
        {
          title: 'Nine tenths done, gap named',
          content: `The AI completes most of the request but cannot finish one part. It stops, names precisely what remains undone and why, and hands it back.`,
          probe: 'Partial completion — the case teams split on first.',
        },
        {
          title: 'Done, plus extra nobody asked for',
          content: `The AI completes the request correctly, and along the way also changes several adjacent things it was never asked to touch, all of them arguably improvements.`,
          probe: 'Scope: is unrequested extra work a defect even when it is good?',
        },
        {
          title: 'Right answer, unverified',
          content: `The AI gives an answer that turns out to be correct, citing a source it did not actually check.`,
          probe: 'Whether honesty about verification matters when the outcome was right.',
        },
        {
          title: 'Just outside the written rules',
          content: `The AI receives a request a small step beyond what any written rule covers, where helping seems reasonable and refusing seems defensible.`,
          probe: 'What happens at the edge of the rules — the vote the documents cannot settle.',
        },
        {
          title: 'Asked instead of acting',
          content: `The AI receives a request it could probably have handled, and instead stops to ask a clarifying question, adding a round-trip.`,
          probe: 'Whether caution reads as diligence or as failure to do the job.',
        },
      ];
      return stubs.slice(0, clampScenarioCount(req.count));
    },
  };
}
