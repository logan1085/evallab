/**
 * API client.
 *
 * The shared link is the whole auth model, so the key arrives in the URL once
 * and is then kept in localStorage per project. That is deliberately weak — it
 * is v1's stated scope — and the UI says so on the project page rather than
 * implying there is an account system behind it.
 */

import type {
  AgreementStats,
  CoverageStats,
  DocumentKind,
  Grader,
  ItemArm,
  OperatingDocument,
  Project,
  Resolution,
  Round,
  RubricVersion,
  SplitReportRow,
  Trace,
} from '@shared/types';
import type { SplitCluster } from '@shared/splits';

const KEY_PREFIX = 'grading-room:key:';
const NAME_PREFIX = 'grading-room:grader:';

export function rememberKey(slug: string, token: string) {
  localStorage.setItem(KEY_PREFIX + slug, token);
}
export function recallKey(slug: string): string | null {
  return localStorage.getItem(KEY_PREFIX + slug);
}
export function rememberGrader(slug: string, grader: Grader) {
  localStorage.setItem(NAME_PREFIX + slug, JSON.stringify(grader));
}
export function recallGrader(slug: string): Grader | null {
  const raw = localStorage.getItem(NAME_PREFIX + slug);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Grader;
  } catch {
    return null;
  }
}
export function forgetGrader(slug: string) {
  localStorage.removeItem(NAME_PREFIX + slug);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PairView {
  id: string;
  title: string;
  prompt: string;
  a: string;
  b: string;
  ownerChoice: 'a' | 'b' | 'tie' | null;
  ownerReason: string;
  gradedAt: string | null;
  standards_version: number | null;
  votes: { seatId: string; seatName: string; choice: 'a' | 'b' | 'tie'; reason: string; weight: number; stable?: boolean; model: string; family: string }[];
  outcome: { winner: 'a' | 'b' | null; support: number; counted: number; setAside: number; flipped: number };
  /** The owner's word, else the panel's when it holds; null when neither decides. */
  preferred: 'a' | 'b' | null;
  createdAt: string;
}

/** A scenario write in progress or finished: one entry per part, with the cases each persisted. */
export interface ScenarioJobView {
  id: string;
  description: string;
  parts: { index: number; ground: 'clear' | 'boundary' | 'unimagined'; count: number; status: 'pending' | 'running' | 'done' | 'failed'; error: string; scenarios: number }[];
  status: 'pending' | 'running' | 'done' | 'failed';
  provider: string;
  /** Cases persisted so far, across parts. */
  scenarios: number;
  /** One line per failed part, in the gateway's words. */
  failed: string[];
  pending: number;
  createdAt: string;
  updatedAt: string;
}

/** A company's own endpoint as the Room sees it: never the key, only its hint. */
export interface EndpointView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyHint: string;
  hasKey: boolean;
  createdAt: string;
  /** Names of the seats currently running on it. */
  seats: string[];
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  if (rest.body) headers['content-type'] = 'application/json';
  if (token) headers['x-gr-token'] = token;

  // The UI speaks the same versioned surface agents do. /api/v1 and /api are
  // one router server-side; calling v1 here keeps this client honest about it.
  const res = await fetch(`/api/v1${path}`, { ...rest, headers });
  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text || res.statusText);
    return text as unknown as T;
  }

  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText);
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body);

/* ---- Shapes ------------------------------------------------------------- */

export interface RoundSummary extends Round {
  items: number;
  samplingNote: string;
  rubricVersion: number | null;
}

export interface SeatVoteView {
  seatId: string;
  seatName: string;
  verdict: string;
  reason: string;
  /** False when the seat flipped under paraphrase; shown, never mined. */
  stable: boolean;
  /** Share of prompt variants that agreed with this verdict. */
  agreement: number;
}

export interface PanelCaseView {
  itemId: string;
  traceId: string;
  title: string;
  content: string;
  votes: SeatVoteView[];
  pattern: 'settled' | 'persona-driven' | 'contested' | 'blind-spot' | 'ungraded';
  dissenter: string | null;
  theater: boolean;
  /** The split did not survive paraphrase: the dissent came from an unstable vote. */
  unstableDissent: boolean;
  provisional: boolean;
  checkedByOwner: boolean;
}

