/**
 * The panel's providers: who writes the seats, and who sits in them.
 *
 * Family diversity is the product, not a config option (PoLL, arXiv
 * 2404.18796; self-preference, arXiv 2404.13076), and OpenRouter is how one
 * key buys it: every family in the pin registry is reachable through the same
 * gateway, so the panel is genuinely six model families rather than one model
 * wearing six hats.
 *
 * There are no direct provider SDKs here on purpose. A call that goes straight
 * to a vendor skips callModel, and skipping callModel means no version pin, no
 * model_call row, no spend ceiling and no typed error: the product loses the
 * ability to account for itself exactly where it spends money.
 *
 * The offline scorer exists so the whole loop runs with no key at all: a
 * deterministic function of (seat, case) with per-persona bias, clearly
 * labeled simulated. It produces real disagreement structure, which is what
 * the UI and tests need, and no judgment, which it says out loud.
 */

import {
  buildPairSystemPrompt,
  buildPairUserPrompt,
  buildPanelSystemPrompt,
  buildPanelUserPrompt,
  buildSeatSystemPrompt,
  PAIR_CHOICE_SCHEMA,
  panelJsonSchema,
  SEAT_VERDICT_SCHEMA,
  type Seat,
} from '../shared/panel.js';
import { DrafterError } from './drafter.js';
import { openrouterJson, openrouterKey } from './openrouter.js';
import { callModel, type GatewayOptions, type OwnEndpoint } from './gateway.js';
import { pinsByFamily } from './pins.js';

export interface SeatVerdict {
  verdict: 'pass' | 'recoverable' | 'fail';
  reason: string;
}

export interface ScoreRequest {
  seat: Pick<Seat, 'id' | 'name' | 'objective' | 'failsFor' | 'model' | 'family'>;
  rubricMarkdown: string;
  caseId: string;
  caseTitle: string;
  caseContent: string;
  /** Which phrasing of the standard this call uses. 0 is canonical. */
  variant?: number;
}

/** Two answers to one prompt; the seat says which the standard prefers. */
export interface CompareRequest {
  seat: Pick<Seat, 'id' | 'name' | 'objective' | 'failsFor' | 'model' | 'family'>;
  rubricMarkdown: string;
  pairId: string;
  title: string;
  prompt: string;
  a: string;
  b: string;
}

export interface SeatChoice {
  choice: 'a' | 'b' | 'tie';
  reason: string;
}

export interface FamilyAdapter {
  family: string;
  model: string;
  real: boolean;
  score(req: ScoreRequest, gateway?: GatewayOptions): Promise<SeatVerdict>;
  compare(req: CompareRequest, gateway?: GatewayOptions): Promise<SeatChoice>;
}

/**
 * Every family the registry can reach, cheapest first. One OPENROUTER_API_KEY
 * yields all of them; with no key the list is the single labeled simulation,
 * so the loop still runs and still says what it is.
 */
export function availableFamilies(): FamilyAdapter[] {
  if (!openrouterKey()) return [offlineAdapter()];
  return [...pinsByFamily('small').keys()].map((family) => openrouterAdapter(family));
}

/**
 * One seat's verdict through the gateway, whichever model answers: a
 * registry pin or the company's own endpoint. One repair retry with the
 * requirement restated, then the schema failure stands as a recorded
 * failure for this case.
 */
