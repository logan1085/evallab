import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ATTENTION_BUDGET_MINUTES, attentionEstimate } from '@shared/sampling';
import type { RubricCriterion, Trace } from '@shared/types';
import { api, forgetGrader, recallGrader, recallKey, rememberGrader, type ProjectView, type RoundSummary } from '../api';
import { Trajectory } from '../components/Trajectory';
import { ErrorBanner, Loading, Masthead, minutes, pct, useAsync } from '../ui';

type Tab = 'rounds' | 'traces' | 'rubric';

export function ProjectPage() {
  const { slug } = useParams<{ slug: string }>();
  const token = recallKey(slug!) ?? '';
  const [tab, setTab] = useState<Tab>('rounds');
  const [error, setError] = useState<string | null>(null);

  const { data, loading, reload } = useAsync<ProjectView>(() => api.project(slug!, token), [slug, token]);

  if (loading && !data) return <main className="sheet"><Loading what="project" /></main>;
  if (!data) return <main className="sheet"><ErrorBanner message="Could not load this project." /></main>;

  const link = `${window.location.origin}/p/${data.project.slug}?k=${data.project.token}`;

  return (
    <main className="sheet sheet--wide">
      <Masthead
        crumbs={[{ label: 'Home', to: '/' }, data.project.name]}
        title={data.project.name}
        standfirst={`${data.traceCount} traces · rubric v${data.rubric?.version ?? 1} · ${data.rounds.length} round${data.rounds.length === 1 ? '' : 's'}`}
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="panel">
        <div className="between">
          <div style={{ flex: '1 1 340px', minWidth: 0 }}>
            <span className="metric-k">Shared link — this is the only credential</span>
            <div className="link-box">{link}</div>
            <p className="tiny" style={{ margin: 0 }}>
              Anyone with this link can grade and read the report. That is v1&rsquo;s scope, not an oversight.
            </p>
          </div>
          <div className="shrink stack">
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(link)}>
              Copy link
            </button>
            <GraderIdentity slug={slug!} token={token} onError={setError} />
          </div>
        </div>
      </div>

      <div className="tabs">
        {(['rounds', 'traces', 'rubric'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t === 'rounds' ? 'Rounds' : t === 'traces' ? 'Traces' : 'Rubric'}
          </button>
        ))}
      </div>

      {tab === 'rounds' ? <RoundsTab view={data} slug={slug!} token={token} onChange={reload} onError={setError} /> : null}
      {tab === 'traces' ? <TracesTab slug={slug!} token={token} onChange={reload} onError={setError} /> : null}
      {tab === 'rubric' ? <RubricTab view={data} slug={slug!} token={token} onChange={reload} onError={setError} /> : null}
    </main>
  );
}

/* ---- Grader identity ---------------------------------------------------- */

function GraderIdentity({
  slug,
  token,
  onError,
}: {
  slug: string;
  token: string;
  onError: (m: string) => void;
}) {
  const [grader, setGrader] = useState(() => recallGrader(slug));
  const [name, setName] = useState('');

  if (grader) {
    return (
      <div className="tiny">
        Grading as <strong style={{ color: 'var(--ink)' }}>{grader.name}</strong>{' '}
        <button
          className="ghost tiny-btn"
          onClick={() => {
            forgetGrader(slug);
            setGrader(null);
          }}
        >
          change
        </button>
      </div>
    );
  }

  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        try {
          const { grader: joined } = await api.joinGrader(slug, token, name.trim());
          rememberGrader(slug, joined);
          setGrader(joined);
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Could not join.');
        }
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
      <div className="shrink">
        <button type="submit" className="ghost">
          Join
        </button>
      </div>
    </form>
  );
}

/* ---- Rounds ------------------------------------------------------------- */