export interface PanelMapView {
  round: { id: string; name: string; status: string };
  seats: { id: string; name: string; family: string; model: string; objective: string; weight: number }[];
  cases: PanelCaseView[];
  counts: { settled: number; personaDriven: number; contested: number; blindSpots: number };
  agreement: { observed: number; alpha: number | null; ac1: number | null };
  simulated: boolean;
}

export interface PatchView {
  id: string;
  text: string;
  evidence: { itemId: string; seat: string; quote: string }[];
  seatsSided: string[];
  projectedLift: number | null;
  status: 'proposed' | 'accepted' | 'rejected';
}

export interface ProjectView {
  project: Project;
  rubric: RubricVersion | null;
  traceCount: number;
  documentCount: number;
  graders: Grader[];
  rounds: RoundSummary[];
}

export interface DraftResponse {
  draft: Pick<RubricVersion, 'name' | 'preamble' | 'scale' | 'criteria' | 'openQuestions' | 'conflicts'>;
  provider: { id: string; model: string; real: boolean };
  draftedFrom: NonNullable<RubricVersion['draftedFrom']>;
  usedDocumentIds: string[];
  usedTraceIds: string[];
}

export interface EvalSetView {
  round: { id: string; name: string };
  rubricVersion: number | null;
  judgeSystemPrompt: string | null;
  caseCount: number;
  cases: { id: string; title: string; input: string; expected: string; basis: 'unanimous' | 'resolved'; evidence: string[] }[];
  excluded: { title: string; reason: string }[];
}

export interface Attention {
  minutes: number;
  overBudget: boolean;
  budget: number;
  maxItems: number;
}

export interface RoundView {
  round: Round;
  samplingNote: string;
  itemCount: number;
  arms: { calibration: number; heldout: number };
  attention: Attention;
  progress: { graderId: string; name: string; done: number; elapsedMs: number }[];
  rubric: RubricVersion | null;
}

export interface QueueItem {
  itemId: string;
  position: number;
  title: string;
  content: string;
  meta: Record<string, unknown>;
  myVerdict: string | null;
  myNote: string;
}

export interface QueueView {
  round: { id: string; name: string; status: string };
  rubric: RubricVersion | null;
  grader: Grader;
  items: QueueItem[];
  done: number;
  attention: Attention;
}

export interface ArmStats {
  agreement: AgreementStats;
  coverage: CoverageStats;
}

export interface ReportView {
  round: Round;
  rubric: RubricVersion | null;
  graders: Grader[];
  samplingNote: string;
  rows: SplitReportRow[];
  clusters: SplitCluster[];
  /** Splits that can be resolved: calibration arm, not embargoed. */
  splitCount: number;
  /** Splits in the held-out arm. Counted, never resolvable. */
  heldoutSplitCount: number;
  /** Rows whose verdicts are withheld because another round is grading them now. */
  embargoedCount: number;
  overall: ArmStats;
  calibration: ArmStats;
  heldout: ArmStats;
  resolutions: Resolution[];
  notes: { itemId: string; graderId: string; note: string; verdict: string }[];
}

export interface TrajectoryPoint {
  roundId: string;
  index: number;
  name: string;
  closedAt: string | null;
  strategy: 'random' | 'from_splits';
  rubricVersion: number | null;
  clauseCount: number;
  graderNames: string[];
  heldout: ArmStats;
  calibration: ArmStats;
  splitCount: number;
  resolvedCount: number;
  heldoutSignature: string;
  /** False whenever a delta would be measuring something other than the rubric. */
  comparableToPrevious: boolean;
  comparabilityNotes: string[];
  heldoutDelta: number | null;
}

