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
 *   - anthropic     a real model, used when ANTHROPIC_API_KEY is set
 *   - offline-stub  a deterministic keyword scorer, used when it is not
 *
 * The stub exists so the workflow is explorable without credentials. It is not
 * a judge and the UI says so wherever its numbers appear.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ABSTAIN, type RubricVersion, type Trace } from '@shared/types.js';
import { buildJudgeSystemPrompt, buildJudgeUserPrompt } from '@shared/rubric.js';

export const DEFAULT_JUDGE_MODEL = 'claude-opus-5';

export interface JudgeResult {
  verdict: string;
  rationale: string;
}

export interface JudgeProvider {
  id: string;
  model: string;
  /** True when this provider is a real model. The UI gates claims on it. */
  real: boolean;
  grade(rubric: RubricVersion, trace: Pick<Trace, 'title' | 'content'>): Promise<JudgeResult>;
}

export function resolveProvider(model = process.env.GR_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL): JudgeProvider {
  if (process.env.ANTHROPIC_API_KEY) return anthropicProvider(model);
  return offlineProvider();
}

/* ---- Anthropic ---------------------------------------------------------- */

function anthropicProvider(model: string): JudgeProvider {
  const client = new Anthropic();

  return {
    id: 'anthropic',
    model,
    real: true,
    async grade(rubric, trace) {
      const allowed = [...rubric.scale].sort((a, b) => b.rank - a.rank).map((s) => s.id);

      // Structured outputs rather than "reply with JSON" plus a parser: the
      // schema is enforced server-side, so a malformed verdict is not a failure
      // mode we have to code around.
      const schema = {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: [...allowed, ABSTAIN] },
          rationale: { type: 'string' },
        },
        required: ['verdict', 'rationale'],
        additionalProperties: false,
      };

      let response;
      try {
        response = await client.messages.create({
          model,
          // Thinking is on by default and counts against max_tokens, so this is
          // sized for reasoning plus a two-field object, not just the object.
          max_tokens: 4096,
          system: buildJudgeSystemPrompt(rubric),
          messages: [{ role: 'user', content: buildJudgeUserPrompt(trace) }],
          output_config: { format: { type: 'json_schema', schema } },
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
          throw new JudgeError('rate_limited', 'The judge was rate limited. Try a smaller arm or wait and re-run.');
        }
        if (error instanceof Anthropic.AuthenticationError) {
          throw new JudgeError('auth', 'ANTHROPIC_API_KEY was rejected.');
        }
        if (error instanceof Anthropic.APIConnectionError) {
          throw new JudgeError('network', 'Could not reach the Anthropic API.');
        }
        throw new JudgeError('api', error instanceof Error ? error.message : 'Judge request failed.');
      }

      // A refusal is a real outcome, not an exception. Recording it as an
      // abstention keeps it visible in coverage rather than silently dropping
      // the item out of the agreement calculation.
      if (response.stop_reason === 'refusal') {
        return { verdict: ABSTAIN, rationale: 'The model declined to grade this trace.' };
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      let parsed: JudgeResult;
      try {
        parsed = JSON.parse(text) as JudgeResult;
      } catch {
        throw new JudgeError('parse', 'The judge returned output that was not the expected JSON object.');
      }

      const verdict = allowed.includes(parsed.verdict) || parsed.verdict === ABSTAIN ? parsed.verdict : ABSTAIN;
      return { verdict, rationale: String(parsed.rationale ?? '') };
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
