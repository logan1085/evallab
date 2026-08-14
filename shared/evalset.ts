/**
 * The eval set — what the whole product exists to hand back.
 *
 * A closed poll is a pile of independent human judgments. This turns it into
 * test cases, and the rule for what qualifies is strict on purpose:
 *
 *   unanimous   at least two people voted, none abstained differently, and
 *               every vote landed in the same place — the team's experience
 *               speaks with one voice, so it becomes a test case
 *   resolved    the team disagreed, then settled it explicitly — the settled
 *               answer becomes a test case, carrying the sentence they wrote
 *   excluded    everything else, with the reason stated
 *
 * Nothing is averaged. A 2-1 split does not become a test case with the
 * majority answer, because the point of an eval extracted from people is that
 * the people actually agree — a case exported over a live disagreement would
 * hold the AI to a standard the team itself has not met.
 *
 * Held-back cases are excluded even when unanimous. They exist so the next
 * poll can measure whether the team's agreement is improving on untouched
 * ground; exporting them with answers attached is teaching to the test.
 */

import { ABSTAIN, type Grade, type ItemVerdicts, type Resolution, type RoundItem, type Trace } from './types.js';

export interface EvalCase {
  id: string;
  title: string;
  /** The scenario or transcript, verbatim — the input a judge is given. */
  input: string;
  /** Verdict level id the team settled on. */
  expected: string;
  basis: 'unanimous' | 'resolved';
  /** The team's own words: notes from the poll, or the resolution sentence. */
  evidence: string[];
}

export interface ExcludedCase {
  title: string;
  reason: 'unresolved disagreement' | 'not enough votes' | 'held back for the next poll' | 'withheld while another poll is open';
}

export interface EvalSet {
  cases: EvalCase[];
  excluded: ExcludedCase[];
}

export function buildEvalSet(args: {
  items: RoundItem[];
  traces: Map<string, Trace>;
  verdicts: ItemVerdicts[];
  resolutions: Resolution[];
  grades: Grade[];
  /** Trace ids whose verdicts another open poll is currently using. */
  embargoed: Set<string>;
}): EvalSet {
  const verdictsByItem = new Map(args.verdicts.map((v) => [v.itemId, v.byGrader]));
  const resolutionByItem = new Map(args.resolutions.map((r) => [r.itemId, r]));
  const notesByItem = new Map<string, string[]>();
  for (const grade of args.grades) {
    if (!grade.note.trim()) continue;
    const list = notesByItem.get(grade.itemId) ?? [];
    list.push(grade.note.trim());
    notesByItem.set(grade.itemId, list);
  }

  const cases: EvalCase[] = [];
  const excluded: ExcludedCase[] = [];

  for (const item of args.items) {
    const trace = args.traces.get(item.traceId);
    if (!trace) continue;

    if (item.arm === 'heldout') {
      excluded.push({ title: trace.title, reason: 'held back for the next poll' });
      continue;
    }
    if (args.embargoed.has(item.traceId)) {
      excluded.push({ title: trace.title, reason: 'withheld while another poll is open' });
      continue;
    }

    const resolution = resolutionByItem.get(item.id);
    if (resolution) {
      cases.push({
        id: trace.id,
        title: trace.title,
        input: trace.content,
        expected: resolution.agreedVerdict,
        basis: 'resolved',
        evidence: [resolution.clauseText, resolution.rationale].filter((s) => s.trim().length > 0),
      });
      continue;
    }

    const votes = Object.values(verdictsByItem.get(item.id) ?? {}).filter((v) => v !== ABSTAIN);
    if (votes.length < 2) {
      excluded.push({ title: trace.title, reason: 'not enough votes' });
      continue;
    }
    if (new Set(votes).size === 1) {
      cases.push({
        id: trace.id,
        title: trace.title,
        input: trace.content,
        expected: votes[0]!,
        basis: 'unanimous',
        evidence: notesByItem.get(item.id) ?? [],
      });
      continue;
    }
    excluded.push({ title: trace.title, reason: 'unresolved disagreement' });
  }

  return { cases, excluded };
}

/** One case per line, the shape eval harnesses ingest. */
export function evalSetToJsonl(set: EvalSet): string {
  return set.cases
    .map((c) => JSON.stringify({ input: c.input, expected: c.expected, title: c.title, basis: c.basis }))
    .join('\n');
}