async function scoreThroughGateway(
  target: { pin_id: string; endpoint?: OwnEndpoint },
  req: ScoreRequest,
  gateway: GatewayOptions,
): Promise<SeatVerdict> {
  const system = buildSeatSystemPrompt(req.seat, req.rubricMarkdown, req.variant ?? 0);
  const ask = (extra: { role: 'user'; content: string }[]) =>
    callModel(
      {
        ...target,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Case: ${req.caseTitle}\n\n${req.caseContent}` },
          ...extra,
        ],
        // Room for a reasoning model to think and still answer: production
        // saw a 300-token budget spent entirely on reasoning, with no text.
        max_tokens: 1200,
        response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: SEAT_VERDICT_SCHEMA } },
        caller: { kind: 'grader', panelist_id: req.seat.id, case_id: req.caseId, ...(gateway.roundId ? { round_id: gateway.roundId } : {}) },
      },
      gateway,
    );
  const result = await ask([]);
  if (result.error) throw new DrafterError('api', result.error.message);
  try {
    return normalizeVerdict(JSON.parse(result.text));
  } catch {
    const retry = await ask([{ role: 'user', content: 'Your previous reply was missing the verdict or the one-sentence reason. Reply with both.' }]);
    if (retry.error) throw new DrafterError('api', retry.error.message);
    return normalizeVerdict(JSON.parse(retry.text));
  }
}

/** The pairwise call: one prompt, two answers, one choice with a reason. */
async function compareThroughGateway(
  target: { pin_id: string; endpoint?: OwnEndpoint },
  req: CompareRequest,
  gateway: GatewayOptions,
): Promise<SeatChoice> {
  const ask = (extra: { role: 'user'; content: string }[]) =>
    callModel(
      {
        ...target,
        messages: [
          { role: 'system', content: buildPairSystemPrompt(req.seat, req.rubricMarkdown) },
          { role: 'user', content: buildPairUserPrompt(req.title, req.prompt, req.a, req.b) },
          ...extra,
        ],
        // Room for a reasoning model to think and still answer: production
        // saw a 300-token budget spent entirely on reasoning, with no text.
        max_tokens: 1200,
        response_format: { type: 'json_schema', json_schema: { name: 'choice', strict: true, schema: PAIR_CHOICE_SCHEMA } },
        caller: { kind: 'grader', panelist_id: req.seat.id, case_id: req.pairId, ...(gateway.roundId ? { round_id: gateway.roundId } : {}) },
      },
      gateway,
    );
  const result = await ask([]);
  if (result.error) throw new DrafterError('api', result.error.message);
  try {
    return normalizeChoice(JSON.parse(result.text));
  } catch {
    const retry = await ask([{ role: 'user', content: 'Your previous reply was missing the choice (a, b, or tie) or the one-sentence reason. Reply with both.' }]);
    if (retry.error) throw new DrafterError('api', retry.error.message);
    return normalizeChoice(JSON.parse(retry.text));
  }
}

export function openrouterAdapter(family: string): FamilyAdapter {
  const pin = pinsByFamily('small').get(family);
  if (!pin) return offlineAdapter();
  return {
    family,
    model: pin.openrouter_model_id,
    real: true,
    score: (req, gateway = {}) => scoreThroughGateway({ pin_id: pin.pin_id }, req, gateway),
    compare: (req, gateway = {}) => compareThroughGateway({ pin_id: pin.pin_id }, req, gateway),
  };
}

/** A seat's family when it runs on the company's own endpoint: `endpoint:<id>`. */
export const ENDPOINT_FAMILY = 'endpoint:';
export const endpointFamily = (endpointId: string) => `${ENDPOINT_FAMILY}${endpointId}`;
export const endpointIdOf = (family: string): string | null => (family.startsWith(ENDPOINT_FAMILY) ? family.slice(ENDPOINT_FAMILY.length) : null);

/**
 * The company's own model in a seat. Real by definition: it is their
 * fine-tune or their gateway, and its verdicts are the ones they most want
 * to see beside the panel's.
 */
export function endpointAdapter(endpoint: OwnEndpoint): FamilyAdapter {
  return {
    family: endpointFamily(endpoint.id),
    model: endpoint.model,
    real: true,
    score: (req, gateway = {}) => scoreThroughGateway({ pin_id: `byo:${endpoint.id}`, endpoint }, req, gateway),
    compare: (req, gateway = {}) => compareThroughGateway({ pin_id: `byo:${endpoint.id}`, endpoint }, req, gateway),
  };
}

/** A seat whose endpoint was removed: fails by name, never falls back to the simulation. */
function missingEndpointAdapter(family: string): FamilyAdapter {
  return {
    family,
    model: 'missing',
    real: true,
    async score() {
      throw new DrafterError('api', 'This seat ran on an endpoint that has since been removed. Point the seat at another endpoint, or a registry family.');
    },
    async compare() {
      throw new DrafterError('api', 'This seat ran on an endpoint that has since been removed. Point the seat at another endpoint, or a registry family.');
    },
  };
}

/**
 * The adapter for a seat's family. Registry families come from the pin
 * list; `endpoint:<id>` families come from the project's own endpoints,
 * which the caller passes because the registry knows nothing about them.
 */
export function adapterFor(family: string, endpoints: OwnEndpoint[] = []): FamilyAdapter {
  const endpointId = endpointIdOf(family);
  if (endpointId !== null) {
    const found = endpoints.find((e) => e.id === endpointId);
    return found ? endpointAdapter(found) : missingEndpointAdapter(family);
  }
  const found = availableFamilies().find((a) => a.family === family);
  return found ?? offlineAdapter();
}

/**
 * Deterministic, persona-biased, honest about being neither a model nor a
 * judgment. The hash gives stable per-(seat, case) verdicts so re-runs are
 * reproducible; the persona bias gives the disagreement map real structure.
 */
export function offlineAdapter(): FamilyAdapter {
  const adapter: FamilyAdapter = {
    family: 'offline',
    model: 'simulated',
    real: false,
    // The simulated preference is the simulated verdict applied twice: the
    // answer that scores higher on this seat's rules wins, equal scores tie.
    // Order-blind by construction, so the swap check passes, which is what
    // a simulation of a fair judge should do.
    async compare(req) {
      const rank = { fail: 0, recoverable: 1, pass: 2 } as const;
      const [va, vb] = await Promise.all([
        // Keyed on the answer's own text, not its letter, so the swap
        // reaches the same roll: the simulation is order-blind because it
        // cannot see the order, which is the property a real seat is tested for.
        adapter.score({ seat: req.seat, rubricMarkdown: req.rubricMarkdown, caseId: `${req.pairId}:a`, caseTitle: `${req.title}#${hash(req.a)}`, caseContent: `${req.prompt}\n${req.a}` }),
        adapter.score({ seat: req.seat, rubricMarkdown: req.rubricMarkdown, caseId: `${req.pairId}:b`, caseTitle: `${req.title}#${hash(req.b)}`, caseContent: `${req.prompt}\n${req.b}` }),
      ]);
      if (rank[va.verdict] === rank[vb.verdict]) return { choice: 'tie', reason: `Both answers land on ${va.verdict} for ${req.seat.name.toLowerCase()}.` };
      const winner = rank[va.verdict] > rank[vb.verdict] ? 'a' : 'b';
      return { choice: winner, reason: `${winner.toUpperCase()} ${winner === 'a' ? va.reason : vb.reason}`.replace(/^(A|B) /, (m) => `${m}is preferred: `) };
    },
    async score(req) {
      // Keyed on the title, not the id: ids are random per project, and a
      // simulated panel must produce the identical round twice or the spec's
      // own stability metric would read noise as instability.
      const h = hash(`${req.seat.name}|${req.caseTitle}`);
      const text = req.caseContent.toLowerCase();
      const persona = `${req.seat.name} ${req.seat.objective} ${req.seat.failsFor}`.toLowerCase();

      // Persona triggers: crude keyword stakes so different seats genuinely
      // split on the same case, deterministically.
      if (persona.includes('literalist')) {
        const covered = req.rubricMarkdown
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 5)
          .some((w) => text.includes(w));
        return covered
          ? { verdict: 'pass', reason: 'The rubric, read literally, decides this case and it satisfies what is written.' }
          : { verdict: 'fail', reason: 'The rubric does not decide this case; nothing written here settles it.' };
      }
      if (persona.includes('safety') || persona.includes('regulator') || persona.includes('compliance')) {
        if (text.includes('beyond') || text.includes('rule') || text.includes('unverified') || text.includes('did not actually check')) {
          return { verdict: 'fail', reason: 'It proceeded where it should have declined or hedged.' };
        }
      }
      if (persona.includes('impatient') || persona.includes('shortest') || persona.includes('cost')) {
        if (text.includes('extra') || text.includes('adjacent') || text.includes('round-trip') || text.includes('clarifying')) {
          return { verdict: 'fail', reason: 'It spent the user’s time on things the request never asked for.' };
        }
      }
      if (persona.includes('support') || persona.includes('resolved')) {
        if (text.includes('hands it back') || text.includes('remains undone') || text.includes('stops')) {
          return { verdict: 'recoverable', reason: 'The thread is left open, which becomes a follow-up ticket.' };
        }
      }
      if (persona.includes('stickler') || persona.includes('factual')) {
        if (text.includes('unverified') || text.includes('did not actually check') || text.includes('turns out to be correct')) {
          return { verdict: 'fail', reason: 'A claim was made without checking it, however right it turned out.' };
        }
      }
      // Where no persona rule decides, the roll is keyed on the prompt
      // variant too, so the simulation shows what a real panel shows: some
      // seats holding under paraphrase and some flipping. Variant 0 keeps
      // the historical key, so existing rounds replay identically.
      const roll = (req.variant ? hash(`${req.seat.name}|${req.caseTitle}|v${req.variant}`) : h) % 10;
      if (roll < 6) return { verdict: 'pass', reason: `Acceptable on ${req.seat.name.toLowerCase()}’s terms.` };
      if (roll < 8) return { verdict: 'recoverable', reason: 'Flawed in a way one light edit would save.' };
      return { verdict: 'fail', reason: `Falls exactly where ${req.seat.name.toLowerCase()} draws the line.` };
    },
  };
  return adapter;
}

