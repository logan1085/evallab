/**
 * Judge generation — step seven of the loop, and the commercial reason the rest
 * of the product exists.
 *
 * The judge reads exactly the rubric the humans read. Nothing is paraphrased on
 * the way in, because the whole claim being tested is "a calibrated rubric
 * produces a judge that agrees with humans more than an uncalibrated one", and
 * that claim only holds if the judge and the humans were given the same text.
 *
 * Two providers:
 *   - openrouter    a real model on a pinned version, through callModel, so
 *                   every judge call is costed and recorded like any other
 *   - offline-stub  a deterministic keyword scorer, used when there is no key
 *
 * The stub exists so the workflow is explorable without credentials. It is not
 * a judge and the UI says so wherever its numbers appear.
 */

import { ABSTAIN, type RubricVersion, type Trace } from '../shared/types.js';
import { buildJudgeSystemPrompt, buildJudgeUserPrompt, judgeJsonSchema } from '../shared/rubric.js';
import { CREATOR_PIN, openrouterJson, openrouterKey } from './openrouter.js';
import type { GatewayOptions } from './gateway.js';
import { resolvePin } from './pins.js';
import { DrafterError } from './drafter.js';

export const DEFAULT_JUDGE_MODEL = 'openrouter';

export interface JudgeResult {
  verdict: string;
  rationale: string;
}

export interface JudgeProvider {
  id: string;
  model: string;
  /** True when this provider is a real model. The UI gates claims on it. */
  real: boolean;
  grade(rubric: RubricVersion, trace: Pick<Trace, 'title' | 'content'>, gateway?: GatewayOptions): Promise<JudgeResult>;
}

export function resolveProvider(_model = process.env.GR_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL): JudgeProvider {
  if (openrouterKey()) return openrouterProvider();
  return offlineProvider();
}

/* ---- OpenRouter --------------------------------------------------------- */

function openrouterProvider(): JudgeProvider {
  const pin = resolvePin(CREATOR_PIN);
  return {
    id: 'openrouter',
    model: pin.openrouter_model_id,
    real: true,
    async grade(rubric, trace, gateway) {
      const allowed = [...rubric.scale].sort((a, b) => b.rank - a.rank).map((s) => s.id);

      // Structured outputs rather than "reply with JSON" plus a parser: the
      // schema is enforced at the router, so a malformed verdict is not a
      // failure mode we have to code around.
      const schema = judgeJsonSchema(allowed, ABSTAIN);

      let parsed: JudgeResult;
      try {
        parsed = await openrouterJson<JudgeResult>({
          system: buildJudgeSystemPrompt(rubric),
          user: buildJudgeUserPrompt(trace),
          schema,
          // Sized for reasoning plus a two-field object, not just the object.
          maxTokens: 4096,
          gateway,
        });
      } catch (error) {
        // The drafter taxonomy and the judge taxonomy are the same taxonomy
        // wearing different names; translate rather than invent a third.
        const kind = error instanceof DrafterError ? error.code : 'api';
        const message = error instanceof Error ? error.message : 'Judge request failed.';
        if (kind === 'rate_limited') {
          throw new JudgeError('rate_limited', 'The judge was rate limited. Try a smaller arm or wait and re-run.');
        }
        if (kind === 'auth') throw new JudgeError('auth', 'OPENROUTER_API_KEY was rejected.');
        if (kind === 'network') throw new JudgeError('network', 'Could not reach OpenRouter.');
        if (kind === 'refusal') {
          // A refusal is a real outcome, not an exception. Recording it as an
          // abstention keeps it visible in coverage rather than silently
          // dropping the item out of the agreement calculation.
          return { verdict: ABSTAIN, rationale: 'The model declined to grade this trace.' };
        }
        if (kind === 'parse') {
          throw new JudgeError('parse', 'The judge returned output that was not the expected JSON object.');
        }
        throw new JudgeError('api', message);
      }

      const verdict = allowed.includes(parsed.verdict) || parsed.verdict === ABSTAIN ? parsed.verdict : ABSTAIN;
      return { verdict, rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '' };
    },
  };
}

/* ---- Offline stub ------------------------------------------------------- */

/**
 * Deterministic, explainable, and not a judge.
 *
 * It scores a trace by how much lexical evidence it shares with each verdict's
 * clauses and criteria. That is enough to exercise the plumbing end to end. It
 * is not enough to conclude anything about whether a calibrated rubric makes a
 * better judge, which is exactly what `real: false` tells the rest of the app.
 */
function offlineProvider(): JudgeProvider {
  return {
    id: 'offline-stub',
    model: 'offline-stub',
    real: false,
    async grade(rubric, trace) {
      const haystack = tokenize(`${trace.title} ${trace.content}`);
      const scale = [...rubric.scale].sort((a, b) => b.rank - a.rank);

      // Sentences that mention a verdict by name vote for that verdict, weighted
      // by how much of their vocabulary appears in the trace.
      const scores = new Map(scale.map((level) => [level.id, 0]));
      const sentences = [
        ...rubric.clauses.map((c) => c.text),
        ...rubric.criteria.map((c) => `${c.title}. ${c.body}`),
        rubric.preamble,
      ].flatMap(splitSentences);

      for (const sentence of sentences) {
        const words = tokenize(sentence);
        if (words.length === 0) continue;
        const overlap = words.filter((w) => haystack.includes(w)).length / words.length;
        for (const level of scale) {
          if (sentence.toLowerCase().includes(level.label.toLowerCase())) {
            scores.set(level.id, (scores.get(level.id) ?? 0) + overlap);
          }
        }
      }

      let best = scale[scale.length - 1]!.id;
      let bestScore = -1;
      for (const [id, score] of scores) {
        if (score > bestScore) {
          bestScore = score;
          best = id;
        }
      }

      if (bestScore <= 0) {
        return {
          verdict: ABSTAIN,
          rationale: 'Offline stub: no rubric sentence shared enough vocabulary with this trace to pick a verdict.',
        };
      }

      return {
        verdict: best,
        rationale: `Offline stub: highest lexical overlap with rubric text mentioning "${best}". This is not a model judgment.`,
      };
    },
  };
}

const STOPWORDS = new Set(
  'the a an and or but if then that this those these is are was were be been to of in on for with as it its at by from not no do does did done have has had you your they them their we our i he she'.split(
    ' ',
  ),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class JudgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JudgeError';
  }
}

/** Bounded concurrency, so a 20-item arm does not open 20 sockets at once. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}