function RoundsTab({
  view,
  slug,
  token,
  onChange,
  onError,
}: {
  view: ProjectView;
  slug: string;
  token: string;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const closedRounds = view.rounds.filter((r) => r.status === 'closed');
  const [calibrationSize, setCalibrationSize] = useState(8);
  const [heldoutSize, setHeldoutSize] = useState(4);
  const [strategy, setStrategy] = useState<'random' | 'from_splits'>(closedRounds.length ? 'from_splits' : 'random');
  const [sourceRoundId, setSourceRoundId] = useState(closedRounds[closedRounds.length - 1]?.id ?? '');
  const [reuseHeldout, setReuseHeldout] = useState(true);
  const [busy, setBusy] = useState(false);

  const grader = recallGrader(slug);
  const attention = attentionEstimate(calibrationSize + heldoutSize);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createRound(slug, token, {
        calibrationSize,
        heldoutSize,
        strategy,
        sourceRoundId: strategy === 'from_splits' ? sourceRoundId : null,
        reuseHeldout,
      });
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start the round.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rail-grid">
      <div className="rail">
        <span className="num">R</span>
        <span className="rail-label">Rounds</span>
        <span className="rail-note">One blind pass each.</span>
      </div>
      <div className="col">
        <TrajectorySection slug={slug} token={token} rounds={view.rounds} />

        {view.rounds.length === 0 ? (
          <div className="empty">No rounds yet. A round is one blind pass over a sample of traces.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <caption>Rounds, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">Round</th>
                  <th scope="col">Rubric</th>
                  <th scope="col">Items</th>
                  <th scope="col">Sampling</th>
                  <th scope="col">Status</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {view.rounds.map((round) => (
                  <tr key={round.id}>
                    <td className="case">{round.name}</td>
                    <td>v{round.rubricVersion ?? '—'}</td>
                    <td>{round.items}</td>
                    <td>{round.strategy === 'from_splits' ? 'from prior splits' : 'random'}</td>
                    <td>
                      <span className={`verdict ${round.status === 'closed' ? 'v-mid' : 'v-pass'}`}>{round.status}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {round.status === 'open' ? (
                        grader ? (
                          <Link className="btn ghost tiny-btn" to={`/p/${slug}/grade/${round.id}`}>
                            Grade
                          </Link>
                        ) : (
                          <span className="tiny">join first</span>
                        )
                      ) : (
                        <Link className="btn ghost tiny-btn" to={`/p/${slug}/round/${round.id}`}>
                          Report
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="panel" style={{ marginTop: 22 }}>
          <h3 style={{ marginTop: 0 }}>Start a round</h3>
          <form onSubmit={create}>
            <div className="row">
              <div className="field">
                <label htmlFor="cal">Calibration items</label>
                <input
                  id="cal"
                  type="number"
                  min={1}
                  value={calibrationSize}
                  onChange={(e) => setCalibrationSize(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="held">Held-out items</label>
                <input
                  id="held"
                  type="number"
                  min={0}
                  value={heldoutSize}
                  onChange={(e) => setHeldoutSize(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="strategy">Sampling</label>
                <select id="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as 'random')}>
                  <option value="random">Random</option>
                  <option value="from_splits" disabled={closedRounds.length === 0}>
                    From a previous round&rsquo;s splits
                  </option>
                </select>
              </div>
              {strategy === 'from_splits' ? (
                <div className="field">
                  <label htmlFor="source">Source round</label>
                  <select id="source" value={sourceRoundId} onChange={(e) => setSourceRoundId(e.target.value)}>
                    {closedRounds.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>

            {strategy === 'from_splits' ? (
              <label style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--body)', fontSize: 15, color: 'var(--ink-soft)' }}>
                <input
                  type="checkbox"
                  checked={reuseHeldout}
                  onChange={(e) => setReuseHeldout(e.target.checked)}
                  style={{ width: 'auto', marginRight: 8 }}
                />
                Reuse the previous round&rsquo;s held-out traces, so before and after are measured on the same cases
              </label>
            ) : null}

            <p className={attention.overBudget ? 'warn' : 'note'} style={{ marginTop: 14 }}>
              {calibrationSize + heldoutSize} items ≈ <strong>{minutes(attention.minutes * 60000)}</strong> per grader.{' '}
              {attention.overBudget
                ? `Past roughly ${ATTENTION_BUDGET_MINUTES} minutes a second round tends not to happen. ${attention.maxItems} items fits the budget.`
                : 'Within the thirty-minute budget that makes a second round likely.'}
            </p>

            <button type="submit" disabled={busy}>
              {busy ? 'Sampling…' : 'Start round'}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

/**
 * The trajectory, and — when there is only one closed round — the nudge toward
 * a second one. A single round is a measurement; two is the first time the
 * product can say anything about whether calibration worked, which is the whole
 * reason to come back.
 */
function TrajectorySection({
  slug,
  token,
  rounds,
}: {
  slug: string;
  token: string;
  rounds: RoundSummary[];
}) {
  const closedCount = rounds.filter((r) => r.status === 'closed').length;
  const { data } = useAsync(() => api.trajectory(slug, token), [slug, token, rounds.length, closedCount]);
  const series = data?.series ?? [];

  if (series.length === 0) return null;

  if (series.length === 1) {
    const only = series[0]!;
    const held = only.heldout.agreement;
    return (
      <div className="panel">
        <span className="metric-k">One round in</span>
        <h3 style={{ marginTop: 6 }}>
          {held.units > 0
            ? `Held-out agreement is ${pct(held.observed, 1)}. There is nothing to compare it against yet.`
            : 'This round reserved no held-out traces, so there is no baseline to improve on yet.'}
        </h3>
        <p className="note">
          One round tells you where you are. The second one is what tells you whether resolving the splits changed
          anything — run it against the same held-out traces, with the same people, and the difference is attributable
          to the rubric.
        </p>
        {only.resolvedCount === 0 && only.splitCount > 0 ? (
          <Link className="btn ghost" to={`/p/${slug}/round/${only.roundId}`}>
            Resolve {only.splitCount} split{only.splitCount === 1 ? '' : 's'} first
          </Link>
        ) : (
          <Link className="btn ghost" to={`/p/${slug}/round/${only.roundId}`}>
            Open the report to start round two
          </Link>
        )}
      </div>
    );
  }

  const latest = series[series.length - 1]!;

  return (
    <div className="panel">
      <div className="between" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Did agreement move?</h3>
        {latest.heldoutDelta !== null ? (
          <span className={`tiny ${latest.heldoutDelta >= 0 ? 'delta-up' : 'delta-down'}`}>
            {latest.heldoutDelta >= 0 ? '+' : ''}
            {(latest.heldoutDelta * 100).toFixed(1)} PTS ON THE SAME HELD-OUT TRACES
          </span>
        ) : (
          <span className="tiny">LATEST ROUND NOT COMPARABLE TO THE ONE BEFORE IT</span>
        )}
      </div>

      <Trajectory series={series} />

      <div className="scroll-x">
        <table>
          <caption>Every closed round</caption>
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Rubric</th>
              <th scope="col">Held-out</th>
              <th scope="col">Calibration</th>
              <th scope="col">Splits</th>
              <th scope="col">Resolved</th>
              <th scope="col">Graders</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={point.roundId}>
                <td className="case">{point.name}</td>
                <td>
                  v{point.rubricVersion ?? '—'} · {point.clauseCount} cl
                </td>
                <td>
                  {point.heldout.agreement.units > 0 ? pct(point.heldout.agreement.observed, 1) : '—'}
                  {point.heldoutDelta !== null ? (
                    <span className={point.heldoutDelta >= 0 ? 'delta-up' : 'delta-down'}>
                      {' '}
                      ({point.heldoutDelta >= 0 ? '+' : ''}
                      {(point.heldoutDelta * 100).toFixed(1)})
                    </span>
                  ) : null}
                </td>
                <td>
                  {point.calibration.agreement.units > 0 ? pct(point.calibration.agreement.observed, 1) : '—'}
                </td>
                <td>{point.splitCount}</td>
                <td>{point.resolvedCount}</td>
                <td>{point.graderNames.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---- Traces ------------------------------------------------------------- */

function TracesTab({
  slug,
  token,
  onChange,
  onError,
}: {
  slug: string;
  token: string;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const { data, loading, reload } = useAsync<{ traces: Trace[] }>(() => api.traces(slug, token), [slug, token]);
  const [format, setFormat] = useState<'paste' | 'jsonl' | 'csv'>('paste');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const authored = useMemo(() => (data?.traces ?? []).filter((t) => t.source === 'authored-demo').length, [data]);

  async function importTraces(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await api.importTraces(slug, token, format, body);
      setResult(
        `Added ${res.traces.length} trace${res.traces.length === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} that did not parse` : ''}.`,
      );
      setBody('');
      reload();
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not import those traces.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rail-grid">
      <div className="rail">
        <span className="num">T</span>
        <span className="rail-label">Traces</span>
        <span className="rail-note">The corpus to grade.</span>
      </div>
      <div className="col">
        {authored > 0 ? (
          <div className="warn">
            <span className="metric-k">Authored, not captured</span>
            <p style={{ margin: '6px 0 0' }}>
              {authored} of these transcripts were written for the demo rather than captured from real runs. Anything
              you conclude from them is about the workflow, not about a production agent. Replacing them with real
              traces is the first thing to do with your own project.
            </p>
          </div>
        ) : null}

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Bring in traces</h3>
          <form onSubmit={importTraces}>
            <div className="pill-row">
              {(['paste', 'jsonl', 'csv'] as const).map((f) => (
                <button key={f} type="button" className={`pill ${format === f ? 'on' : ''}`} onClick={() => setFormat(f)}>
                  {f === 'paste' ? 'Paste' : f.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="import-body">
                {format === 'paste'
                  ? 'One trace per block, separated by a line of three dashes'
                  : format === 'jsonl'
                    ? 'One JSON object per line, or a JSON array'
                    : 'CSV with a header row'}
              </label>
              <textarea
                id="import-body"
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={
                  format === 'paste'
                    ? 'Refund outside policy window\nUSER: …\nASSISTANT: …\n---\nNext trace title\n…'
                    : format === 'jsonl'
                      ? '{"name": "Refund case", "output": "ASSISTANT: …"}'
                      : 'name,output\nRefund case,"ASSISTANT: …"'
                }
              />
              <p className="tiny" style={{ marginTop: 6 }}>
                Field names are matched loosely — title, name, id, case for the label; content, transcript, output,
                completion, messages for the body. Everything else is kept as metadata.
              </p>
            </div>
            <button type="submit" disabled={busy || !body.trim()}>
              {busy ? 'Parsing…' : 'Import'}
            </button>
            {result ? <span className="tiny" style={{ marginLeft: 12 }}>{result}</span> : null}
          </form>
        </div>

        {loading && !data ? (
          <Loading what="traces" />
        ) : (data?.traces.length ?? 0) === 0 ? (
          <div className="empty">No traces yet.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <caption>{data!.traces.length} traces</caption>
              <thead>
                <tr>
                  <th scope="col">Trace</th>
                  <th scope="col">Source</th>
                  <th scope="col">Length</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {data!.traces.map((trace) => (
                  <tr key={trace.id}>
                    <td className="case">{trace.title}</td>
                    <td>{trace.source}</td>
                    <td>{trace.content.length.toLocaleString()} ch</td>
                    <td>
                      <button
                        className="ghost tiny-btn"
                        onClick={async () => {
                          try {
                            await api.deleteTrace(slug, token, trace.id);
                            reload();
                            onChange();
                          } catch (err) {
                            onError(err instanceof Error ? err.message : 'Could not remove that trace.');
                          }
                        }}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---- Rubric ------------------------------------------------------------- */

function RubricTab({
  view,
  slug,
  token,
  onChange,
  onError,
}: {
  view: ProjectView;
  slug: string;
  token: string;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const rubric = view.rubric;
  const [name, setName] = useState(rubric?.name ?? '');
  const [preamble, setPreamble] = useState(rubric?.preamble ?? '');
  const [criteria, setCriteria] = useState<RubricCriterion[]>(rubric?.criteria ?? []);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const history = useAsync(() => api.rubrics(slug, token), [slug, token, rubric?.id]);

  if (!rubric) return <div className="empty">This project has no rubric yet.</div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(null);
    try {
      const res = await api.saveRubric(slug, token, { name, preamble, criteria });
      setSaved(
        res.forked
          ? `Saved as v${res.rubric.version}. A round already pinned the previous version, so it was kept intact.`
          : `Saved v${res.rubric.version}.`,
      );
      history.reload();
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the rubric.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rail-grid">
      <div className="rail">
        <span className="num">B</span>
        <span className="rail-label">Rubric</span>
        <span className="rail-note">What a pass means.</span>
      </div>
      <div className="col">
        <div className="panel">
          <div className="between">
            <h3 style={{ marginTop: 0 }}>Version {rubric.version}</h3>
            <div className="shrink stack" style={{ flexDirection: 'row', gap: 8 }}>
              <a className="btn ghost tiny-btn" href={api.exportUrl(rubric.id, token, 'md')} target="_blank" rel="noreferrer">
                Markdown
              </a>
              <a className="btn ghost tiny-btn" href={api.exportUrl(rubric.id, token, 'json')} target="_blank" rel="noreferrer">
                JSON
              </a>
              <a className="btn ghost tiny-btn" href={api.exportUrl(rubric.id, token, 'judge')} target="_blank" rel="noreferrer">
                Judge prompt
              </a>
            </div>
          </div>

          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="rubric-name">Name</label>
              <input id="rubric-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="rubric-preamble">What are graders deciding?</label>
              <textarea id="rubric-preamble" rows={5} value={preamble} onChange={(e) => setPreamble(e.target.value)} />
            </div>

            <div className="field">
              <label>Verdict scale</label>
              <div className="pill-row">
                {[...rubric.scale]
                  .sort((a, b) => b.rank - a.rank)
                  .map((level) => (
                    <span key={level.id} className="pill on">
                      {level.label}
                    </span>
                  ))}
                <span className="pill">abstain</span>
              </div>
              <p className="tiny" style={{ margin: 0 }}>
                Abstain is always available and never counts as agreement. It shows up in coverage instead.
              </p>
            </div>

            <div className="field">
              <label>Criteria</label>
              {criteria.map((criterion, i) => (
                <div key={criterion.id} className="panel" style={{ marginBottom: 10, padding: '14px 16px' }}>
                  <div className="row">
                    <input
                      value={criterion.title}
                      onChange={(e) =>
                        setCriteria(criteria.map((c, j) => (i === j ? { ...c, title: e.target.value } : c)))
                      }
                      aria-label="Criterion title"
                    />
                    <div className="shrink">
                      <button
                        type="button"
                        className="ghost tiny-btn"
                        onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}
                      >
                        remove
                      </button>
                    </div>
                  </div>
                  <textarea
                    style={{ marginTop: 8 }}
                    rows={3}
                    value={criterion.body}
                    onChange={(e) => setCriteria(criteria.map((c, j) => (i === j ? { ...c, body: e.target.value } : c)))}
                    aria-label="Criterion body"
                  />
                </div>
              ))}
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setCriteria([...criteria, { id: `c${Date.now()}`, title: 'New criterion', body: '' }])
                }
              >
                Add criterion
              </button>
            </div>

            {rubric.clauses.length > 0 ? (
              <div className="field">
                <label>Clauses from resolved disagreements</label>
                <ul className="plain">
                  {rubric.clauses.map((clause) => (
                    <li key={clause.id}>{clause.text}</li>
                  ))}
                </ul>
                <p className="tiny" style={{ margin: 0 }}>
                  These are written during split resolution, not here — each one exists because two graders landed in
                  different places on a real trace.
                </p>
              </div>
            ) : null}

            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save rubric'}
            </button>
            {saved ? <span className="tiny" style={{ marginLeft: 12 }}>{saved}</span> : null}
          </form>
        </div>

        {history.data && history.data.rubrics.length > 1 ? (
          <div className="scroll-x">
            <table>
              <caption>Version history</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Name</th>
                  <th scope="col">Clauses</th>
                  <th scope="col">Created</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {history.data.rubrics.map((r) => (
                  <tr key={r.id}>
                    <td>v{r.version}</td>
                    <td className="case">{r.name}</td>
                    <td>{r.clauses.length}</td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      <a className="btn ghost tiny-btn" href={api.exportUrl(r.id, token, 'md')} target="_blank" rel="noreferrer">
                        export
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