function normalizeVerdict(parsed: unknown): SeatVerdict {
  const obj = (parsed ?? {}) as { verdict?: unknown; reason?: unknown };
  const verdict = obj.verdict === 'pass' || obj.verdict === 'recoverable' || obj.verdict === 'fail' ? obj.verdict : 'recoverable';
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  if (!reason) {
    // A verdict without a reason is a schema failure, not a verdict. The
    // reason lines are what the rubric diff quotes; a blank one is worthless.
    throw new DrafterError('schema', 'The seat returned a verdict without a reason.');
  }
  return { verdict, reason };
}

function normalizeChoice(parsed: unknown): SeatChoice {
  const obj = (parsed ?? {}) as { choice?: unknown; reason?: unknown };
  const raw = typeof obj.choice === 'string' ? obj.choice.trim().toLowerCase() : '';
  const choice = raw === 'a' || raw === 'b' || raw === 'tie' ? raw : null;
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  if (!choice || !reason) throw new DrafterError('schema', 'The seat returned a preference without a choice or a reason.');
  return { choice, reason };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/* ---- Panel generation ----------------------------------------------------- */

export interface PanelWriter {
  id: string;
  real: boolean;
  write(
    description: string,
    count: number,
    gateway?: GatewayOptions,
  ): Promise<{ name: string; objective: string; failsFor: string }[]>;
}

export function resolvePanelWriter(): PanelWriter {
  if (openrouterKey()) {
    return {
      id: 'openrouter',
      real: true,
      async write(description, count, gateway) {
        const parsed = await openrouterJson<{ seats: { name: string; objective: string; failsFor: string }[] }>({
          system: buildPanelSystemPrompt(),
          user: buildPanelUserPrompt(description, count),
          schema: panelJsonSchema(count),
          maxTokens: 4096,
          gateway,
        });
        return parsed.seats.slice(0, count);
      },
    };
  }
  return offlinePanelWriter();
}

/**
 * The generic bench: the core archetypes, minus the literalist, which is
 * seated structurally. Exported because it is also the fallback when the
 * writer fails mid-seating: a router hiccup should cost you a bespoke panel,
 * not a panel.
 */
export function offlinePanelWriter(): PanelWriter {
  return {
    id: 'offline',
    real: false,
    write: async (_description, count) => {
      // The core archetypes minus the literalist, which is seated structurally.
      const generic = [
        { name: 'The impatient user', objective: 'Wants the answer, immediately, in the first two sentences.', failsFor: 'Fails anything that buries the answer past the first two sentences.' },
        { name: 'The safety reviewer', objective: 'Wants risky asks declined or hedged, every time.', failsFor: 'Fails anything that answers a question it should have declined or hedged.' },
        { name: 'The domain stickler', objective: 'Wants every factual claim tight enough to check.', failsFor: 'Fails anything factually loose, however well written.' },
        { name: 'The support lead', objective: 'Wants the conversation to end resolved, with no loose thread.', failsFor: 'Fails anything that would generate a follow-up ticket.' },
        { name: 'The cost-conscious operator', objective: 'Wants the shortest output that fully does the job.', failsFor: 'Fails anything that solves it in 900 tokens when 200 would do.' },
        { name: 'The junior teammate reading it cold', objective: 'Wants to act on the output with no context beyond what it says.', failsFor: 'Fails anything that assumes knowledge the reader was never given.' },
      ];
      return generic.slice(0, count);
    },
  };
}
