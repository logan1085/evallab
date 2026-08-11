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
  Grader,
  ItemArm,
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

  const res = await fetch(`/api${path}`, { ...rest, headers });
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

export interface ProjectView {
  project: Project;
  rubric: RubricVersion | null;
  traceCount: number;
  graders: Grader[];
  rounds: RoundSummary[];
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
  splitCount: number;
  overall: ArmStats;
  calibration: ArmStats;
  heldout: ArmStats;
  resolutions: Resolution[];
  notes: { itemId: string; graderId: string; note: string; verdict: string }[];
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
  createProject: (name: string) =>
    call<{ project: Project; rubric: RubricVersion }>('/projects', { method: 'POST', body: json({ name }) }),

  createDemo: () =>
    call<{ slug: string; token: string; projectId: string; roundId: string }>('/projects/demo', {
      method: 'POST',
      body: json({}),
    }),

  project: (slug: string, token: string) => call<ProjectView>(`/projects/${slug}`, { token }),

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
    patch: Pick<RubricVersion, 'name' | 'preamble'> & Partial<Pick<RubricVersion, 'scale' | 'criteria'>>,
  ) => call<{ rubric: RubricVersion; forked: boolean }>(`/projects/${slug}/rubric`, { method: 'PUT', token, body: json(patch) }),

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
