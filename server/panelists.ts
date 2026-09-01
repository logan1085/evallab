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
  buildPanelSystemPrompt,
  buildPanelUserPrompt,
  buildSeatSystemPrompt,
  panelJsonSchema,
  SEAT_VERDICT_SCHEMA,
  type Seat,
} from '../shared/panel.js';
import { DrafterError } from './drafter.js';
import { openrouterJson, openrouterKey } from './openrouter.js';
import { callModel, type GatewayOptions } from './gateway.js';
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
}

export interface FamilyAdapter {
  family: string;
  model: string;
  real: boolean;
  score(req: ScoreRequest, gateway?: GatewayOptions): Promise<SeatVerdict>;
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

export function openrouterAdapter(family: string): FamilyAdapter {
  const pin = pinsByFamily('small').get(family);
  if (!pin) return offlineAdapter();
  return {
    family,
    model: pin.openrouter_model_id,
    real: true,
    async score(req, gateway = {}) {
      const result = await callModel(
        {
          pin_id: pin.pin_id,
          messages: [
            { role: 'system', content: buildSeatSystemPrompt(req.seat, req.rubricMarkdown) },
            { role: 'user', content: `Case: ${req.caseTitle}\n\n${req.caseContent}` },
          ],
          max_tokens: 300,
          response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: SEAT_VERDICT_SCHEMA } },
          caller: { kind: 'grader', panelist_id: req.seat.id, case_id: req.caseId, ...(gateway.roundId ? { round_id: gateway.roundId } : {}) },
        },
        gateway,
      );
      if (result.error) throw new DrafterError('api', result.error.message);
      try {
        return normalizeVerdict(JSON.parse(result.text));
      } catch {
        // One repair retry with the requirement restated, then the schema
        // failure stands as a recorded failure for this case.
        const retry = await callModel(
          {
            pin_id: pin.pin_id,
            messages: [
              { role: 'system', content: buildSeatSystemPrompt(req.seat, req.rubricMarkdown) },
              { role: 'user', content: `Case: ${req.caseTitle}\n\n${req.caseContent}` },
              { role: 'user', content: 'Your previous reply was missing the verdict or the one-sentence reason. Reply with both.' },
            ],
            max_tokens: 300,
            response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: SEAT_VERDICT_SCHEMA } },
            caller: { kind: 'grader', panelist_id: req.seat.id, case_id: req.caseId, ...(gateway.roundId ? { round_id: gateway.roundId } : {}) },
          },
          gateway,
        );
        if (retry.error) throw new DrafterError('api', retry.error.message);
        return normalizeVerdict(JSON.parse(retry.text));
      }
    },
  };
}

export function adapterFor(family: string): FamilyAdapter {
  const found = availableFamilies().find((a) => a.family === family);
  return found ?? offlineAdapter();
}

/**
 * Deterministic, persona-biased, honest about being neither a model nor a
 * judgment. The hash gives stable per-(seat, case) verdicts so re-runs are
 * reproducible; the persona bias gives the disagreement map real structure.
 */
export function offlineAdapter(): FamilyAdapter {
  return {
    family: 'offline',
    model: 'simulated',
    real: false,
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
      const roll = h % 10;
      if (roll < 6) return { verdict: 'pass', reason: `Acceptable on ${req.seat.name.toLowerCase()}’s terms.` };
      if (roll < 8) return { verdict: 'recoverable', reason: 'Flawed in a way one light edit would save.' };
      return { verdict: 'fail', reason: `Falls exactly where ${req.seat.name.toLowerCase()} draws the line.` };
    },
  };
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
