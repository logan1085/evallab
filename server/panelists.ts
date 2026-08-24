/**
 * The panel's providers: who writes the seats, and who sits in them.
 *
 * Family diversity is the product, not a config option (PoLL, arXiv
 * 2404.18796; self-preference, arXiv 2404.13076). Three adapters exist:
 * Anthropic, OpenAI, Google, each used only when its key is present. Seats
 * are spread across available families round-robin; when fewer than three
 * families have keys, the shortfall is reported, never papered over.
 *
 * The offline scorer exists so the whole loop runs with no keys at all: a
 * deterministic function of (seat, case) with per-persona bias, clearly
 * labeled simulated. It produces real disagreement structure, which is what
 * the UI and tests need, and no judgment, which it says out loud.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  buildPanelSystemPrompt,
  buildPanelUserPrompt,
  buildSeatSystemPrompt,
  panelJsonSchema,
  SEAT_VERDICT_SCHEMA,
  type Seat,
} from '../shared/panel.js';
import { DrafterError } from './drafter.js';
import { OPENROUTER_MODELS, openrouterJson, openrouterKey } from './openrouter.js';

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
  score(req: ScoreRequest): Promise<SeatVerdict>;
}

const ANTHROPIC_PANEL_MODEL = process.env.GR_PANEL_MODEL_ANTHROPIC ?? 'claude-haiku-4-5-20251001';
const OPENAI_PANEL_MODEL = process.env.GR_PANEL_MODEL_OPENAI ?? 'gpt-5-mini';
const GOOGLE_PANEL_MODEL = process.env.GR_PANEL_MODEL_GOOGLE ?? 'gemini-2.5-flash';

/**
 * Families with a key present, in preference order. A direct provider key
 * wins its family; OPENROUTER_API_KEY fills every family that has no direct
 * key, which is how one key yields the three-family spread the product wants.
 * Offline fills to one only when nothing real is available.
 */
export function availableFamilies(): FamilyAdapter[] {
  const out: FamilyAdapter[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push(anthropicAdapter());
  if (process.env.OPENAI_API_KEY) out.push(openaiAdapter());
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) out.push(googleAdapter());
  if (openrouterKey()) {
    for (const family of ['anthropic', 'openai', 'google'] as const) {
      if (!out.some((a) => a.family === family)) out.push(openrouterAdapter(family));
    }
  }
  if (out.length === 0) out.push(offlineAdapter());
  return out;
}

function openrouterAdapter(family: 'anthropic' | 'openai' | 'google'): FamilyAdapter {
  const model = OPENROUTER_MODELS[family]!;
  return {
    family,
    model,
    real: true,
    async score(req) {
      const parsed = await openrouterJson<unknown>({
        model: req.seat.model.includes('/') ? req.seat.model : model,
        system: buildSeatSystemPrompt(req.seat, req.rubricMarkdown),
        user: `Case: ${req.caseTitle}\n\n${req.caseContent}`,
        schema: SEAT_VERDICT_SCHEMA,
        maxTokens: 300,
      });
      return normalizeVerdict(parsed);
    },
  };
}

export function adapterFor(family: string): FamilyAdapter {
  const found = availableFamilies().find((a) => a.family === family);
  return found ?? offlineAdapter();
}

function anthropicAdapter(): FamilyAdapter {
  const client = new Anthropic();
  return {
    family: 'anthropic',
    model: ANTHROPIC_PANEL_MODEL,
    real: true,
    async score(req) {
      const response = await client.messages.create({
        model: req.seat.model || ANTHROPIC_PANEL_MODEL,
        max_tokens: 300,
        system: buildSeatSystemPrompt(req.seat, req.rubricMarkdown),
        messages: [{ role: 'user', content: `Case: ${req.caseTitle}\n\n${req.caseContent}` }],
        output_config: { format: { type: 'json_schema', schema: SEAT_VERDICT_SCHEMA } },
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return normalizeVerdict(JSON.parse(text));
    },
  };
}

/** Minimal fetch adapters: family diversity without two more SDK dependencies. */
function openaiAdapter(): FamilyAdapter {
  return {
    family: 'openai',
    model: OPENAI_PANEL_MODEL,
    real: true,
    async score(req) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: req.seat.model || OPENAI_PANEL_MODEL,
          messages: [
            { role: 'system', content: buildSeatSystemPrompt(req.seat, req.rubricMarkdown) },
            { role: 'user', content: `Case: ${req.caseTitle}\n\n${req.caseContent}` },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) throw new DrafterError('api', `OpenAI returned ${res.status} for a panel verdict.`);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return normalizeVerdict(JSON.parse(body.choices[0]!.message.content));
    },
  };
}

function googleAdapter(): FamilyAdapter {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return {
    family: 'google',
    model: GOOGLE_PANEL_MODEL,
    real: true,
    async score(req) {
      const model = req.seat.model || GOOGLE_PANEL_MODEL;
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: buildSeatSystemPrompt(req.seat, req.rubricMarkdown) }] },
            contents: [{ role: 'user', parts: [{ text: `Case: ${req.caseTitle}\n\n${req.caseContent}` }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      );
      if (!res.ok) throw new DrafterError('api', `Google returned ${res.status} for a panel verdict.`);
      const body = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
      return normalizeVerdict(JSON.parse(body.candidates[0]!.content.parts.map((p) => p.text).join('')));
    },
  };
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
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'No reason given.';
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
  write(description: string, count: number): Promise<{ name: string; objective: string; failsFor: string }[]>;
}

export function resolvePanelWriter(): PanelWriter {
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    const model = process.env.GR_DRAFT_MODEL ?? 'claude-opus-5';
    return {
      id: 'anthropic',
      real: true,
      async write(description, count) {
        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: buildPanelSystemPrompt(),
          messages: [{ role: 'user', content: buildPanelUserPrompt(description, count) }],
          output_config: { format: { type: 'json_schema', schema: panelJsonSchema(count) } },
        });
        if (response.stop_reason === 'refusal') {
          throw new DrafterError('refusal', 'The model declined to design a panel from this description.');
        }
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const parsed = JSON.parse(text) as { seats: { name: string; objective: string; failsFor: string }[] };
        return parsed.seats.slice(0, count);
      },
    };
  }
  if (openrouterKey()) {
    return {
      id: 'openrouter',
      real: true,
      async write(description, count) {
        const parsed = await openrouterJson<{ seats: { name: string; objective: string; failsFor: string }[] }>({
          model: OPENROUTER_MODELS.anthropic!,
          system: buildPanelSystemPrompt(),
          user: buildPanelUserPrompt(description, count),
          schema: panelJsonSchema(count),
          maxTokens: 4096,
        });
        return parsed.seats.slice(0, count);
      },
    };
  }
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
