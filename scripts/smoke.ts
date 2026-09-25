#!/usr/bin/env node
/**
 * smoke: is the deployed product actually working?
 *
 *   npm run smoke -- --base https://evallab-eosin.vercel.app [--wait-for <sha>] [--keep]
 *
 * Drives one fresh project end to end against a live deployment, the way a
 * new user would: health, create, write scenarios, seat the panel, run the
 * round, read the map, open the Standards page. Every step prints PASS or
 * FAIL with the server's own words, and the exit code is 0 only when every
 * step passed. With --wait-for it first waits (up to ten minutes) for
 * /api/health to report that commit, so it can run right after a push.
 *
 * This spends real model calls when the deployment has a key: one scenario
 * write, one panel write, one round of six seats over twelve cases. That
 * is the point; a smoke that avoids the models cannot say the product works.
 */

interface Args {
  base: string;
  waitFor: string | null;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--keep') out.keep = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? '';
  }
  const base = (typeof out.base === 'string' && out.base ? out.base : process.env.GR_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    console.error('Usage: smoke --base https://your-deployment [--wait-for <sha>] [--keep]');
    process.exit(2);
  }
  return { base, waitFor: typeof out['wait-for'] === 'string' && out['wait-for'] ? out['wait-for'] : null, keep: out.keep === true };
}

const args = parseArgs(process.argv.slice(2));
let failed = 0;
const started = Date.now();

let warned = 0;

/** PASS or FAIL counts; 'warn' is a configuration note that does not fail the smoke. */
function report(step: string, ok: boolean | 'warn', detail: string) {
  const t = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const tag = ok === 'warn' ? 'WARN' : ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${step.padEnd(22)} ${detail}  [${t}]`);
  if (ok === 'warn') warned++;
  else if (!ok) failed++;
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; body: T; text: string }> {
  const { token, ...rest } = init;
  const res = await fetch(`${args.base}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-gr-token': token } : {}), ...(rest.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body: body as T, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Health {
  ok: boolean;
  deploy?: { env: string | null; commit: string | null; url: string | null };
  writer?: { ok: boolean; model: string; error: string | null };
  pins?: { ok: boolean; problems: string[]; repinned?: { pin_id: string; from: string; to: string }[]; disabled: string[] };
  secrets?: string;
  database?: { driver: string };
  error?: string;
}

