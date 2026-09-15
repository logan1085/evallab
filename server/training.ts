/**
 * Training data, with provenance on every row.
 *
 * The thesis in one file: a company's judgment, turned into rows a model can
 * learn from. Every row here points back to a case, a judge, a model id, and
 * the version of the standard it was scored under, so a row can be defended
 * or discarded later rather than trusted because it was in the file.
 *
 * Three shapes, one source:
 * - examples: settled cases with the panel's verdict and rationale (a false
 *   settle, where the owner disagreed with a unanimous panel, is excluded,
 *   because a label the owner overruled is not a label to learn from);
 * - gold: the owner's own adjudications, with the panel's verdict alongside;
 * - rewards: one row per judge per case, the verdict as a score on the
 *   standard's scale, for teams training a reward model against their own
 *   standard rather than a generic one.
 *
 * Verdict scores come from the rubric's ordinal scale, normalized to 0..1,
 * so a custom scale exports as sensibly as the default one.
 */

import { ABSTAIN, type Grade, type Grader, type RoundItem, type RubricVersion, type Trace } from '../shared/types.js';
import { readCase, type SeatVote } from '../shared/panelmap.js';
import { ensembleVerdict } from '../shared/ensemble.js';
import { derivePairs, pairOutcome, type GradedCase, type PairVote } from '../shared/pairs.js';

export interface TrainingRound {
  id: string;
  name: string;
  rubric: RubricVersion;
  items: RoundItem[];
  grades: Grade[];
  userVerdicts: { itemId: string; verdict: string; reason: string }[];
  pinnedModels: Record<string, string>;
}

export interface Provenance {
  project: string;
  round_id: string;
  round_name: string;
  standard_id: string;
  standard_version: number;
  case_id: string;
  case_title: string;
  case_source: string;
  prompt_variant: number;
  exported_at: string;
}

export interface ExampleRow {
  kind: 'example';
  input: string;
  label: string;
  score: number | null;
  rationale: string;
  basis: 'panel-settled, owner-checked' | 'panel-settled, provisional';
  judges: { seat: string; model: string; family: string; verdict: string; reason: string }[];
  /** Chat-shaped, so the row drops straight into a fine-tuning file. */
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  provenance: Provenance;
}

export interface GoldRow {
  kind: 'gold';
  input: string;
  label: string;
  score: number | null;
  rationale: string;
  adjudicated_by: 'owner';
  panel: { verdict: string | null; pattern: string; agreed_with_owner: boolean | null };
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  provenance: Provenance;
}

export interface RewardRow {
  kind: 'reward';
  input: string;
  judge: { seat: string; model: string; family: string; stake: string };
  verdict: string;
  score: number | null;
  rationale: string;
  case_pattern: string;
  provenance: Provenance;
}

/**
 * A preference pair: (prompt, chosen, rejected), the shape preference
 * post-training reads. Two sources, both named in the row: pairs the owner
 * posed and the panel compared in both orders, and pairs derived from two
 * graded transcripts that share a prompt and landed on different levels.
 */
export interface PairRow {
  kind: 'pair';
  prompt: string;
  chosen: string;
  rejected: string;
  source: 'panel-compared' | 'derived-from-grades';
  /** Share of counted weight behind the choice; 1 is unanimous. */
  support: number;
  basis: 'owner-adjudicated' | 'panel, owner-checked' | 'panel, provisional';
  judges: { seat: string; model: string; family: string; choice: 'a' | 'b' | 'tie'; stable: boolean | null; reason: string }[];
  rationale: string;
  provenance: Omit<Provenance, 'round_id' | 'round_name' | 'case_id' | 'case_title' | 'case_source' | 'prompt_variant'> & {
    pair_id: string;
    pair_title: string;
    round_id?: string;
    case_ids?: [string, string];
  };
}

/** An explicit pair with its votes already collapsed across both orders. */
export interface ExplicitPair {
  id: string;
  title: string;
  prompt: string;
  a: string;
  b: string;
  ownerChoice: 'a' | 'b' | 'tie' | null;
  ownerReason: string;
  standard: { id: string; version: number } | null;
  votes: (PairVote & { model: string; family: string })[];
}

export interface TrainingExport {
  examples: ExampleRow[];
  gold: GoldRow[];
  rewards: RewardRow[];
  pairs: PairRow[];
  counts: {
    examples: number;
    gold: number;
    rewards: number;
    pairs: number;
    pairs_compared: number;
    pairs_derived: number;
    cases: number;
    rounds: number;
    excluded_false_settles: number;
    excluded_unsettled: number;
  };
}

