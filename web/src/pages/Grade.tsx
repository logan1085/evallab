import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ABSTAIN } from '@shared/types';
import { api, recallGrader, recallKey, type QueueView } from '../api';
import { ErrorBanner, Loading, Masthead, minutes, useAsync } from '../ui';

/**
 * The grading view.
 *
 * There is deliberately nothing on this screen about anyone else: no other
 * grader's verdict, no running tally of what the group thinks, no indication of
 * which arm a trace belongs to. The server does not send any of it, and this
 * page does not ask. Blindness is the whole basis of the measurement.
 */
export function GradePage() {
  const { slug, roundId } = useParams<{ slug: string; roundId: string }>();
  const navigate = useNavigate();
  const token = recallKey(slug!) ?? '';
  const grader = recallGrader(slug!);

  const { data, loading, error, setData } = useAsync<QueueView>(
    () => api.queue(roundId!, token, grader?.id ?? ''),
    [roundId, token, grader?.id],
  );

  const [index, setIndex] = useState(0);
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const startedAt = useRef(Date.now());

  const items = data?.items ?? [];
  const item = items[index];
  const scale = useMemo(() => [...(data?.rubric?.scale ?? [])].sort((a, b) => b.rank - a.rank), [data?.rubric]);
  const done = items.filter((i) => i.myVerdict).length;

  // Reset the per-item clock whenever the grader lands on a different trace, so
  // elapsed time reflects attention on that trace rather than session length.
  useEffect(() => {
    startedAt.current = Date.now();
    setNote(item?.myNote ?? '');
  }, [item?.itemId, item?.myNote]);

  if (!grader) {
    return (
      <main className="sheet">
        <Masthead crumbs={[{ label: 'Project', to: `/p/${slug}` }]} title="Join before you grade" />
        <p className="lede">
          Your grades need a name attached so agreement can be computed between people. Set one on the project page.
        </p>
        <Link className="btn" to={`/p/${slug}`}>
          Back to the project
        </Link>
      </main>
    );
  }

  if (loading && !data) return <main className="sheet"><Loading what="round" /></main>;
  if (error) return <main className="sheet"><ErrorBanner message={error} /></main>;
  if (!data || !item) return <main className="sheet"><div className="empty">This round has no items.</div></main>;

  async function grade(verdict: string) {
    const current = items[index];
    if (!current) return;
    setSaveError(null);
    try {
      await api.submitGrade(roundId!, token, {
        graderId: grader!.id,
        itemId: current.itemId,
        verdict,
        note,
        elapsedMs: Date.now() - startedAt.current,
      });
      setData({
        ...data!,
        items: items.map((i) => (i.itemId === current.itemId ? { ...i, myVerdict: verdict, myNote: note } : i)),
      });
      const nextUngraded = items.findIndex((i, j) => j > index && !i.myVerdict);
      if (nextUngraded >= 0) setIndex(nextUngraded);
      else if (index < items.length - 1) setIndex(index + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save that grade.');
    }
  }

  const allDone = done === items.length;

  return (
    <main className="sheet sheet--wide">
      <Masthead
        crumbs={[{ label: 'Project', to: `/p/${slug}` }, data.round.name, `grading as ${grader.name}`]}
        title={`Trace ${index + 1} of ${items.length}`}
        standfirst={item.title}
      />

      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <p className="tiny" style={{ marginBottom: 20 }}>
        {done} of {items.length} graded · budget about {minutes(data.attention.minutes * 60000)} for the round · nobody
        else&rsquo;s verdicts are visible until the round closes
      </p>

      <ErrorBanner message={saveError} onDismiss={() => setSaveError(null)} />

      <div className="rail-grid" style={{ gridTemplateColumns: 'minmax(0, 1.65fr) minmax(0, 1fr)', gap: 28 }}>
        <div className="col">
          <div className="transcript">{item.content}</div>

          {Object.keys(item.meta).length > 0 ? (
            <details style={{ marginTop: 12 }}>
              <summary className="tiny" style={{ cursor: 'pointer' }}>
                METADATA FROM THE EXPORT
              </summary>
              <pre className="transcript" style={{ maxHeight: 180, marginTop: 8 }}>
                {JSON.stringify(item.meta, null, 2)}
              </pre>
            </details>
          ) : null}

          <div className="pill-row" style={{ marginTop: 16 }}>
            <button className="pill" onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0}>
              ← previous
            </button>
            <button
              className="pill"
              onClick={() => setIndex(Math.min(items.length - 1, index + 1))}
              disabled={index === items.length - 1}
            >
              next →
            </button>
            {items.map((i, j) => (
              <button
                key={i.itemId}
                className={`pill ${j === index ? 'on' : ''}`}
                onClick={() => setIndex(j)}
                title={i.myVerdict ? 'graded' : 'not graded'}
                style={{ color: i.myVerdict ? 'var(--agree)' : undefined }}
              >
                {j + 1}
              </button>
            ))}
          </div>
        </div>

        <div className="col">
          <div className="panel">
            <span className="metric-k">Your verdict</span>
            <div className="verdict-picker" style={{ marginTop: 10 }}>
              {scale.map((level) => (
                <button
                  key={level.id}
                  className={item.myVerdict === level.id ? 'selected' : ''}
                  onClick={() => grade(level.id)}
                >
                  {level.label}
                </button>
              ))}
            </div>
            {/*
              Abstaining is a real outcome, not a fourth verdict — it never counts
              as agreement. Giving it the same weight as pass/partial/fail would
              invite it as an easy way out of a hard call.
            */}
            <div className="abstain-row">
              <button
                className={`abstain ${item.myVerdict === ABSTAIN ? 'selected' : ''}`}
                onClick={() => grade(ABSTAIN)}
              >
                Can&rsquo;t tell from this trace
              </button>
            </div>

            <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
              <label htmlFor="note">Note (optional, shown in the split report)</label>
              <textarea
                id="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why this verdict, in a sentence."
              />
            </div>
          </div>

          {data.rubric ? (
            <div className="panel">
              <span className="metric-k">Rubric v{data.rubric.version}</span>
              <h3 style={{ marginTop: 6 }}>{data.rubric.name}</h3>
              {data.rubric.preamble ? <p className="note">{data.rubric.preamble}</p> : null}
              {data.rubric.criteria.map((criterion) => (
                <div key={criterion.id}>
                  <h3>{criterion.title}</h3>
                  <p className="note">{criterion.body}</p>
                </div>
              ))}
              {data.rubric.clauses.length > 0 ? (
                <>
                  <h3>Clauses from earlier rounds</h3>
                  <ul className="plain">
                    {data.rubric.clauses.map((clause) => (
                      <li key={clause.id} style={{ fontSize: 15 }}>
                        {clause.text}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          {allDone ? (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>You&rsquo;re done</h3>
              <p className="note">
                Closing the round reveals every verdict and stops accepting new grades. Do it once everyone has
                finished — there is no reopening, because a round you can grade after reading is not blind.
              </p>
              <button
                onClick={async () => {
                  setClosing(true);
                  try {
                    await api.closeRound(roundId!, token);
                    navigate(`/p/${slug}/round/${roundId}`);
                  } catch (err) {
                    setSaveError(err instanceof Error ? err.message : 'Could not close the round.');
                    setClosing(false);
                  }
                }}
                disabled={closing}
              >
                {closing ? 'Closing…' : 'Close the round and open the report'}
              </button>
              <p className="tiny" style={{ marginTop: 10 }}>
                Or leave it open and send the link to whoever has not graded yet.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