async function main() {
  // 1. The deploy: the commit we expect, or whatever is there.
  let health: { status: number; body: Health; text: string } | null = null;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      health = await call<Health>('/api/health');
    } catch (err) {
      health = { status: 0, body: { ok: false, error: err instanceof Error ? err.message : String(err) }, text: '' };
    }
    const commit = health.body.deploy?.commit ?? null;
    if (!args.waitFor || (commit && commit.startsWith(args.waitFor.slice(0, 7)))) break;
    if (Date.now() > deadline) {
      report('deploy', false, `waited ten minutes for ${args.waitFor.slice(0, 7)}; health still reports ${commit ?? 'no commit'}`);
      break;
    }
    await sleep(15_000);
  }
  const h = health!;
  const commit = h.body.deploy?.commit?.slice(0, 7) ?? 'unknown';
  report('deploy', h.status > 0, `${args.base} · ${h.body.deploy?.env ?? '?'} · commit ${commit}${h.status === 0 ? ` · ${h.body.error}` : ''}`);
  if (h.status === 0) return finish();

  // 2. Health: the database, the pins, the writer.
  report('database', !!h.body.database && h.body.database.driver === 'postgres', `driver ${h.body.database?.driver ?? 'none'}`);
  if (h.body.pins) {
    const repinned = h.body.pins.repinned ?? [];
    report(
      'pins',
      h.body.pins.ok,
      h.body.pins.ok
        ? `all listed${repinned.length ? `; writer repinned ${repinned.map((r) => `${r.from} -> ${r.to}`).join(', ')}` : ''}`
        : h.body.pins.problems.join(' | '),
    );
  } else {
    report('pins', false, 'no pins block: OPENROUTER_API_KEY is not set on this deployment, so every seat is the simulation');
  }
  if (h.body.writer) report('writer', h.body.writer.ok, h.body.writer.ok ? `answers on ${h.body.writer.model}` : h.body.writer.error ?? 'no answer');
  else report('writer', false, 'no writer canary: no key on the deployment');
  report('secrets', h.body.secrets === 'env' ? true : 'warn', h.body.secrets === 'env' ? 'GR_SECRET set' : `secrets=${h.body.secrets ?? 'unknown'}: endpoint keys are sealed under the development phrase; set GR_SECRET in the Vercel project and redeploy`);

  // 3. A fresh project, as a new user makes one.
  const created = await call<{ project: { slug: string; token: string; description: string }; error?: string }>('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `Smoke ${new Date().toISOString().slice(0, 16)}`,
      description: 'A support agent for an outdoor gear shop that answers order, shipping and return questions.',
      limits: 'Refunds over $60 need a manager. Never promise a delivery date the carrier has not given.',
    }),
  });
  report('create project', created.status === 201, created.status === 201 ? created.body.project.slug : `${created.status}: ${created.body.error ?? created.text.slice(0, 200)}`);
  if (created.status !== 201) return finish();
  const { slug, token } = created.body.project;
  const auth = { token };

  // 4. Scenarios, the way the Room writes them: a job, run as a stream,
  //    read back by polling if the stream drops. This is the step that
  //    was failing in production.
  interface JobView {
    id: string;
    status: string;
    scenarios: number;
    failed: string[];
    parts: { index: number; status: string; scenarios: number; error: string }[];
  }
  const jobCreated = await call<{ job: JobView; provider: { real: boolean; model: string }; error?: string }>(`/api/v1/projects/${slug}/scenario-jobs`, {
    method: 'POST',
    ...auth,
    body: JSON.stringify({ description: created.body.project.description }),
  });
  report('create job', jobCreated.status === 202, jobCreated.status === 202 ? `${jobCreated.body.job.parts.length} parts on ${jobCreated.body.provider.real ? jobCreated.body.provider.model : 'the simulation'}` : `${jobCreated.status}: ${jobCreated.body.error ?? jobCreated.text.slice(0, 200)}`);
  if (jobCreated.status === 202) {
    const jobId = jobCreated.body.job.id;
    let finalJob: JobView | null = null;
    let streamNote = '';
    const runStarted = Date.now();
    try {
      const res = await fetch(`${args.base}/api/v1/projects/${slug}/scenario-jobs/${jobId}/run`, { method: 'POST', headers: { 'x-gr-token': token } });
      const text = await res.text();
      const ticks = (text.match(/"tick"/g) ?? []).length;
      const last = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { done?: boolean; job?: JobView }).find((l) => l.done);
      finalJob = last?.job ?? null;
      streamNote = `stream ${res.status}, ${ticks} heartbeats, ${((Date.now() - runStarted) / 1000).toFixed(1)}s`;
    } catch (err) {
      streamNote = `stream dropped (${err instanceof Error ? err.message : String(err)}) after ${((Date.now() - runStarted) / 1000).toFixed(1)}s`;
    }
    if (!finalJob) {
      // The run's connection did not carry the final line: poll, as the Room does.
      const until = Date.now() + 150_000;
      while (Date.now() < until) {
        await sleep(3000);
        const read = await call<{ job: JobView }>(`/api/v1/projects/${slug}/scenario-jobs/${jobId}`, auth);
        if (read.status === 200 && (read.body.job.status === 'done' || read.body.job.status === 'failed')) {
          finalJob = read.body.job;
          streamNote += `; job read back by polling after ${((Date.now() - runStarted) / 1000).toFixed(1)}s`;
          break;
        }
      }
    }
    if (finalJob) {
      // The simulation offers six stubs; a real writer is asked for twelve.
      const enough = jobCreated.body.provider.real ? 8 : 4;
      report(
        'write scenarios',
        finalJob.scenarios >= enough && finalJob.failed.length === 0,
        `${finalJob.scenarios} cases, status ${finalJob.status} (${streamNote})${finalJob.failed.length ? `; failed: ${finalJob.failed.join(' | ')}` : ''}`,
      );
      if (finalJob.failed.length > 0 && finalJob.status === 'failed') {
        // The retry the Room offers: run the same job again.
        const again = await call<{ job: JobView; error?: string }>(`/api/v1/projects/${slug}/scenario-jobs/${jobId}/run?mode=json`, { method: 'POST', ...auth });
        report('retry failed parts', again.status === 200 && again.body.job.failed.length === 0, again.status === 200 ? `${again.body.job.scenarios} cases after retry` : `${again.status}: ${again.body.error ?? ''}`);
      }
    } else {
      report('write scenarios', false, `no final state within 150s (${streamNote})`);
    }
  }

  // 5. The panel.
  const panel = await call<{ seats: { id: string; name: string; family: string; model: string }[]; real?: boolean; fallbackReason?: string; error?: string }>(
    `/api/v1/projects/${slug}/panel`,
    { method: 'POST', ...auth },
  );
  if (panel.status === 201 || panel.status === 200) {
    const families = new Set(panel.body.seats.map((s) => s.family));
    report(
      'seat panel',
      panel.body.seats.length >= 3 && !panel.body.fallbackReason,
      `${panel.body.seats.length} seats across ${families.size} families${panel.body.fallbackReason ? `; generic bench: ${panel.body.fallbackReason}` : ''}`,
    );
  } else {
    report('seat panel', false, `${panel.status}: ${panel.body.error ?? panel.text.slice(0, 300)}`);
  }

  // 6. The round, seat by seat, the way the Room runs it.
  const round = await call<{ round: { id: string }; seats: { id: string; name: string }[]; cases: number; error?: string }>(`/api/v1/projects/${slug}/panel-rounds`, {
    method: 'POST',
    ...auth,
  });
  report('start round', round.status === 201, round.status === 201 ? `${round.body.cases} cases, ${round.body.seats.length} seats` : `${round.status}: ${round.body.error ?? round.text.slice(0, 300)}`);
  if (round.status !== 201) return finish(slug, token);
  let seatsOk = 0;
  for (const seat of round.body.seats) {
    const r = await call<{ graded?: number; failed?: number; failures?: string[]; error?: string }>(`/api/v1/rounds/${round.body.round.id}/panel-run`, {
      method: 'POST',
      ...auth,
      body: JSON.stringify({ seatId: seat.id }),
    });
    // A seat that graded every case passes, even if a repeat sample could
    // not be asked (that is reported, and counts as neither agreement nor
    // disagreement); one that abstained on a case is a failure with the
    // reason; one that graded nothing is a 502 from the server.
    const abstainedOnCase = (r.body.failures ?? []).some((f) => !/\(repeat\)/.test(f));
    const ok = r.status === 200 && (r.body.graded ?? 0) >= round.body.cases && !abstainedOnCase;
    if (r.status === 200) seatsOk++;
    report(
      `seat: ${seat.name}`,
      ok,
      r.status === 200
        ? `graded ${r.body.graded ?? '?'}${r.body.failed ? `, abstained on ${r.body.failed}: ${(r.body.failures ?? [])[0] ?? ''}` : ''}`
        : `${r.status}: ${r.body.error ?? r.text.slice(0, 300)}`,
    );
  }

  // 7. The reading.
  const map = await call<{ round: { status: string }; counts: Record<string, number>; simulated: boolean; cost: { totalCredits: number }; error?: string }>(
    `/api/v1/rounds/${round.body.round.id}/map`,
    auth,
  );
  report(
    'read the map',
    map.status === 200 && map.body.round.status === 'closed',
    map.status === 200
      ? `${map.body.round.status} · settled ${map.body.counts.settled} · persona ${map.body.counts.personaDriven} · contested ${map.body.counts.contested} · blind spots ${map.body.counts.blindSpots} · ${map.body.simulated ? 'SIMULATED' : 'real models'} · ${map.body.cost.totalCredits.toFixed(4)} credits`
      : `${map.status}: ${map.body.error ?? map.text.slice(0, 200)}`,
  );

  // 8. The artifact.
  const page = await fetch(`${args.base}/s/${slug}?k=${encodeURIComponent(token)}`);
  const html = await page.text();
  report('standards page', page.status === 200 && html.includes('Standards v'), `${page.status} · ${html.includes('Download the eval package') ? 'package link present' : 'no package link'}`);

  finish(slug, token);
}

function finish(slug?: string, token?: string) {
  console.log('');
  if (slug && token) console.log(`Project: ${args.base}/p/${slug}?k=${token}${args.keep ? '' : '  (left in place; delete it from the Room if you like)'}`);
  console.log(
    failed === 0
      ? `SMOKE PASSED: the deployment works end to end.${warned ? ` ${warned} configuration warning${warned === 1 ? '' : 's'} above.` : ''}`
      : `SMOKE FAILED: ${failed} step${failed === 1 ? '' : 's'} above.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`smoke crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});
