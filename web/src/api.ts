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
    body: { name?: string; objective?: string; failsFor?: string; note?: string },
  ) => call<{ seat: Grader }>(`/projects/${slug}/panel/seats/${seatId}`, { method: 'PATCH', token, body: json(body) }),

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

  selfCheck: (roundId: string, token: string) =>
    call<{ cases: { itemId: string; title: string; content: string; myVerdict: string | null; myReason: string }[]; done: number }>(
      `/rounds/${roundId}/self-check`,
      { token },
    ),

  submitSelfCheck: (roundId: string, token: string, body: { itemId: string; verdict: string; reason: string }) =>
    call<{ ok: true }>(`/rounds/${roundId}/self-check`, { method: 'POST', token, body: json(body) }),

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

  generateScenarios: (slug: string, token: string, body: { description: string; count?: number }) =>
    call<{
      scenarios: { id: string; title: string; content: string; probe: string }[];
      provider: { id: string; model: string; real: boolean };
    }>(`/projects/${slug}/scenarios`, { method: 'POST', token, body: json(body) }),

  exportUrl: (rubricId: string, token: string, format: 'md' | 'json' | 'judge') =>
    `/api/rubrics/${rubricId}/export?format=${format}&k=${encodeURIComponent(token)}`,

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
