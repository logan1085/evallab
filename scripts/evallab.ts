#!/usr/bin/env node
/**
 * evallab: run an eval from the command line, and fail the build on the gate.
 *
 *   npm run evallab -- run --base https://your-app.vercel.app --project SLUG --token KEY \
 *     --cases cases.jsonl --standards 2 --gate pass-rate:0.9,new-splits:0
 *
 * cases.jsonl: one case per line, { "title", "content", "expected"? }.
 * Loosely matched field names: title | name | id; content | output | transcript | completion.
 *
 * Exit code 0 when the gate passes (or there is no gate), 1 when it fails,
 * 2 on a usage or transport error. Everything goes through the same
 * /api/v1 endpoints the Room uses; nothing here is a second path.
 */
import { readFileSync } from 'node:fs';

interface Args {
  base: string;
  project: string;
  token: string;
  cases: string;
  standards?: number;
  gate?: string;
  name?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string | boolean> = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') out.json = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? '';
  }
  const need = (k: string): string => {
    const v = out[k];
    if (typeof v !== 'string' || !v) {
      console.error(`Missing --${k}.`);
      process.exit(2);
    }
    return v;
  };
  return {
    base: (typeof out.base === 'string' && out.base ? out.base : process.env.GR_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, ''),
    project: need('project'),
    token: typeof out.token === 'string' && out.token ? out.token : (process.env.GR_TOKEN ?? need('token')),
    cases: need('cases'),
    standards: typeof out.standards === 'string' ? Number(out.standards) : undefined,
    gate: typeof out.gate === 'string' ? out.gate : undefined,
    name: typeof out.name === 'string' ? out.name : undefined,
    json: out.json === true,
  };
}

