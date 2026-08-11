/**
 * Domain types for The Grading Room.
 *
 * The vocabulary here is deliberate. A *round* is one blind grading pass over a
 * sample of traces. A *split* is a trace the graders did not agree on. A
 * *resolution* is the sentence a split produces, which becomes a rubric clause.
 * Everything else is scaffolding around those three nouns.
 */

/** A point on the verdict scale. `rank` orders the scale; distance between ranks classifies splits. */
export interface VerdictLevel {
  id: string;
  label: string;
  /** 0 = worst. Ordinal position, used for ordinal alpha and split severity. */
  rank: number;
}

/** The reserved verdict for "this trace does not give me enough to judge". Never counted as agreement. */
export const ABSTAIN = 'abstain';

export const DEFAULT_SCALE: VerdictLevel[] = [
  { id: 'fail', label: 'fail', rank: 0 },
  { id: 'partial', label: 'partial', rank: 1 },
  { id: 'pass', label: 'pass', rank: 2 },
];

export interface RubricCriterion {
  id: string;
  title: string;
  body: string;
}

/**
 * A clause is the output of a resolved split: one sentence the rubric did not
 * contain before. Clauses carry their provenance so you can always answer
 * "why does the rubric say this?" with a specific trace.
 */
export interface RubricClause {
  id: string;
  text: string;
  /** The round item (trace-in-round) whose disagreement produced this clause. */
  originItemId: string | null;
  originRoundId: string | null;
  createdAt: string;
}

export interface RubricVersion {
  id: string;
  projectId: string;
  version: number;
  parentVersionId: string | null;
  name: string;
  /** Free text: what the rubric is asking graders to decide. */
  preamble: string;
  scale: VerdictLevel[];
  criteria: RubricCriterion[];
  clauses: RubricClause[];
  createdAt: string;
}

export interface Trace {
  id: string;
  projectId: string;
  /** Short human label, shown in split reports. */
  title: string;
  /** The transcript itself. Plain text or JSON; rendered verbatim. */
  content: string;
  /** Where it came from: 'paste' | 'jsonl' | 'csv' | 'seed' | platform name. */
  source: string;
  /** Opaque metadata carried through from an export, shown collapsed. */
  meta: Record<string, unknown>;
  createdAt: string;
}

export type RoundStatus = 'open' | 'closed';
export type SamplingStrategy = 'random' | 'from_splits';
/** Calibration items drive rubric edits; heldout items measure whether the edits worked. */
export type ItemArm = 'calibration' | 'heldout';

export interface Round {
  id: string;
  projectId: string;
  rubricVersionId: string;
  index: number;
  name: string;
  status: RoundStatus;
  strategy: SamplingStrategy;
  /** Seed for the sampler, stored so a round's sample is reproducible and auditable. */
  seed: string;
  /** The round this one drew its splits from, when strategy is from_splits. */
  sourceRoundId: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface RoundItem {
  id: string;
  roundId: string;
  traceId: string;
  arm: ItemArm;
  position: number;
}

export interface Grader {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}

export interface Grade {
  id: string;
  itemId: string;
  graderId: string;
  /** A verdict level id, or ABSTAIN. */
  verdict: string;
  note: string;
  /** Milliseconds of attention. Feeds the 30-minute budget readout. */
  elapsedMs: number;
  createdAt: string;
}

export interface Resolution {
  id: string;
  itemId: string;
  /** What the group settled on. */
  agreedVerdict: string;
  /** The sentence the rubric was missing. Becomes a clause. */
  clauseText: string;
  /** Optional: why, for the record. Not promoted into the rubric. */
  rationale: string;
  clauseId: string | null;
  resolvedBy: string;
  createdAt: string;
}

export interface Project {
  id: string;
  slug: string;
  /** The only credential in v1. Shared link is the auth model, by design. */
  token: string;
  name: string;
  createdAt: string;
}

/* ---- Derived / computed shapes ------------------------------------------ */

export type SplitKind = 'unanimous' | 'adjacent' | 'polar' | 'scattered';

export interface ItemVerdicts {
  itemId: string;
  /** graderId -> verdict id (ABSTAIN included) */
  byGrader: Record<string, string>;
}

export interface SplitReportRow {
  itemId: string;
  traceId: string;
  title: string;
  arm: ItemArm;
  kind: SplitKind;
  /** Distinct non-abstain verdicts present, ordered by rank descending. */
  verdicts: string[];
  /** Max ordinal distance between verdicts. 0 when unanimous. */
  spread: number;
  byGrader: Record<string, string>;
  abstentions: number;
  gradedBy: number;
  /** Cluster key: the kind of disagreement, e.g. "pass|fail". Splits group by this. */
  clusterKey: string;
  resolved: boolean;
}

export interface AgreementStats {
  /** Units (items) with at least two non-abstain verdicts. Everything is computed over these. */
  units: number;
  raters: number;
  /** Mean pairwise agreement, 0..1. The intuitive number. */
  observed: number;
  /** Chance-corrected. Null when there is not enough data to compute honestly. */
  alphaNominal: number | null;
  alphaOrdinal: number | null;
  /** Bootstrap CI over the observed statistic. Null when units < MIN_UNITS_FOR_CI. */
  observedCI: [number, number] | null;
  /** Per-pair observed agreement, keyed "graderA|graderB". */
  pairwise: Record<string, { agreed: number; compared: number; rate: number }>;
  /** Honest caveats to render next to the numbers, never hidden behind a tooltip. */
  caveats: string[];
}

export interface CoverageStats {
  /** Items in scope. */
  items: number;
  /** Grade slots filled / slots expected (graders x items). */
  participation: number;
  /** Share of submitted grades that were abstentions. */
  abstentionRate: number;
  /** Share of items where every participating grader abstained. */
  undecidableRate: number;
  /** Share of items that at least one clause claims to cover. Rises as the rubric grows. */
  clauseCoverage: number;
}

export interface JudgeRun {
  id: string;
  projectId: string;
  roundId: string;
  rubricVersionId: string;
  provider: string;
  model: string;
  arm: ItemArm;
  createdAt: string;
}

export interface JudgeVerdict {
  id: string;
  runId: string;
  itemId: string;
  verdict: string;
  rationale: string;
}
