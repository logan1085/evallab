/**
 * Domain types for Tacit.
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
  { id: 'recoverable', label: 'recoverable', rank: 1 },
  { id: 'pass', label: 'pass', rank: 2 },
];

/**
 * Where a criterion came from in the team's own written operations.
 *
 * A criterion drafted from a policy has to be traceable back to the sentence it
 * encodes, for the same reason a clause carries the trace that produced it: the
 * question "why does the rubric say this?" must always have an answer that is
 * not "a model decided". The quote is verbatim so a person can check that the
 * translation from policy to test did not quietly add or drop a condition.
 */
export interface CriterionSource {
  /** Title of the operating document. */
  document: string;
  /** The sentence in that document this criterion encodes, quoted verbatim. */
  quote: string;
}

export interface RubricCriterion {
  id: string;
  title: string;
  body: string;
  /** Set when drafted from a document. Null or absent when a human wrote it. */
  source?: CriterionSource | null;
}

/** What a company's written operations say they do. Read, never graded. */
export type DocumentKind = 'policy' | 'sop' | 'decision' | 'other';

export interface OperatingDocument {
  id: string;
  projectId: string;
  title: string;
  kind: DocumentKind;
  content: string;
  createdAt: string;
}

/**
 * A place the written operations cannot be turned into a test.
 *
 * This is the honest half of "translate your operations into evals". Real
 * policies contradict themselves and contain sentences nobody could check from
 * a transcript, and a drafter that silently produced a clean rubric from a
 * messy one would be hiding the most useful thing it found. A conflict is
 * never converted into a criterion — it is handed back for a human to settle.
 */
export type ConflictKind = 'contradiction' | 'untestable';

export interface DraftConflict {
  id: string;
  kind: ConflictKind;
  /** What the documents say, in the team's own words. */
  statement: string;
  /** Why it cannot become a test as written. */
  detail: string;
  /** Documents involved, by title. */
  documents: string[];
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

/**
 * A decision the rubric does not settle yet.
 *
 * These are the inverse of clauses. A clause is an answer the team earned by
 * disagreeing on a real trace; an open question is a disagreement they have not
 * had yet but almost certainly will. Naming them is the honest half of drafting
 * a rubric from examples: a handful of transcripts cannot possibly settle every
 * case, and a draft that pretends otherwise is the thing this product exists to
 * argue against.
 */
export interface DraftQuestion {
  id: string;
  question: string;
  /** What in the examples left it open. Provenance, same as a clause carries. */
  why: string;
}

/**
 * Where a drafted rubric came from. Null when a human wrote the rubric.
 *
 * A drafted rubric has never been read by a second person, so every number
 * computed against it is a first draft's number. The UI leans on this to say so.
 */
export interface DraftProvenance {
  provider: string;
  model: string;
  /** How the team described their agent when they asked for a draft. */
  describedAs: string;
  /** Operating documents read. */
  documentCount: number;
  exampleCount: number;
  /** True when transcripts were trimmed to fit the request. */
  truncated: boolean;
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
  /** Carried forward across versions until a resolution answers one and a human removes it. */
  openQuestions: DraftQuestion[];
  /** Rules from the team's documents that could not become tests. Unresolved by design. */
  conflicts: DraftConflict[];
  draftedFrom: DraftProvenance | null;
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
  /** The owner's call: what should happen on this scenario. Null until made. */
  expectedVerdict: string | null;
  /** Why, in the owner's words. Travels onto the exported test case. */
  expectedReason: string;
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
  /** The product's honest headline: set once the owner has graded their ten. */
  falseSettleRate: number | null;
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

export type GraderKind = 'human' | 'panelist' | 'owner';

export interface Grader {
  id: string;
  projectId: string;
  name: string;
  /** 'human' is a person; 'panelist' is a model wearing a perspective; 'owner' is the user checking the panel. */
  kind: GraderKind;
  /** Panelist seats only; empty strings for humans. */
  objective: string;
  failsFor: string;
  model: string;
  family: string;
  origin: string;
  archetypeId: string | null;
  weight: number;
  sameFamilyAsSut: boolean;
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
  /** What the company is and what its AI is supposed to do — the seed everything grows from. */
  description: string;
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
  /**
   * Set when this trace is also in a round that is still open, so its verdicts
   * are withheld until that round closes. Reusing a held-out set across rounds
   * is the whole before-and-after design, and it only works if a grader in the
   * later round cannot look up how everyone graded the same trace last time.
   */
  embargoed?: boolean;
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