function readCases(path: string): { title: string; content: string; expected?: string }[] {
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  return rows.map((line, i) => {
    const r = JSON.parse(line) as Record<string, unknown>;
    const pick = (keys: string[]) => keys.map((k) => r[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    const title = pick(['title', 'name', 'id']) ?? `Case ${i + 1}`;
    const content = pick(['content', 'output', 'transcript', 'completion']);
    if (!content) {
      console.error(`Line ${i + 1}: no content field (content | output | transcript | completion).`);
      process.exit(2);
    }
    const expected = pick(['expected', 'label', 'verdict']);
    return { title, content, ...(expected ? { expected } : {}) };
  });
}

function gateSpec(text: string | undefined): { pass_rate_min?: number; max_new_splits?: number } {
  const spec: { pass_rate_min?: number; max_new_splits?: number } = {};
  for (const part of (text ?? '').split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (!k || v === undefined || !Number.isFinite(Number(v))) continue;
    if (k === 'pass-rate') spec.pass_rate_min = Number(v);
    if (k === 'new-splits') spec.max_new_splits = Number(v);
  }
  return spec;
}

/**
 * evallab drift: the finished runs as a series, and exit 1 when the latest
 * reading has moved past the thresholds. Pair with a scheduled `run`.
 *
 *   npm run evallab -- drift --project SLUG --token KEY --gate pass-rate-drop:0.05,flips:0,new-splits:0 --window 5
 */
async function drift(rest: string[]) {
  const out: Record<string, string | boolean> = { json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--json') out.json = true;
    else if (a.startsWith('--')) out[a.slice(2)] = rest[++i] ?? '';
  }
  const base = (typeof out.base === 'string' && out.base ? out.base : process.env.GR_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
  const project = typeof out.project === 'string' ? out.project : '';
  const token = typeof out.token === 'string' && out.token ? out.token : (process.env.GR_TOKEN ?? '');
  if (!project || !token) {
    console.error('Usage: evallab drift --project SLUG --token KEY [--base URL] [--gate pass-rate-drop:0.05,flips:0,new-splits:0] [--window 5] [--standards N] [--json]');
    process.exit(2);
  }
  const spec: Record<string, number> = {};
  for (const part of (typeof out.gate === 'string' ? out.gate : '').split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (!k || v === undefined || !Number.isFinite(Number(v))) continue;
    if (k === 'pass-rate-drop') spec.pass_rate_drop = Number(v);
    if (k === 'flips') spec.flips = Number(v);
    if (k === 'new-splits') spec.new_splits = Number(v);
  }
  if (typeof out.window === 'string' && out.window) spec.window = Number(out.window);
  if (typeof out.standards === 'string' && out.standards) spec.standards_version = Number(out.standards);
  const query = Object.entries(spec).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  const res = await fetch(`${base}/api/v1/projects/${project}/drift${query ? `?${query}` : ''}`, { headers: { 'x-gr-token': token } });
  const text = await res.text();
  let body: {
    error?: string;
    points: { name: string; standards_version: number; cases: number; pass_rate: number | null; splits: number; new_splits: number; flipped: number; at: string }[];
    report: { trend: string; drifted: boolean; reasons: string[]; baseline: { name: string } | null; latest: { name: string } | null; delta: { pass_rate: number | null; splits: number | null }; standards_version: number | null };
  };
  try {
    body = JSON.parse(text);
  } catch {
    console.error(`Could not read the drift report (${res.status}): ${text.slice(0, 300)}`);
    process.exit(2);
  }
  if (res.status !== 200) {
    console.error(`Could not read the drift report (${res.status}): ${body.error ?? 'unknown error'}`);
    process.exit(2);
  }
  if (out.json === true) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    const r = body.report;
    const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
    console.log(`${project} · Standards v${r.standards_version ?? '?'} · ${body.points.length} finished run${body.points.length === 1 ? '' : 's'}`);
    console.log('');
    for (const p of r.series ?? body.points) {
      console.log(`${p.name.padEnd(10)} ${p.at.slice(0, 10)}  pass ${pct(p.pass_rate).padStart(4)}  splits ${String(p.splits).padStart(2)}  new ${String(p.new_splits).padStart(2)}  flipped ${String(p.flipped).padStart(2)}  cases ${p.cases}`);
    }
    console.log('');
    if (r.baseline && r.latest) {
      console.log(
        `${r.latest.name} vs ${r.baseline.name}: pass rate ${r.delta.pass_rate === null ? 'n/a' : `${r.delta.pass_rate >= 0 ? '+' : ''}${(r.delta.pass_rate * 100).toFixed(0)} points`}, splits ${r.delta.splits === null ? 'n/a' : `${r.delta.splits >= 0 ? '+' : ''}${r.delta.splits}`} · trend: ${r.trend}`,
      );
    } else {
      console.log('Fewer than two finished runs on this standard: nothing to compare yet.');
    }
    console.log(r.drifted ? `DRIFT: ${r.reasons.join('; ')}` : `NO DRIFT${Object.keys(spec).some((k) => k !== 'window' && k !== 'standards_version') ? '' : ' (no thresholds set)'}`);
  }
  process.exit(body.report.drifted ? 1 : 0);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'drift') return drift(rest);
  if (command !== 'run') {
    console.error('Usage: evallab run --project SLUG --token KEY --cases cases.jsonl [--base URL] [--standards N] [--gate pass-rate:0.9,new-splits:0] [--json]');
    console.error('       evallab drift --project SLUG --token KEY [--gate pass-rate-drop:0.05,flips:0,new-splits:0] [--window 5] [--json]');
    process.exit(2);
  }
  const args = parseArgs(rest);
  const api = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${args.base}/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-gr-token': args.token, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { status: res.status, body: body as T };
  };

  const cases = readCases(args.cases);
  const created = await api<{ run: { id: string; name: string; roundId: string; standards_version: number }; seats: { id: string; name: string }[]; error?: string }>(
    `/projects/${args.project}/runs`,
    { method: 'POST', body: JSON.stringify({ cases, standards_version: args.standards, gate: gateSpec(args.gate), name: args.name }) },
  );
  if (created.status !== 201) {
    console.error(`Could not create the run (${created.status}): ${created.body.error ?? 'unknown error'}`);
    process.exit(2);
  }
  const { run, seats } = created.body;
  if (!args.json) console.error(`${run.name}: ${cases.length} cases against Standards v${run.standards_version}, ${seats.length} seats.`);

  for (const seat of seats) {
    const r = await api<{ error?: string }>(`/rounds/${run.roundId}/panel-run`, { method: 'POST', body: JSON.stringify({ seatId: seat.id }) });
    if (r.status !== 200) {
      console.error(`Seat ${seat.name} failed (${r.status}): ${r.body.error ?? 'unknown error'}`);
      process.exit(2);
    }
    if (!args.json) console.error(`  ✓ ${seat.name}`);
  }
  const stability = await api<{ checked: number; unstable: number; error?: string }>(`/rounds/${run.roundId}/stability`, { method: 'POST' });
  if (stability.status !== 200) {
    console.error(`Stability pass failed (${stability.status}): ${stability.body.error ?? 'unknown error'}`);
    process.exit(2);
  }
  if (!args.json) console.error(`  ✓ stability: ${stability.body.checked} contested cases rechecked, ${stability.body.unstable} unstable votes`);

  const report = await api<{
    summary: { cases: number; pass_rate: number | null; splits: number; new_splits: number; unstable_votes: number; expected_match: { supplied: number; compared: number; agreed: number; rate: number | null } | null };
    gate: { passed: boolean; reasons: string[]; spec: Record<string, number> };
    diff: { against: string; compared: number; flipped: { title: string; from: string | null; to: string | null }[] } | null;
    cases: { title: string; verdict: string | null; pattern: string; dissenter: string | null; expected: string | null; matches_expected: boolean | null }[];
    error?: string;
  }>(`/runs/${run.id}`);
  if (report.status !== 200) {
    console.error(`Could not read the run (${report.status}): ${report.body.error ?? 'unknown error'}`);
    process.exit(2);
  }
  const rep = report.body;
  if (args.json) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    const s = rep.summary;
    console.log('');
    console.log(`${run.name} · Standards v${run.standards_version}`);
    console.log(`cases ${s.cases} · pass rate ${s.pass_rate === null ? 'n/a' : `${(s.pass_rate * 100).toFixed(0)}%`} · splits ${s.splits} · new splits ${s.new_splits} · unstable votes ${s.unstable_votes}`);
    if (s.expected_match) console.log(`expected: agreed on ${s.expected_match.agreed} of ${s.expected_match.compared} compared (${s.expected_match.supplied} supplied${s.expected_match.rate === null ? "" : `, ${(s.expected_match.rate * 100).toFixed(0)}%`})`);
    if (rep.diff) {
      console.log(`vs ${rep.diff.against}: ${rep.diff.compared} cases compared, ${rep.diff.flipped.length} flipped`);
      for (const f of rep.diff.flipped) console.log(`  ${f.title}: ${f.from ?? '–'} → ${f.to ?? '–'}`);
    }
    console.log('');
    for (const c of rep.cases) {
      const mark = c.matches_expected === null ? ' ' : c.matches_expected ? '✓' : '✗';
      console.log(`${mark} ${(c.verdict ?? '–').padEnd(11)} ${c.pattern.padEnd(14)} ${c.title}${c.dissenter ? `  (dissent: ${c.dissenter})` : ''}`);
    }
    console.log('');
    console.log(rep.gate.passed ? `GATE PASSED${Object.keys(rep.gate.spec).length ? '' : ' (no gate set)'}` : `GATE FAILED: ${rep.gate.reasons.join('; ')}`);
  }
  process.exit(rep.gate.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
