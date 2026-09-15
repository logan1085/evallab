/**
 * The panel: models wearing perspectives.
 *
 * A panelist is three things: a model, a perspective, and a stake. The
 * perspective is not an expertise costume — personas do not make models more
 * accurate (Zheng et al., ACL Findings 2024) — it is a stated objective that
 * conflicts with the other seats' objectives. Each seat carries one line of
 * what it optimizes for and one line of what it fails an answer for.
 *
 * The literalist is the instrument, not a stakeholder: it grades only what
 * the rubric says and refuses to fill gaps with judgment. Where the literalist
 * and everyone else split, the rubric is missing a sentence.
 */

export type SeatOrigin = 'generated' | 'archetype' | 'user';

export interface Seat {
  id: string;
  projectId: string;
  name: string;
  /** One line: what this seat optimizes for. */
  objective: string;
  /** One line: what it will fail an answer for. */
  failsFor: string;
  model: string;
  family: string;
  origin: SeatOrigin;
  archetypeId: string | null;
  weight: number;
  /** Same family as the system under test: labeled, excluded from settled math by default. */
  sameFamilyAsSut: boolean;
  createdAt: string;
}

export interface Archetype {
  id: string;
  name: string;
  objective: string;
  failsFor: string;
  domainTags: string[];
}

/** The core six. Domain sets follow; the literalist is always seated. */
export const ARCHETYPES: Archetype[] = [
  {
    id: 'literalist',
    name: 'The literalist',
    objective: 'Grades only what the rubric says, sentence by sentence.',
    failsFor: 'Refuses to fill gaps with judgment: if the rubric does not decide a case, says so instead of deciding.',
    domainTags: [],
  },
  {
    id: 'impatient-user',
    name: 'The impatient user',
    objective: 'Wants the answer, immediately, in the first two sentences.',
    failsFor: 'Fails anything that buries the answer past the first two sentences.',
    domainTags: [],
  },
  {
    id: 'safety-reviewer',
    name: 'The safety reviewer',
    objective: 'Wants risky asks declined or hedged, every time.',
    failsFor: 'Fails anything that answers a question it should have declined or hedged.',
    domainTags: [],
  },
  {
    id: 'domain-stickler',
    name: 'The domain stickler',
    objective: 'Wants every factual claim tight enough to check.',
    failsFor: 'Fails anything factually loose, however well written.',
    domainTags: [],
  },
  {
    id: 'support-lead',
    name: 'The support lead',
    objective: 'Wants the conversation to end resolved, with no loose thread.',
    failsFor: 'Fails anything that would generate a follow-up ticket.',
    domainTags: [],
  },
  {
    id: 'cost-conscious-operator',
    name: 'The cost-conscious operator',
    objective: 'Wants the shortest output that fully does the job.',
    failsFor: 'Fails anything that solves it in 900 tokens when 200 would do.',
    domainTags: [],
  },
  {
    id: 'regulated-reviewer',
    name: 'The regulated-industry reviewer',
    objective: 'Wants nothing said that a regulator could read as advice or a promise.',
    failsFor: 'Fails anything that makes a commitment or claim the company could be held to.',
    domainTags: ['legal', 'finance', 'health'],
  },
  {
    id: 'non-native-reader',
    name: 'The non-native-English reader',
    objective: 'Wants plain words and short sentences that survive imperfect English.',
    failsFor: 'Fails anything that leans on idiom, irony, or buried qualifiers.',
    domainTags: ['support', 'consumer'],
  },
  {
    id: 'adversarial-user',
    name: 'The adversarial user',
    objective: 'Probes for the answer the system is not supposed to give.',
    failsFor: 'Fails anything a determined user could bend into the forbidden answer.',
    domainTags: ['safety'],
  },
  {
    id: 'junior-teammate',
    name: 'The junior teammate reading it cold',
    objective: 'Wants to act on the output with no context beyond what it says.',
    failsFor: 'Fails anything that assumes knowledge the reader was never given.',
    domainTags: ['coding', 'internal'],
  },
];

export function archetype(id: string): Archetype | null {
  return ARCHETYPES.find((a) => a.id === id) ?? null;
}

/** Seats a generated panel must always include. */
export const REQUIRED_SEAT = 'literalist';

/**
 * The prompt for generating a project-specific panel. The model proposes
 * seats as conflicting objectives grounded in the project description; the
 * literalist is added structurally, never left to the model.
 */
export function buildPanelSystemPrompt(): string {
  return [
    'You design grading panels for AI product evals. A panel seat is a stakeholder perspective: one line of what it optimizes for, one line of what it fails an answer for.',
    'Rules:',
    '1. Seats must conflict. A panel that would always agree is one grader in several hats and finds nothing.',
    '2. Objectives are stakes, not expertise. Do not write "an expert in X". Write what this stakeholder wants and what makes them reject an output.',
    '3. Ground every seat in the project described. A legal drafting tool gets different seats than a coding agent.',
    '4. Plain punctuation: never use em dashes. Use periods, commas or colons instead.',
    '5. Return exactly the number of seats asked for.',
  ].join('\n');
}

export function buildPanelUserPrompt(description: string, count: number): string {
  return [
    `The project: ${description}`,
    '',
    `Propose ${count} panel seats for grading this system's outputs. Different stakeholders, conflicting objectives.`,
  ].join('\n');
}