export interface JudgeRunView {
  id: string;
  provider: string;
  model: string;
  arm: ItemArm;
  createdAt: string;
  rubricVersion: number | null;
  itemCount: number;
  judgeAbstentions: number;
  agreementWithHumans: number | null;
  comparisons: number;
  perGrader: { graderId: string; agreed: number; compared: number; rate: number }[];
  verdicts: { itemId: string; verdict: string; rationale: string }[];
}

/* ---- Endpoints ---------------------------------------------------------- */

function createScenarioJobReq(slug: string, token: string, body: { description: string; count?: number; documentIds?: string[]; ground?: 'clear' | 'boundary' | 'unimagined' }) {
  return call<{ job: ScenarioJobView; provider: { id: string; model: string; real: boolean } }>(`/projects/${slug}/scenario-jobs`, {
    method: 'POST',
    token,
    body: json(body),
  });
}

function getScenarioJobReq(slug: string, token: string, jobId: string) {
  return call<{ job: ScenarioJobView }>(`/projects/${slug}/scenario-jobs/${jobId}`, { token });
}

/**
 * Run the job and read its stream: heartbeats, a line per part as it
 * lands, then the final line. Resolves with the job as the server last
 * reported it. Throws ApiError(0) when the connection dropped before the
 * final line, which is the case the job exists for: the caller polls.
 */