/** A verdict as a 0..1 score on the standard's own ordinal scale. */
export function scoreOf(verdict: string, rubric: RubricVersion): number | null {
  if (verdict === ABSTAIN) return null;
  const level = rubric.scale.find((s) => s.id === verdict);
  if (!level) return null;
  const ranks = rubric.scale.map((s) => s.rank);
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  if (hi === lo) return 1;
  return (level.rank - lo) / (hi - lo);
}

function labelOf(verdict: string, rubric: RubricVersion): string {
  return rubric.scale.find((s) => s.id === verdict)?.label ?? verdict;
}

function systemLine(rubric: RubricVersion): string {
  const scale = [...rubric.scale].sort((a, b) => b.rank - a.rank).map((s) => s.label).join(' / ');
  return `You grade a transcript against Standards v${rubric.version}. Answer with one verdict (${scale}) and one sentence of reason.`;
}

/** The rationale a settled case carries: the most common reason, then the longest. */
function majorityReason(votes: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.reason, (counts.get(v.reason) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? '';
}

export function buildTrainingExport(args: {
  projectName: string;
  seats: Grader[];
  traces: Map<string, Trace>;
  rounds: TrainingRound[];
  pairs?: ExplicitPair[];
  now?: string;
}): TrainingExport {
  const now = args.now ?? new Date().toISOString();
  const seatById = new Map(args.seats.map((s) => [s.id, s]));
  const examples: ExampleRow[] = [];
  const gold: GoldRow[] = [];
  const rewards: RewardRow[] = [];
  const pairs: PairRow[] = [];
  let cases = 0;
  let excludedFalse = 0;
  let excludedUnsettled = 0;

  for (const round of args.rounds) {
    const byItem = new Map<string, Grade[]>();
    for (const g of round.grades) {
      if (!seatById.has(g.graderId)) continue;
      byItem.set(g.itemId, [...(byItem.get(g.itemId) ?? []), g]);
    }
    const owner = new Map(round.userVerdicts.map((v) => [v.itemId, v]));
    // The round's cases with their ensemble level, for pairing by prompt.
    const gradedCases: GradedCase[] = [];

    for (const item of round.items) {
      const trace = args.traces.get(item.traceId);
      if (!trace) continue;
      cases++;
      const grades = byItem.get(item.id) ?? [];
      const votes: SeatVote[] = grades.map((g) => ({
        seatId: g.graderId,
        seatName: seatById.get(g.graderId)?.name ?? 'seat',
        verdict: g.verdict,
        reason: g.note,
      }));
      const reading = readCase(item.id, votes);
      {
        // The owner's word outranks the ensemble for pairing, as it does for gold.
        const uvHere = owner.get(item.id);
        const ensemble = ensembleVerdict(
          grades.map((g) => ({ verdict: g.verdict, weight: seatById.get(g.graderId)?.weight ?? 1, stable: g.variantAgreement >= 1 })),
          round.rubric.scale,
        );
        const verdict = uvHere?.verdict ?? ensemble.verdict;
        const rank = verdict === null ? null : (round.rubric.scale.find((s) => s.id === verdict)?.rank ?? null);
        gradedCases.push({ id: trace.id, title: trace.title, content: trace.content, rank, verdict });
      }
      const provenance: Provenance = {
        project: args.projectName,
        round_id: round.id,
        round_name: round.name,
        standard_id: round.rubric.id,
        standard_version: round.rubric.version,
        case_id: trace.id,
        case_title: trace.title,
        case_source: trace.source,
        prompt_variant: 0,
        exported_at: now,
      };
      const uv = owner.get(item.id);
      const judges = grades.map((g) => {
        const seat = seatById.get(g.graderId)!;
        return { seat: seat.name, model: round.pinnedModels[seat.name] ?? seat.model, family: seat.family, verdict: g.verdict, reason: g.note, stake: seat.objective };
      });

      // Reward rows: every real judgment, whatever the case's pattern. The
      // pattern travels with the row so a consumer can filter to settled.
      for (const j of judges) {
        if (j.verdict === ABSTAIN) continue;
        rewards.push({
          kind: 'reward',
          input: trace.content,
          judge: { seat: j.seat, model: j.model, family: j.family, stake: j.stake },
          verdict: j.verdict,
          score: scoreOf(j.verdict, round.rubric),
          rationale: j.reason,
          case_pattern: reading.pattern,
          provenance,
        });
      }

      // Gold: the owner's word, with the panel's beside it.
      if (uv) {
        const panelVerdict = reading.pattern === 'settled' ? votes[0]!.verdict : null;
        gold.push({
          kind: 'gold',
          input: trace.content,
          label: uv.verdict,
          score: scoreOf(uv.verdict, round.rubric),
          rationale: uv.reason,
          adjudicated_by: 'owner',
          panel: { verdict: panelVerdict, pattern: reading.pattern, agreed_with_owner: panelVerdict === null ? null : panelVerdict === uv.verdict },
          messages: [
            { role: 'system', content: systemLine(round.rubric) },
            { role: 'user', content: trace.content },
            { role: 'assistant', content: `${labelOf(uv.verdict, round.rubric)}. ${uv.reason}`.trim() },
          ],
          provenance,
        });
      }

      // Examples: settled only, and never a settle the owner overruled.
      if (reading.pattern !== 'settled') {
        excludedUnsettled++;
        continue;
      }
      const verdict = votes[0]!.verdict;
      if (uv && uv.verdict !== verdict) {
        excludedFalse++;
        continue;
      }
      const rationale = majorityReason(votes);
      examples.push({
        kind: 'example',
        input: trace.content,
        label: verdict,
        score: scoreOf(verdict, round.rubric),
        rationale,
        basis: uv ? 'panel-settled, owner-checked' : 'panel-settled, provisional',
        judges: judges.map(({ stake: _stake, ...j }) => j),
        messages: [
          { role: 'system', content: systemLine(round.rubric) },
          { role: 'user', content: trace.content },
          { role: 'assistant', content: `${labelOf(verdict, round.rubric)}. ${rationale}`.trim() },
        ],
        provenance,
      });
    }

    // Derived pairs: two graded transcripts, one prompt, different levels.
    for (const p of derivePairs(gradedCases)) {
      const chosenOwner = owner.get(round.items.find((i) => i.traceId === p.chosen.id)?.id ?? '');
      const rejectedOwner = owner.get(round.items.find((i) => i.traceId === p.rejected.id)?.id ?? '');
      pairs.push({
        kind: 'pair',
        prompt: p.prompt,
        chosen: p.chosen.content,
        rejected: p.rejected.content,
        source: 'derived-from-grades',
        support: 1,
        basis: chosenOwner && rejectedOwner ? 'owner-adjudicated' : chosenOwner || rejectedOwner ? 'panel, owner-checked' : 'panel, provisional',
        judges: [],
        rationale: `${p.chosen.title} graded ${p.chosen.verdict}; ${p.rejected.title} graded ${p.rejected.verdict}, on the same prompt.`,
        provenance: {
          project: args.projectName,
          standard_id: round.rubric.id,
          standard_version: round.rubric.version,
          exported_at: now,
          pair_id: `${p.chosen.id}+${p.rejected.id}`,
          pair_title: `${p.chosen.title} over ${p.rejected.title}`,
          round_id: round.id,
          case_ids: [p.chosen.id, p.rejected.id],
        },
      });
    }
  }

  // Explicit pairs: the owner's word first, then the panel's when it holds.
  let compared = 0;
  for (const p of args.pairs ?? []) {
    const outcome = pairOutcome(p.votes);
    const winner = p.ownerChoice && p.ownerChoice !== 'tie' ? p.ownerChoice : outcome.winner;
    if (!winner) continue;
    if (p.ownerChoice === 'tie') continue;
    compared++;
    const [chosen, rejected] = winner === 'a' ? [p.a, p.b] : [p.b, p.a];
    const majority = p.votes.filter((v) => v.choice === winner && v.stable !== false).map((v) => ({ reason: v.reason }));
    pairs.push({
      kind: 'pair',
      prompt: p.prompt,
      chosen,
      rejected,
      source: 'panel-compared',
      support: p.ownerChoice ? 1 : outcome.support,
      basis: p.ownerChoice ? 'owner-adjudicated' : 'panel, provisional',
      judges: p.votes.map((v) => ({ seat: v.seatName, model: v.model, family: v.family, choice: v.choice, stable: v.stable ?? null, reason: v.reason })),
      rationale: p.ownerChoice ? p.ownerReason || `The owner preferred ${winner.toUpperCase()}.` : majorityReason(majority),
      provenance: {
        project: args.projectName,
        standard_id: p.standard?.id ?? '',
        standard_version: p.standard?.version ?? 0,
        exported_at: now,
        pair_id: p.id,
        pair_title: p.title,
      },
    });
  }

  return {
    examples,
    gold,
    rewards,
    pairs,
    counts: {
      examples: examples.length,
      gold: gold.length,
      rewards: rewards.length,
      pairs: pairs.length,
      pairs_compared: compared,
      pairs_derived: pairs.length - compared,
      cases,
      rounds: args.rounds.length,
      excluded_false_settles: excludedFalse,
      excluded_unsettled: excludedUnsettled,
    },
  };
}

export const toJsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
