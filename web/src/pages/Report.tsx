import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { SplitCluster } from '@shared/splits';
import type { ItemArm, RubricVersion, SplitReportRow, VerdictLevel } from '@shared/types';
import { api, recallGrader, recallKey, type JudgeRunView, type ReportView } from '../api';
import { AgreementPanel, ErrorBanner, Loading, Masthead, pct, useAsync, Verdict } from '../ui';

/**
 * The report.
 *
 * Splits come first and the aggregate comes second, on purpose. The number at
 * the top of a dashboard is the thing teams already have; the specific cases
 * where two people disagreed are the thing they do not, and they are the only
 * part of this screen that can be acted on.
 */
export function ReportPage() {
  const { slug, roundId } = useParams<{ slug: string; roundId: string }>();
  const token = recallKey(slug!) ?? '';
  const [error, setError] = useState<string | null>(null);

  const { data, loading, reload } = useAsync<ReportView>(() => api.report(roundId!, token), [roundId, token]);

  // The primary metric is "did held-out agreement improve after a calibration
  // round", so the previous round's held-out number has to be on this screen.
  const [previousHeldout, setPreviousHeldout] = useState<number | null>(null);
  useEffect(() => {
    const source = data?.round.sourceRoundId;
    if (!source) {
      setPreviousHeldout(null);
      return;
    }
    let cancelled = false;
    api
      .report(source, token)
      .then((prev) => {
        if (!cancelled) setPreviousHeldout(prev.heldout.agreement.units > 0 ? prev.heldout.agreement.observed : null);
      })
      .catch(() => {
        if (!cancelled) setPreviousHeldout(null);
      });
    return () => {
      cancelled = true;
    };
  }, [data?.round.sourceRoundId, token]);

  if (loading && !data) return <main className="sheet"><Loading what="report" /></main>;
  if (!data) return <main className="sheet"><ErrorBanner message="Could not load this report." /></main>;

  const scale = data.rubric?.scale ?? [];
  const unresolved = data.clusters.reduce((n, c) => n + c.rows.filter((r) => !r.resolved).length, 0);

  return (
    <main className="sheet sheet--wide">
      <Masthead
        crumbs={[{ label: 'Project', to: `/p/${slug}` }, data.round.name, `rubric v${data.rubric?.version ?? '—'}`]}
        title={
          data.splitCount === 0
            ? 'Your team agreed on everything'
            : `${data.splitCount} decision${data.splitCount === 1 ? '' : 's'} your team needs to make once`
        }
        standfirst={
          data.splitCount === 0
            ? 'Every vote landed in the same place. Either the standard is genuinely settled, or this sample avoided the hard cases.'
            : 'Careful people voted differently on these. Settle each one and the answer becomes a test case — made once, instead of re-made silently on every future run.'
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <p className="note" style={{ marginBottom: 26 }}>
        {data.samplingNote}
      </p>

      {/* ---- Splits first ------------------------------------------------ */}

      <section className="band rail-grid">
        <div className="rail">
          <span className="num">01</span>
          <span className="rail-label">Where they disagreed</span>
          <span className="rail-note">Clustered by kind.</span>
        </div>
        <div className="col">
          {data.heldoutSplitCount > 0 ? (
            <p className="note">
              {data.heldoutSplitCount} further split{data.heldoutSplitCount === 1 ? ' is' : 's are'} in the held-out
              arm and {data.heldoutSplitCount === 1 ? 'is' : 'are'} not listed here. Held-out cases are what the
              primary metric is measured on, so writing a rubric clause about one would be editing the rubric against
              your own test set. They still count in the numbers below.
            </p>
          ) : null}

          {data.embargoedCount > 0 ? (
            <div className="warn">
              <span className="metric-k">Some verdicts are withheld</span>
              <p style={{ margin: '6px 0 0' }}>
                {data.embargoedCount} of these traces are in a round somebody is still grading, so their verdicts stay
                hidden until that round closes. Reusing traces across rounds is how before-and-after gets measured on
                the same cases, and it only works if the later round&rsquo;s graders cannot look up the earlier
                answers. The aggregate numbers below are unaffected.
              </p>
            </div>
          ) : null}

          {data.clusters.length === 0 ? (
            <div className="empty">Nothing to resolve.</div>
          ) : (
            data.clusters.map((cluster) => (
              <ClusterBlock
                key={cluster.key}
                cluster={cluster}
                report={data}
                scale={scale}
                roundId={roundId!}
                token={token}
                slug={slug!}
                onChange={reload}
                onError={setError}
              />
            ))
          )}
        </div>
      </section>

      {/* ---- Ship -------------------------------------------------------- */}

      <ShipSection
        report={data}
        roundId={roundId!}
        token={token}
        unresolved={unresolved}
        onChange={reload}
        onError={setError}
      />

      <EvalSetSection roundId={roundId!} token={token} splitCount={data.splitCount} reloadKey={data.resolutions.length} />

      {/* ---- Aggregate --------------------------------------------------- */}

      <section className="band rail-grid">
        <div className="rail">
          <span className="num">04</span>
          <span className="rail-label">The number</span>
          <span className="rail-note">Second, not first.</span>
        </div>
        <div className="col">
          <h2>Agreement, with coverage next to it</h2>
          <p className="lede">
            Coverage sits beside agreement because a rubric can buy agreement by saying less. If agreement climbs while
            coverage falls, the metric is eating the product.
          </p>

          {data.heldout.agreement.units > 0 ? (
            <>
              <h3>Held out — the primary metric</h3>
              <p className="note">
                These traces were graded but never discussed, so they are the honest test of whether a calibration round
                moved anything.
              </p>
              <AgreementPanel
                label="Held-out"
                agreement={data.heldout.agreement}
                coverage={data.heldout.coverage}
                compareTo={previousHeldout}
              />
            </>
          ) : (
            <div className="warn">
              <span className="metric-k">No held-out arm</span>
              <p style={{ margin: '6px 0 0' }}>
                This round reserved no held-out traces, so there is no clean before-and-after to measure. Add a held-out
                arm to the next round.
              </p>
            </div>
          )}

          <h3>Calibration arm</h3>
          <AgreementPanel label="Calibration" agreement={data.calibration.agreement} coverage={data.calibration.coverage} />

          <h3>Per-pair agreement</h3>
          <p className="note">
            With three to five graders this is often more useful than the aggregate: it shows whether disagreement is
            spread evenly or coming from one person reading the rubric differently.
          </p>
          <div className="scroll-x">
            <table>
              <caption>Observed agreement between each pair, across the whole round</caption>
              <thead>
                <tr>
                  <th scope="col">Pair</th>
                  <th scope="col">Agreed</th>
                  <th scope="col">Compared</th>
                  <th scope="col">Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.overall.agreement.pairwise).map(([key, value]) => {
                  const [a, b] = key.split('|');
                  const nameOf = (id: string) => data.graders.find((g) => g.id === id)?.name ?? id;
                  return (
                    <tr key={key}>
                      <td className="case">
                        {nameOf(a!)} &amp; {nameOf(b!)}
                      </td>
                      <td>{value.agreed}</td>
                      <td>{value.compared}</td>
                      <td>{pct(value.rate, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- Matrix ------------------------------------------------------ */}

      <section className="band rail-grid">
        <div className="rail">
          <span className="num">05</span>
          <span className="rail-label">Every scenario</span>
          <span className="rail-note">Splits shaded.</span>
        </div>
        <div className="col">
          <div className="scroll-x">
            <table>
              <caption>
                {data.rows.length} traces × {data.graders.length} graders
              </caption>
              <thead>
                <tr>
                  <th scope="col">Trace</th>
                  {data.graders.map((g) => (
                    <th key={g.id} scope="col">
                      {g.name}
                    </th>
                  ))}
                  <th scope="col">Arm</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.itemId} className={!row.embargoed && row.kind !== 'unanimous' ? 'is-split' : ''}>
                    <td className="case">{row.title}</td>
                    {row.embargoed ? (
                      <td colSpan={data.graders.length} className="tiny">
                        withheld — in a round being graded now
                      </td>
                    ) : (
                      data.graders.map((g) => (
                        <td key={g.id}>
                          <Verdict verdict={row.byGrader[g.id]} scale={scale} />
                        </td>
                      ))
                    )}
                    <td>{row.arm === 'heldout' ? 'held out' : 'calibration'}</td>
                    <td className="flag">
                      {row.embargoed ? '' : row.kind === 'unanimous' ? '' : row.resolved ? <span className="resolved-badge">resolved</span> : row.kind}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- Judge ------------------------------------------------------- */}

      <JudgeSection slug={slug!} roundId={roundId!} token={token} report={data} onError={setError} />
    </main>
  );
}

/* ---- Clusters ----------------------------------------------------------- */

function ClusterBlock({
  cluster,
  report,
  scale,
  roundId,
  token,
  slug,
  onChange,
  onError,
}: {
  cluster: SplitCluster;
  report: ReportView;
  scale: VerdictLevel[];
  roundId: string;
  token: string;
  slug: string;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const label = cluster.verdicts
    .map((v) => scale.find((s) => s.id === v)?.label ?? v)
    .join(' vs ');

  return (
    <div className="cluster">
      <div className="cluster-head">
        <span className="verdict v-fail">{cluster.kind}</span>
        <strong style={{ fontFamily: 'var(--display)', fontSize: 15 }}>{label}</strong>
        <span className="tiny">
          {cluster.rows.length} trace{cluster.rows.length === 1 ? '' : 's'} · {cluster.rows.filter((r) => r.resolved).length} resolved
        </span>
      </div>
      <div className="cluster-body">
        {cluster.rows.map((row) => (
          <SplitRow
            key={row.itemId}
            row={row}
            report={report}
            scale={scale}
            roundId={roundId}
            token={token}
            slug={slug}
            onChange={onChange}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}

function SplitRow({
  row,
  report,
  scale,
  roundId,
  token,
  slug,
  onChange,
  onError,
}: {
  row: SplitReportRow;
  report: ReportView;
  scale: VerdictLevel[];
  roundId: string;
  token: string;
  slug: string;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const existing = report.resolutions.find((r) => r.itemId === row.itemId);
  const notes = report.notes.filter((n) => n.itemId === row.itemId);
  const [open, setOpen] = useState(false);
  const [agreedVerdict, setAgreedVerdict] = useState(existing?.agreedVerdict ?? row.verdicts[0] ?? '');
  const [clauseText, setClauseText] = useState(existing?.clauseText ?? '');
  const [busy, setBusy] = useState(false);
  const me = recallGrader(slug);

  return (
    <div className="split-row">
      <div className="between">
        <div className="split-title">{row.title}</div>
        {existing ? <span className="resolved-badge">resolved</span> : null}
      </div>

      <div className="grader-verdicts">
        {report.graders.map((g) => (
          <div key={g.id} className="grader-verdict">
            <b>{g.name}</b>
            <Verdict verdict={row.byGrader[g.id]} scale={scale} />
          </div>
        ))}
      </div>

      {notes.length > 0 ? (
        <ul className="plain" style={{ fontSize: 15 }}>
          {notes.map((note, i) => (
            <li key={i}>
              <strong>{report.graders.find((g) => g.id === note.graderId)?.name ?? 'Someone'}:</strong> {note.note}
            </li>
          ))}
        </ul>
      ) : null}

      {existing ? (
        <div className="keyline">
          <p>{existing.clauseText}</p>
          <p className="tiny" style={{ margin: 0 }}>
            Agreed: {scale.find((s) => s.id === existing.agreedVerdict)?.label ?? existing.agreedVerdict}
            {existing.resolvedBy ? ` · recorded by ${existing.resolvedBy}` : ''}
            {'  '}
            <button
              className="ghost tiny-btn"
              style={{ marginLeft: 8 }}
              onClick={async () => {
                try {
                  await api.unresolve(roundId, token, row.itemId);
                  onChange();
                } catch (err) {
                  onError(err instanceof Error ? err.message : 'Could not undo that resolution.');
                }
              }}
            >
              undo
            </button>
          </p>
        </div>
      ) : open ? (
        <form
          className="panel"
          style={{ marginTop: 10, marginBottom: 0 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.resolve(roundId, token, row.itemId, {
                agreedVerdict,
                clauseText,
                rationale: '',
                resolvedBy: me?.name ?? '',
              });
              setOpen(false);
              onChange();
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Could not save that resolution.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field">
            <label>Where did you land?</label>
            <div className="verdict-picker">
              {[...scale]
                .sort((a, b) => b.rank - a.rank)
                .map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    className={agreedVerdict === level.id ? 'selected' : ''}
                    onClick={() => setAgreedVerdict(level.id)}
                  >
                    {level.label}
                  </button>
                ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor={`clause-${row.itemId}`}>
              What would the rubric have to say for you to have landed in the same place?
            </label>
            <textarea
              id={`clause-${row.itemId}`}
              rows={3}
              value={clauseText}
              onChange={(e) => setClauseText(e.target.value)}
              placeholder="One sentence, general enough to apply to the next trace like this one."
            />
          </div>
          <button type="submit" disabled={busy || clauseText.trim().length < 3 || !agreedVerdict}>
            {busy ? 'Saving…' : 'Add this sentence to the rubric'}
          </button>{' '}
          <button type="button" className="ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="ghost tiny-btn" onClick={() => setOpen(true)}>
          Settle this disagreement
        </button>
      )}
    </div>
  );
}

/* ---- Ship --------------------------------------------------------------- */

function ShipSection({
  report,
  roundId,
  token,
  unresolved,
  onChange,
  onError,
}: {
  report: ReportView;
  roundId: string;
  token: string;
  unresolved: number;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [shipped, setShipped] = useState<RubricVersion | null>(null);

  return (
    <section className="band rail-grid">
      <div className="rail">
        <span className="num">02</span>
        <span className="rail-label">Update the standards</span>
        <span className="rail-note">Settled once, kept forever.</span>
      </div>
      <div className="col">
        <h2>Write what you settled into your standards</h2>
        <p className="lede">
          {report.resolutions.length === 0
            ? 'Nothing settled yet. Each settled disagreement becomes one sentence in your standards, carrying the scenario it came from — so "why does the standard say this?" always has an answer.'
            : `${report.resolutions.length} settled decision${report.resolutions.length === 1 ? '' : 's'} ready to write in${unresolved > 0 ? `, with ${unresolved} disagreement${unresolved === 1 ? '' : 's'} still open` : ''}.`}
        </p>

        {shipped ? (
          <div className="panel">
            <span className="metric-k">Shipped</span>
            <p style={{ marginTop: 6 }}>
              Rubric v{shipped.version} now carries {shipped.clauses.length} clause
              {shipped.clauses.length === 1 ? '' : 's'}. The next round is what turns that into evidence: same
              held-out traces, same people, graded against the revised rubric.
            </p>
            <NextRound report={report} roundId={roundId} token={token} onError={onError} />{' '}
            <a className="btn ghost" href={api.exportUrl(shipped.id, token, 'md')} target="_blank" rel="noreferrer">
              Export the updated standards
            </a>
          </div>
        ) : (
          <button
            disabled={busy || report.resolutions.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await api.ship(roundId, token);
                setShipped(res.rubric);
                onChange();
              } catch (err) {
                onError(err instanceof Error ? err.message : 'Could not ship the revision.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : `Save standards v${(report.rubric?.version ?? 1) + 1}`}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * One click from a shipped rubric to the round that tests it, prefilled to be
 * comparable: drawn from this round's splits, on the identical held-out set.
 * Anything the user has to reconstruct by hand here is a place the second round
 * does not happen.
 */
function NextRound({
  report,
  roundId,
  token,
  onError,
}: {
  report: ReportView;
  roundId: string;
  token: string;
  onError: (m: string) => void;
}) {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const [busy, setBusy] = useState(false);

  const calibrationSize = report.rows.filter((r) => r.arm === 'calibration').length;
  const heldoutSize = report.rows.filter((r) => r.arm === 'heldout').length;

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.createRound(slug!, token, {
            name: `Round ${report.round.index + 1}`,
            calibrationSize,
            heldoutSize,
            strategy: 'from_splits',
            sourceRoundId: roundId,
            reuseHeldout: true,
          });
          navigate(`/p/${slug}`);
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Could not start the next round.');
          setBusy(false);
        }
      }}
    >
      {busy ? 'Sampling…' : `Start round ${report.round.index + 1} on the same held-out traces`}
    </button>
  );
}

/* ---- Judge -------------------------------------------------------------- */

function JudgeSection({
  slug,
  roundId,
  token,
  report,
  onError,
}: {
  slug: string;
  roundId: string;
  token: string;
  report: ReportView;
  onError: (m: string) => void;
}) {
  const { data, reload } = useAsync<{ runs: JudgeRunView[]; real: boolean }>(
    () => api.judgeRuns(roundId, token),
    [roundId, token],
  );
  const rubrics = useAsync(() => api.rubrics(slug, token), [slug, token]);
  const [arm, setArm] = useState<ItemArm>('heldout');
  const [rubricId, setRubricId] = useState('');
  const [busy, setBusy] = useState(false);

  const versions = useMemo(() => rubrics.data?.rubrics ?? [], [rubrics.data]);
  useEffect(() => {
    if (!rubricId && versions.length > 0) setRubricId(versions[versions.length - 1]!.id);
  }, [versions, rubricId]);

  const runs = data?.runs ?? [];
  const real = data?.real ?? false;

  return (
    <section className="band rail-grid">
      <div className="rail">
        <span className="num">06</span>
        <span className="rail-label">The judge</span>
        <span className="rail-note">Why this exists.</span>
      </div>
      <div className="col">
        <h2>Build a judge from a rubric version and score it against the humans</h2>
        <p className="lede">
          The judge is given the rubric verbatim — the same text the graders read — and is then treated as one more
          rater on the same items, so its agreement with humans is computed exactly the way theirs is with each other.
          Run it against two rubric versions to see whether calibration bought anything.
        </p>

        {!real ? (
          <div className="warn">
            <span className="metric-k">Offline stub, not a judge</span>
            <p style={{ margin: '6px 0 0' }}>
              No <code>ANTHROPIC_API_KEY</code> is set, so runs use a deterministic keyword scorer. It exercises the
              workflow and nothing more — do not read its agreement number as evidence about anything.
            </p>
          </div>
        ) : null}

        <div className="panel">
          <div className="row">
            <div className="field">
              <label htmlFor="judge-rubric">Rubric version</label>
              <select id="judge-rubric" value={rubricId} onChange={(e) => setRubricId(e.target.value)}>
                {versions.map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} — {r.clauses.length} clause{r.clauses.length === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="judge-arm">Arm</label>
              <select id="judge-arm" value={arm} onChange={(e) => setArm(e.target.value as ItemArm)}>
                <option value="heldout">Held out</option>
                <option value="calibration">Calibration</option>
              </select>
            </div>
            <div className="shrink" style={{ paddingBottom: 16 }}>
              <button
                disabled={busy || !rubricId}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.runJudge(roundId, token, rubricId, arm);
                    reload();
                  } catch (err) {
                    onError(err instanceof Error ? err.message : 'The judge run failed.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Grading…' : 'Run the judge'}
              </button>
            </div>
          </div>
          <p className="tiny" style={{ margin: 0 }}>
            Held out is the honest arm: the judge has not been tuned on it and neither has the rubric.
          </p>
        </div>

        {runs.length === 0 ? (
          <div className="empty">No judge runs yet.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <caption>Judge runs, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">Rubric</th>
                  <th scope="col">Arm</th>
                  <th scope="col">Model</th>
                  <th scope="col">Items</th>
                  <th scope="col">Agreement with humans</th>
                  <th scope="col">Judge abstained</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>v{run.rubricVersion ?? '—'}</td>
                    <td>{run.arm === 'heldout' ? 'held out' : 'calibration'}</td>
                    <td>{run.model}</td>
                    <td>{run.itemCount}</td>
                    <td style={{ color: 'var(--ink)' }}>{pct(run.agreementWithHumans, 1)}</td>
                    <td>{run.judgeAbstentions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {runs.length >= 2 ? (
          <p className="note" style={{ marginTop: 14 }}>
            Two runs on the same arm with different rubric versions is the comparison that matters. If the calibrated
            version does not beat the original by more than a couple of points, that is a finding about the product,
            not a bug in the run.
          </p>
        ) : null}

        <p className="tiny" style={{ marginTop: 18 }}>
          <Link to={`/p/${slug}`}>Back to the project</Link> · {report.graders.length} graders in this round
        </p>
      </div>
    </section>
  );
}

/* ---- The eval set -------------------------------------------------------- */

/**
 * The deliverable. Everything above this section is how the eval set gets
 * earned; this is where it leaves the building. Re-fetched whenever a
 * resolution lands, so settling a disagreement visibly grows the set.
 */
function EvalSetSection({
  roundId,
  token,
  splitCount,
  reloadKey,
}: {
  roundId: string;
  token: string;
  splitCount: number;
  reloadKey: number;
}) {
  const { data } = useAsync(() => api.evalset(roundId, token), [roundId, token, reloadKey]);
  if (!data) return null;

  return (
    <section className="band rail-grid">
      <div className="rail">
        <span className="num">03</span>
        <span className="rail-label">Your eval set</span>
        <span className="rail-note">The deliverable.</span>
      </div>
      <div className="col">
        <h2>
          {data.caseCount} test case{data.caseCount === 1 ? '' : 's'}, extracted from your team
        </h2>
        <p className="lede">
          Every case is a scenario your team judged the same way — or disagreed on and then settled, once, on the
          record. Nothing here is averaged{splitCount > 0 ? '; settle the disagreements above and the set grows' : ''}.
        </p>

        <div className="metrics">
          <div className="metric">
            <span className="metric-k">Test cases</span>
            <span className="metric-big">{data.caseCount}</span>
            <span className="metric-sub">
              {data.cases.filter((c) => c.basis === 'unanimous').length} unanimous ·{' '}
              {data.cases.filter((c) => c.basis === 'resolved').length} settled
            </span>
          </div>
          <div className="metric">
            <span className="metric-k">Not exported</span>
            <span className="metric-big">{data.excluded.length}</span>
            <span className="metric-sub">disagreements, thin votes, and held-back cases</span>
          </div>
        </div>

        {data.caseCount > 0 ? (
          <div className="row" style={{ alignItems: 'center' }}>
            <div className="shrink">
              <a className="btn" href={api.evalsetUrl(roundId, token)} download>
                Download eval set (.jsonl)
              </a>
            </div>
            <p className="tiny" style={{ margin: 0, flex: '1 1 auto' }}>
              One case per line: the scenario, the verdict your team stands behind, and why. Drop it into whatever
              runs your evals. The judge prompt travels in the JSON export.
            </p>
          </div>
        ) : (
          <div className="empty">
            No cases yet. A case needs at least two matching votes, or a settled disagreement.
          </div>
        )}

        {data.excluded.length > 0 ? (
          <p className="tiny" style={{ marginTop: 14 }}>
            Held-back cases stay out on purpose — they are how the next poll measures whether agreement is improving
            on untouched ground. Exporting them with answers attached would be teaching to the test.
          </p>
        ) : null}
      </div>
    </section>
  );
}