async function runScenarioJobStream(slug: string, token: string, jobId: string, onPart?: (part: ScenarioJobView['parts'][number]) => void): Promise<ScenarioJobView> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/projects/${slug}/scenario-jobs/${jobId}/run`, { method: 'POST', headers: { 'x-gr-token': token } });
  } catch (err) {
    throw new ApiError(0, `The connection dropped before the server answered (${err instanceof Error ? err.message : 'network error'}).`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (!res.body) throw new ApiError(0, 'The server sent no stream.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  type StreamLine = { done?: boolean; job?: ScenarioJobView; error?: string; part?: ScenarioJobView['parts'][number]; tick?: number };
  let last: StreamLine | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const parsed = JSON.parse(line) as StreamLine;
          if (parsed?.part && onPart) onPart(parsed.part);
          if (parsed?.done) last = parsed;
        }
        nl = buffer.indexOf('\n');
      }
    }
  } catch (err) {
    throw new ApiError(0, `The connection dropped while the scenarios were being written (${err instanceof Error ? err.message : 'stream error'}).`);
  }
  if (!last?.job) throw new ApiError(0, 'The connection dropped before the server finished.');
  if (last.error) throw new ApiError(502, last.error);
  return last.job;
}

/**
 * The whole write, the way the Room does it: create, run, and when the
 * run's connection drops, poll the job until it settles. The server keeps
 * writing after the browser loses the connection, so polling sees the
 * parts land. Returns the final job; the caller reads `failed` for the
 * parts that did not.
 */
async function writeScenariosResilient(
  slug: string,
  token: string,
  body: { description: string; count?: number; ground?: 'clear' | 'boundary' | 'unimagined' },
  opts: { jobId?: string; onPart?: (part: ScenarioJobView['parts'][number]) => void; pollForMs?: number } = {},
): Promise<{ job: ScenarioJobView; provider: { id: string; model: string; real: boolean } | null }> {
  let jobId = opts.jobId ?? null;
  let provider: { id: string; model: string; real: boolean } | null = null;
  if (!jobId) {
    const created = await createScenarioJobReq(slug, token, body);
    jobId = created.job.id;
    provider = created.provider;
  }
  try {
    return { job: await runScenarioJobStream(slug, token, jobId, opts.onPart), provider };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 0) throw err;
    // The connection dropped. The server is still writing; watch the job.
    const until = Date.now() + (opts.pollForMs ?? 150_000);
    let lastJob: ScenarioJobView | null = null;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      let seen: ScenarioJobView;
      try {
        seen = (await getScenarioJobReq(slug, token, jobId)).job;
      } catch {
        continue;
      }
      lastJob = seen;
      if (seen.status === 'done' || seen.status === 'failed') return { job: seen, provider };
    }
    const landed = lastJob as ScenarioJobView | null;
    throw new ApiError(0, `${err.message} Waited ${Math.round((opts.pollForMs ?? 150_000) / 1000)} seconds for the write to finish on the server; ${landed ? `${landed.scenarios} cases have landed so far` : 'it has not reported back'}. Job ${jobId}.`);
  }
}

/**
 * Seat the panel, and when the connection drops mid-write, wait for the
 * seats to appear rather than calling it failed: the server finishes the
 * write whether or not the browser is still listening.
 */
type PanelWrite = { seats: Grader[]; families: string[]; familiesShort?: number; generated: boolean; real?: boolean; fallbackReason?: string };

async function seatPanelResilient(slug: string, token: string, pollForMs = 120_000): Promise<PanelWrite> {
  try {
    return await call<PanelWrite>(`/projects/${slug}/panel`, { method: 'POST', token });
  } catch (err) {
    const dropped = !(err instanceof ApiError) || err.status === 0;
    if (!dropped) throw err;
    const until = Date.now() + pollForMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      let view: ProjectView;
      try {
        view = await call<ProjectView>(`/projects/${slug}`, { token });
      } catch {
        continue;
      }
      const seats = view.graders.filter((g) => g.kind === 'panelist');
      if (seats.length >= 3) return { seats, families: [...new Set(seats.map((s) => s.family))], generated: true };
    }
    throw new ApiError(0, `The connection dropped while the panel was being written (${err instanceof Error ? err.message : 'network error'}), and no seats appeared within ${Math.round(pollForMs / 1000)} seconds. Try the seating again; it never overwrites seats that exist.`);
  }
}


export const api = {
  createProject: (name: string, description = '', limits = '') =>
    call<{ project: Project; rubric: RubricVersion; scenarioCount: number; scenariosReal: boolean; seatCount: number }>('/projects', {
      method: 'POST',
      body: json({ name, description, limits }),
    }),

  saveEmail: (slug: string, token: string, email: string) =>
    call<{ ok: boolean }>(`/projects/${slug}/email`, { method: 'POST', token, body: json({ email }) }),

  writeStandards: (roundId: string, token: string) =>
    call<{ rubric: RubricVersion; url: string; sentences: number; alreadyWritten: boolean }>(
      `/rounds/${roundId}/standards`,
      { method: 'POST', token },
    ),

  createDemo: () =>
    call<{ slug: string; token: string; projectId: string; roundId: string }>('/projects/demo', {
      method: 'POST',
      body: json({}),
    }),

  project: (slug: string, token: string) => call<ProjectView>(`/projects/${slug}`, { token }),

  trajectory: (slug: string, token: string) =>
    call<{ series: TrajectoryPoint[]; roundsClosed: number }>(`/projects/${slug}/trajectory`, { token }),

  traces: (slug: string, token: string) => call<{ traces: Trace[] }>(`/projects/${slug}/traces`, { token }),

  addTraces: (slug: string, token: string, traces: { title: string; content: string }[]) =>
    call<{ traces: Trace[] }>(`/projects/${slug}/traces`, { method: 'POST', token, body: json({ traces }) }),

  importTraces: (slug: string, token: string, format: 'jsonl' | 'csv' | 'paste', body: string) =>
    call<{ traces: Trace[]; skipped: number }>(`/projects/${slug}/traces/import`, {
      method: 'POST',
      token,
      body: json({ format, body }),
    }),

  deleteTrace: (slug: string, token: string, traceId: string) =>
    call<void>(`/projects/${slug}/traces/${traceId}`, { method: 'DELETE', token }),

  rubrics: (slug: string, token: string) => call<{ rubrics: RubricVersion[] }>(`/projects/${slug}/rubrics`, { token }),

  saveRubric: (
    slug: string,
    token: string,
    patch: Pick<RubricVersion, 'name' | 'preamble'> &
      Partial<Pick<RubricVersion, 'scale' | 'criteria' | 'openQuestions' | 'conflicts' | 'draftedFrom'>>,
  ) => call<{ rubric: RubricVersion; forked: boolean }>(`/projects/${slug}/rubric`, { method: 'PUT', token, body: json(patch) }),

  draftRubric: (
    slug: string,
    token: string,
    body: {
      description: string;
      documentIds?: string[];
      traceIds?: string[];
      examples?: { title: string; content: string }[];
    },
  ) => call<DraftResponse>(`/projects/${slug}/rubric/draft`, { method: 'POST', token, body: json(body) }),

  documents: (slug: string, token: string) =>
    call<{ documents: OperatingDocument[] }>(`/projects/${slug}/documents`, { token }),

  addDocuments: (
    slug: string,
    token: string,
    documents: { title: string; kind: DocumentKind; content: string }[],
  ) =>
    call<{ documents: OperatingDocument[] }>(`/projects/${slug}/documents`, {
      method: 'POST',
      token,
      body: json({ documents }),
    }),

  deleteDocument: (slug: string, token: string, id: string) =>
    call<void>(`/projects/${slug}/documents/${id}`, { method: 'DELETE', token }),

  evalset: (roundId: string, token: string) =>
    call<EvalSetView>(`/rounds/${roundId}/evalset`, { token }),

  evalsetUrl: (roundId: string, token: string) =>
    `/api/rounds/${roundId}/evalset?format=jsonl&k=${encodeURIComponent(token)}`,

  mintKey: (slug: string, token: string, name: string) =>
    call<{ key: string; id: string; name: string; prefix: string; createdAt: string; note: string }>(
      `/projects/${slug}/keys`,
      { method: 'POST', token, body: JSON.stringify({ name }) },
    ),
  listKeys: (slug: string, token: string) =>
    call<{ keys: { id: string; name: string; prefix: string; createdAt: string; revokedAt: string | null }[] }>(
      `/projects/${slug}/keys`,
      { token },
    ),
  revokeKey: (slug: string, token: string, keyId: string) =>
    call<void>(`/projects/${slug}/keys/${keyId}`, { method: 'DELETE', token }),
  generatePanel: (slug: string, token: string) =>
    call<{ seats: Grader[]; families: string[]; familiesShort?: number; generated: boolean; real?: boolean; fallbackReason?: string }>(
      `/projects/${slug}/panel`,
      { method: 'POST', token },
    ),

  archetypes: (slug: string, token: string) =>
    call<{ archetypes: { id: string; name: string; objective: string; failsFor: string }[] }>(
      `/projects/${slug}/panel/archetypes`,
      { token },
    ),

  addSeat: (
    slug: string,
    token: string,
    body: { archetypeId?: string; name?: string; objective?: string; failsFor?: string; note?: string },
  ) => call<{ seat: Grader }>(`/projects/${slug}/panel/seats`, { method: 'POST', token, body: json(body) }),

  updateSeat: (
    slug: string,
    token: string,
    seatId: string,
    body: { name?: string; objective?: string; failsFor?: string; endpointId?: string | null; note?: string },
  ) => call<{ seat: Grader }>(`/projects/${slug}/panel/seats/${seatId}`, { method: 'PATCH', token, body: json(body) }),

  /* The company's own endpoints: registered per project, never returning the key. */
  endpoints: (slug: string, token: string) =>
    call<{ endpoints: EndpointView[]; secrets: 'env' | 'dev-default' }>(`/projects/${slug}/endpoints`, { token }),
  addEndpoint: (slug: string, token: string, body: { name: string; base_url: string; model: string; api_key?: string }) =>
    call<{ endpoint: EndpointView }>(`/projects/${slug}/endpoints`, { method: 'POST', token, body: json(body) }),
  checkEndpoint: (slug: string, token: string, endpointId: string) =>
    call<{ ok: boolean; model?: string; latency_ms?: number; reply?: string; error?: string }>(
      `/projects/${slug}/endpoints/${endpointId}/check`,
      { method: 'POST', token },
    ),
  deleteEndpoint: (slug: string, token: string, endpointId: string) =>
    call<void>(`/projects/${slug}/endpoints/${endpointId}`, { method: 'DELETE', token }),

  deleteSeat: (slug: string, token: string, seatId: string) =>
    call<void>(`/projects/${slug}/panel/seats/${seatId}`, { method: 'DELETE', token }),

  createPanelRound: (slug: string, token: string) =>
    call<{ round: { id: string }; seats: { id: string; name: string }[]; cases: number }>(
      `/projects/${slug}/panel-rounds`,
      { method: 'POST', token },
    ),

  runSeat: (roundId: string, token: string, seatId: string) =>
    call<{ seat: string; graded: number; simulated: boolean; closed: boolean }>(`/rounds/${roundId}/panel-run`, {
      method: 'POST',
      token,
      body: json({ seatId }),
    }),

  panelMap: (roundId: string, token: string) => call<PanelMapView>(`/rounds/${roundId}/map`, { token }),

  stability: (roundId: string, token: string) =>
    call<{ checked: number; rechecked: number; unstable: number; variants: number; simulated: boolean }>(`/rounds/${roundId}/stability`, {
      method: 'POST',
      token,
    }),

  minePatches: (roundId: string, token: string) =>
    call<{ patches: PatchView[]; dropped: number; contestedTotal?: number }>(`/rounds/${roundId}/patches`, {
      method: 'POST',
      token,
    }),

  decidePatch: (roundId: string, token: string, patchId: string, action: 'accept' | 'reject', text?: string) =>
    call<{ patch: PatchView; rubric?: RubricVersion }>(`/rounds/${roundId}/patches/${patchId}`, {
      method: 'PATCH',
      token,
      body: json({ action, text }),
    }),

  selfCheck: (roundId: string, token: string, reviewer = '') =>
    call<{ reviewer: string; cases: { itemId: string; title: string; content: string; myVerdict: string | null; myReason: string }[]; done: number }>(
      `/rounds/${roundId}/self-check${reviewer ? `?reviewer=${encodeURIComponent(reviewer)}` : ''}`,
      { token },
    ),

  submitSelfCheck: (roundId: string, token: string, body: { itemId: string; verdict: string; reason: string; reviewer?: string }) =>
    call<{ ok: true; reviewer: string }>(`/rounds/${roundId}/self-check`, { method: 'POST', token, body: json(body) }),

  /** Several people on one round: who graded, how far they agree, and where they split. */
  reviewers: (roundId: string, token: string) =>
    call<{
      reviewers: { name: string; graded: number; agreed_with_consensus: number; last_at: string | null }[];
      shared_cases: number;
      alpha: number | null;
      pairwise: { a: string; b: string; items: number; agree: number; rate: number }[];
      disagreements: { itemId: string; title: string; verdicts: { reviewer: string; verdict: string; reason: string }[]; consensus: string | null }[];
      humanCeiling: number;
    }>(`/rounds/${roundId}/reviewers`, { token }),

  alignment: (roundId: string, token: string) =>
    call<{
      graded: number;
      seats: { seatId: string; name: string; family: string; agree: number; total: number; rate: number | null }[];
      falseSettles: { itemId: string; title: string; panelVerdict: string; yourVerdict: string; yourReason: string }[];
      falseSettleRate: number | null;
      settledChecked: number;
      humanCeiling: number;
    }>(`/rounds/${roundId}/alignment`, { token }),

  reweight: (roundId: string, token: string) =>
    call<{ changes: { seat: string; from: number; to: number }[] }>(`/rounds/${roundId}/reweight`, {
      method: 'POST',
      token,
    }),

  falseSettlePatch: (roundId: string, token: string, itemId: string) =>
    call<{ patch: PatchView }>(`/rounds/${roundId}/false-settle-patch`, { method: 'POST', token, body: json({ itemId }) }),

  bundle: (roundId: string, token: string) =>
    call<{
      project: { name: string; slug: string };
      rubricMarkdown: string;
      goldenJsonl: string;
      judgeSystemPrompt: string;
      panel: unknown[];
      panelEdits: unknown[];
      pinnedModels: Record<string, string>;
      cost: { totalCredits: number; totalTokens: number; perSeat: { seat: string; credits: number; tokens: number }[] };
      falseSettleRate: number | null;
      hashes: Record<string, string>;
      rerunScript: string;
    }>(`/rounds/${roundId}/bundle`, { token }),

  /** The same bundle as one zip. The key rides in a header, not the URL. */
  bundleZip: async (roundId: string, token: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`/api/v1/rounds/${roundId}/bundle.zip`, { headers: { 'x-gr-token': token } });
    if (!res.ok) {
      let message = `Could not build the package (${res.status}).`;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        /* not json */
      }
      throw new Error(message);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'eval.zip';
    return { blob: await res.blob(), filename };
  },

  setExpected: (slug: string, token: string, traceId: string, body: { verdict: string | null; reason: string }) =>
    call<{ trace: Trace }>(`/projects/${slug}/traces/${traceId}/expected`, { method: 'PATCH', token, body: json(body) }),

  soloEvalset: (slug: string, token: string) =>
    call<{
      cases: { id: string; title: string; input: string; expected: string; why: string }[];
      unanswered: { id: string; title: string }[];
      judgeSystemPrompt: string | null;
    }>(`/projects/${slug}/evalset`, { token }),

  soloEvalsetUrl: (slug: string, token: string) =>
    `/api/projects/${slug}/evalset?format=jsonl&k=${encodeURIComponent(token)}`,

  /* ---- The scenario write as a job ------------------------------------- */

  createScenarioJob: createScenarioJobReq,
  getScenarioJob: getScenarioJobReq,
  runScenarioJob: runScenarioJobStream,
  writeScenarios: writeScenariosResilient,
  seatPanel: seatPanelResilient,

  /** The coverage map: which kinds of ground the cases stand on, and how the last round read each. */
  coverage: (slug: string, token: string) =>
    call<{
      rows: {
        id: 'clear' | 'boundary' | 'unimagined' | 'real';
        label: string;
        what: string;
        cases: number;
        graded: number;
        settled: number;
        splits: number;
        split_rate: number | null;
        pass_rate: number | null;
        titles: string[];
      }[];
      total: number;
      gaps: { id: 'clear' | 'boundary' | 'unimagined' | 'real'; reason: string }[];
      round: { id: string; name: string } | null;
    }>(`/projects/${slug}/coverage`, { token }),

  generateScenarios: (slug: string, token: string, body: { description: string; count?: number; ground?: 'clear' | 'boundary' | 'unimagined' }) =>
    call<{
      scenarios: { id: string; title: string; content: string; probe: string }[];
      provider: { id: string; model: string; real: boolean };
      /** Written in parallel parts; `failed` names any part that did not land. */
      parts: number;
      failed: string[];
    }>(`/projects/${slug}/scenarios`, { method: 'POST', token, body: json(body) }),

  exportUrl: (rubricId: string, token: string, format: 'md' | 'json' | 'judge') =>
    `/api/rubrics/${rubricId}/export?format=${format}&k=${encodeURIComponent(token)}`,

  training: (slug: string, token: string) =>
    call<{
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
    }>(`/projects/${slug}/training`, { token }),

  trainingUrl: (slug: string, token: string, format: 'examples' | 'gold' | 'rewards' | 'pairs') =>
    `/api/v1/projects/${slug}/training?format=${format}&k=${encodeURIComponent(token)}`,

  /* Drift: the finished runs as a series, and whether the latest reading moved. */
  drift: (slug: string, token: string) =>
    call<{
      points: { id: string; name: string; at: string; standards_version: number; cases: number; decided: number; pass_rate: number | null; splits: number; new_splits: number; unstable_votes: number; flipped: number }[];
      report: {
        standards_version: number | null;
        trend: 'steady' | 'improving' | 'degrading' | 'insufficient';
        drifted: boolean;
        reasons: string[];
        baseline: { name: string } | null;
        latest: { name: string } | null;
        delta: { pass_rate: number | null; splits: number | null };
      };
    }>(`/projects/${slug}/drift`, { token }),

  /* Preference pairs: one prompt, two answers, which one the standard prefers. */
  pairs: (slug: string, token: string) => call<{ pairs: PairView[] }>(`/projects/${slug}/pairs`, { token }),
  addPair: (slug: string, token: string, body: { title: string; prompt: string; a: string; b: string }) =>
    call<{ pair: PairView }>(`/projects/${slug}/pairs`, { method: 'POST', token, body: json(body) }),
  gradePair: (slug: string, token: string, pairId: string) =>
    call<{ pair: PairView; failures: { seat: string; error: string }[] }>(`/projects/${slug}/pairs/${pairId}/grade`, { method: 'POST', token }),
  setPairVerdict: (slug: string, token: string, pairId: string, body: { choice: 'a' | 'b' | 'tie' | null; reason?: string }) =>
    call<{ pair: PairView }>(`/projects/${slug}/pairs/${pairId}/verdict`, { method: 'PATCH', token, body: json(body) }),
  deletePair: (slug: string, token: string, pairId: string) => call<void>(`/projects/${slug}/pairs/${pairId}`, { method: 'DELETE', token }),

  joinGrader: (slug: string, token: string, name: string) =>
    call<{ grader: Grader }>(`/projects/${slug}/graders`, { method: 'POST', token, body: json({ name }) }),

  createRound: (
    slug: string,
    token: string,
    body: {
      name?: string;
      calibrationSize: number;
      heldoutSize: number;
      strategy: 'random' | 'from_splits';
      sourceRoundId?: string | null;
      reuseHeldout?: boolean;
    },
  ) =>
    call<{ round: Round; itemCount: number; samplingNote: string; attention: Attention }>(
      `/projects/${slug}/rounds`,
      { method: 'POST', token, body: json(body) },
    ),

  round: (roundId: string, token: string) => call<RoundView>(`/rounds/${roundId}`, { token }),

  queue: (roundId: string, token: string, graderId: string) =>
    call<QueueView>(`/rounds/${roundId}/queue?graderId=${encodeURIComponent(graderId)}`, { token }),

  submitGrade: (
    roundId: string,
    token: string,
    body: { graderId: string; itemId: string; verdict: string; note: string; elapsedMs: number },
  ) => call<{ done: number; total: number }>(`/rounds/${roundId}/grades`, { method: 'POST', token, body: json(body) }),

  closeRound: (roundId: string, token: string) =>
    call<{ round: Round }>(`/rounds/${roundId}/close`, { method: 'POST', token, body: json({}) }),

  report: (roundId: string, token: string) => call<ReportView>(`/rounds/${roundId}/report`, { token }),

  resolve: (
    roundId: string,
    token: string,
    itemId: string,
    body: { agreedVerdict: string; clauseText: string; rationale: string; resolvedBy: string },
  ) =>
    call<{ resolution: Resolution }>(`/rounds/${roundId}/items/${itemId}/resolve`, {
      method: 'POST',
      token,
      body: json(body),
    }),

  unresolve: (roundId: string, token: string, itemId: string) =>
    call<void>(`/rounds/${roundId}/items/${itemId}/resolve`, { method: 'DELETE', token }),

  ship: (roundId: string, token: string) =>
    call<{ rubric: RubricVersion; added: number; from: number }>(`/rounds/${roundId}/ship`, {
      method: 'POST',
      token,
      body: json({}),
    }),

  judgeProvider: () => call<{ provider: string; model: string; real: boolean }>('/judge/provider'),

  runJudge: (roundId: string, token: string, rubricVersionId: string, arm: ItemArm) =>
    call<{ runId: string; provider: string; model: string; real: boolean }>(`/rounds/${roundId}/judge`, {
      method: 'POST',
      token,
      body: json({ rubricVersionId, arm }),
    }),

  judgeRuns: (roundId: string, token: string) =>
    call<{ runs: JudgeRunView[]; real: boolean }>(`/rounds/${roundId}/judge`, { token }),
};