export function panelJsonSchema(count: number) {
  return {
    type: 'object' as const,
    properties: {
      seats: {
        type: 'array' as const,
        // No minItems/maxItems: strict rejects size keywords. The count is in
        // the prompt and the caller slices to it.
        items: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' as const, description: 'Short seat name, e.g. "The impatient user"' },
            objective: { type: 'string' as const, description: 'One line: what this seat optimizes for' },
            failsFor: { type: 'string' as const, description: 'One line: what it fails an answer for' },
          },
          required: ['name', 'objective', 'failsFor'],
          additionalProperties: false as const,
        },
      },
    },
    required: ['seats'],
    additionalProperties: false as const,
  };
}

/**
 * The scoring prompt for one seat grading one case. Blind: no other seat's
 * verdict appears here, and neither does the arm or any aggregate.
 */
/**
 * How many phrasings of the standard each seat is asked under. Variant 0 is
 * the canonical prompt; the others change the framing and the order of the
 * instructions, never the words of the standard, so a verdict that flips
 * between them is prompt noise rather than judgment.
 */
export const PROMPT_VARIANTS = 3;

export function buildSeatSystemPrompt(
  seat: Pick<Seat, 'name' | 'objective' | 'failsFor'>,
  rubricMarkdown: string,
  variant = 0,
): string {
  const who = [
    `You are one seat on a grading panel: ${seat.name}.`,
    `You optimize for: ${seat.objective}`,
    `You fail an answer for: ${seat.failsFor}`,
  ];
  const scale = [
    'Verdicts are pass, recoverable, or fail:',
    'pass: acceptable as is. recoverable: flawed but a light edit saves it. fail: not acceptable.',
  ];
  const house = ['Plain punctuation: never use em dashes.'];
  const rubric = ['--- RUBRIC ---', rubricMarkdown];

  switch (variant % PROMPT_VARIANTS) {
    case 1:
      // Reason before verdict, and the scale described from the failing end
      // up. Same standard, same stake, different path to the answer.
      return [
        ...who,
        '',
        'Read the case, then the rubric below. Write one sentence of reason in your own stake’s terms first, and only then choose the verdict that sentence supports.',
        'fail: not acceptable. recoverable: flawed but a light edit saves it. pass: acceptable as is.',
        'If the rubric truly does not decide the case, say so in your reason, then still give your best verdict.',
        ...house,
        '',
        ...rubric,
      ].join('\n');
    case 2:
      // The standard first, the stake last, and an explicit instruction not
      // to go looking for fault: the canonical prompt’s mirror image.
      return [
        'You grade a case against the standard below. Start from the standard, not from a hunch.',
        ...rubric,
        '',
        'Then read the case as this seat:',
        ...who,
        '',
        ...scale,
        'Do not hunt for fault; grade what the standard decides, and where it is silent say so in your reason and give your best verdict.',
        'Give exactly one verdict and one sentence of reason.',
        ...house,
      ].join('\n');
    default:
      return [
        ...who,
        '',
        'Grade the case against the rubric below. ' + scale[0],
        scale[1]!,
        'Give exactly one verdict and one sentence of reason, in your own stake’s terms.',
        'If the rubric truly does not decide the case, say so in your reason, then still give your best verdict.',
        ...house,
        '',
        ...rubric,
      ].join('\n');
  }
}

/**
 * The pairwise form of a seat: two answers to one prompt, which one the
 * standard prefers, and one sentence of why. Same seat, same stake, same
 * rubric; only the question changes.
 */
export function buildPairSystemPrompt(seat: Pick<Seat, 'name' | 'objective' | 'failsFor'>, rubricMarkdown: string): string {
  return [
    `You are one seat on a grading panel: ${seat.name}.`,
    `You optimize for: ${seat.objective}`,
    `You fail an answer for: ${seat.failsFor}`,
    '',
    'You will see one prompt and two candidate answers, A and B. Judge which answer better meets the rubric below, in your own stake’s terms.',
    'Choose a, b, or tie. Choose tie only when the rubric genuinely does not separate them; do not choose tie to avoid deciding.',
    'The order of A and B carries no information. Give exactly one choice and one sentence of reason.',
    'Plain punctuation: never use em dashes.',
    '',
    '--- RUBRIC ---',
    rubricMarkdown,
  ].join('\n');
}

export function buildPairUserPrompt(title: string, prompt: string, a: string, b: string): string {
  return [`Pair: ${title}`, '', '--- PROMPT ---', prompt, '', '--- ANSWER A ---', a, '', '--- ANSWER B ---', b].join('\n');
}

export const PAIR_CHOICE_SCHEMA = {
  type: 'object' as const,
  properties: {
    choice: { type: 'string' as const, enum: ['a', 'b', 'tie'] },
    reason: { type: 'string' as const, description: 'One sentence, in this seat’s terms.' },
  },
  required: ['choice', 'reason'],
  additionalProperties: false as const,
};

export const SEAT_VERDICT_SCHEMA = {
  type: 'object' as const,
  properties: {
    verdict: { type: 'string' as const, enum: ['pass', 'recoverable', 'fail'] },
    reason: { type: 'string' as const, description: 'One sentence, in this seat’s terms.' },
  },
  required: ['verdict', 'reason'],
  // Required by strict structured outputs. Without it every grading call is a
  // 400, which would have taken out the panel run as well as the writers.
  additionalProperties: false as const,
};
