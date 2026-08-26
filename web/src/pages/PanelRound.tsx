import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, recallKey, type PanelCaseView, type PanelMapView, type PatchView } from '../api';
import { ErrorBanner, Loading, Masthead, pct, useAsync } from '../ui';

/**
 * A panel round, start to finish on one page: the seats grade (live, per
 * seat), the disagreement map appears, the rubric diff is mined from it, the
 * owner grades their ten, and the bundle exports. The order on the page is
 * the order the spec argues for: the map is the evidence, the diff is the
 * product, the ten is what keeps it honest, the export is what you leave with.
 */

const PATTERN_COPY: Record<PanelCaseView['pattern'], { label: string; hint: string }> = {
  'persona-driven': {
    label: 'Split on one stake',
    hint: 'Every seat agrees except one. This names the tradeoff your rubric refused to make.',
  },
  contested: {
    label: 'Contested',
    hint: 'The seats split with no clean line. The rubric does not decide these cases.',
  },
  'blind-spot': {
    label: 'Agreed by accident',
    hint: 'Same verdict, incompatible reasons. The rubric is being satisfied by accident.',
  },
  settled: {
    label: 'Settled',
    hint: 'The panel agrees. Provisional until you have checked some yourself: a panel can be confidently wrong together.',
  },
};

export function PanelRoundPage() {
  const { slug, roundId } = useParams<{ slug: string; roundId: string }>();
  const token = recallKey(slug!) ?? '';
  const [error, setError] = useState<string | null>(null);

  const [progress, setProgress] = useState<{ name: string; done: boolean }[]>([]);
  const [map, setMap] = useState<PanelMapView | null>(null);
  const [running, setRunning] = useState(false);
  const startedRef = useRef(false);

  const loadMap = useCallback(async () => {
    try {
      setMap(await api.panelMap(roundId!, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the map.');
    }
  }, [roundId, token]);

  // On arrival: if the round is open, run the panel seat by seat, then load
  // the map. Progress is real: each seat's entry flips when its call returns.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const round = await api.round(roundId!, token);
        if (round.round.status === 'closed') {
          await loadMap();
          return;
        }
        const view = await api.project(slug!, token);
        const seats = view.graders.filter((g) => g.kind === 'panelist');
        setProgress(seats.map((s) => ({ name: s.name, done: false })));
        setRunning(true);
        for (const seat of seats) {
          await api.runSeat(roundId!, token, seat.id);
          setProgress((p) => p.map((row) => (row.name === seat.name ? { ...row, done: true } : row)));
        }
        setRunning(false);
        await loadMap();
      } catch (err) {
        setRunning(false);
        setError(err instanceof Error ? err.message : 'The panel run failed partway.');
      }
    })();
  }, [roundId, slug, token, loadMap]);

  if (!map) {
    return (
      <main className="sheet sheet--wide">
        <Masthead crumbs={[{ label: 'Project', to: `/p/${slug}` }]} title="The panel is grading" standfirst="Every seat reads every case, blind. Nobody sees another seat's verdict." />
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        {progress.length === 0 ? (
          <Loading what="round" />
        ) : (
          <div className="panel" style={{ maxWidth: 560 }}>
            {progress.map((p) => (
              <p key={p.name} className="note" style={{ margin: '6px 0', color: p.done ? 'var(--agree)' : undefined }}>
                {p.done ? '✓' : running ? '…' : '·'} {p.name}
              </p>
            ))}
          </div>
        )}
      </main>
    );
  }

  const ordered: PanelCaseView['pattern'][] = ['persona-driven', 'contested', 'blind-spot', 'settled'];
  const disagreements = map.counts.personaDriven + map.counts.contested;

  return (
    <main className="sheet sheet--wide">
      <header className="masthead">
        <div className="stamp">
          <span><b>The Grading Room</b></span>
          <Link to={`/p/${slug}`}>Back to the Room</Link>
          <span>{map.round.name}</span>
        </div>
        <h1>
          {disagreements === 0 ? (
            'The panel agreed on everything.'
          ) : (
            <>
              Your panel split <span style={{ color: 'var(--signal)' }}>{disagreements}</span> time{disagreements === 1 ? '' : 's'}.
            </>
          )}
        </h1>
        <p className="standfirst">
          {disagreements === 0
            ? 'Either your rubric decides every case, or this case set avoided the hard ones. Check your ten below before believing it.'
            : 'Where the panel splits is where your rubric is silent. Each split below shows who disagreed and why.'}
        </p>
      </header>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <StandardsHandoff slug={slug!} roundId={roundId!} token={token} splits={disagreements} onError={setError} />

      {map.simulated ? (
        <div className="warn">
          <span className="metric-k">Simulated panel</span>
          <p style={{ margin: '6px 0 0' }}>
            No model API keys are set, so these verdicts come from a deterministic simulation, clearly not judgment.
            The full loop works; the verdicts mean nothing. Set ANTHROPIC_API_KEY (and OPENAI_API_KEY, GEMINI_API_KEY
            for real family diversity) to seat real models.
          </p>
        </div>
      ) : null}

      <div className="tiles" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '18px 0 8px' }}>
        {[
          { k: 'Split on one stake', v: map.counts.personaDriven },
          { k: 'Contested', v: map.counts.contested },
          { k: 'Agreed by accident', v: map.counts.blindSpots },
          { k: 'Settled', v: map.counts.settled },
        ].map((t) => (
          <div key={t.k} className="panel" style={{ margin: 0 }}>
            <div style={{ fontSize: 30, fontWeight: 650 }}>{t.v}</div>
            <div className="tiny">{t.k}</div>
          </div>
        ))}
      </div>
      <p className="tiny">
        Raw agreement {pct(map.agreement.observed, 0)}
        {map.agreement.ac1 !== null ? ` · AC1 ${map.agreement.ac1.toFixed(2)}` : ''}
        {map.agreement.alpha !== null ? ` · alpha ${map.agreement.alpha.toFixed(2)}` : ''}
        {' '}· AC1 is reported beside alpha because alpha collapses under the skewed pass rates of a working system.
      </p>

      <PatchesSection roundId={roundId!} token={token} onError={setError} />

      {/* ---- The map, grouped by what to do about it ---- */}
      {ordered.map((pattern) => {
        const cases = map.cases.filter((c) => c.pattern === pattern);
        if (cases.length === 0) return null;
        const copy = PATTERN_COPY[pattern];
        return (
          <section key={pattern} className="band">
            <h2 style={{ marginBottom: 4 }}>{copy.label}</h2>
            <p className="note" style={{ marginTop: 0 }}>{copy.hint}</p>
            {cases.map((c) => (
              <div key={c.itemId} className={`panel${pattern === 'persona-driven' || pattern === 'contested' ? ' is-split' : ''}`}>
                <div className="between">
                  <h3 style={{ margin: 0 }}>{c.title}</h3>
                  {c.pattern === 'settled' ? (
                    <span className="tiny shrink">{c.checkedByOwner ? 'checked by you' : 'provisional'}</span>
                  ) : c.dissenter ? (
                    <span className="tiny shrink">
                      dissenter: {c.dissenter}
                      {c.theater ? ' · theater: the rubric as written decided this, so it will not become a patch' : ''}
                    </span>
                  ) : null}
                </div>
                <details style={{ margin: '8px 0' }}>
                  <summary className="tiny" style={{ cursor: 'pointer' }}>the case</summary>
                  <div className="transcript" style={{ maxHeight: 200, marginTop: 8 }}>{c.content}</div>
                </details>
                <div style={{ display: 'grid', gap: 6 }}>
                  {c.votes.map((v) => {
                    const seatMeta = map.seats.find((s) => s.id === v.seatId);
                    const downWeighted = seatMeta !== undefined && seatMeta.weight < 1;
                    return (
                    <div key={v.seatId} className="between" style={{ gap: 12 }}>
                      <span className="tiny" style={{ flex: '0 0 220px', fontWeight: v.seatName === c.dissenter ? 650 : 400 }}>
                        {v.seatName}
                        {downWeighted ? ` (down-weighted x${seatMeta.weight})` : ''}
                      </span>
                      <span className={`verdict v-${v.verdict === 'pass' ? 'pass' : v.verdict === 'fail' ? 'fail' : 'mid'}`}>
                        {v.verdict}
                      </span>
                      <span className="tiny" style={{ flex: 1 }}>{v.reason}</span>
                    </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        );
      })}

      <SelfCheckSection roundId={roundId!} token={token} onError={setError} onChanged={loadMap} />
      <ExportSection roundId={roundId!} token={token} onError={setError} />

      <p className="tiny" style={{ marginTop: 30 }}>
        <Link to={`/p/${slug}`}>Back to the project</Link>
      </p>
    </main>
  );
}

/* ---- The handoff ---------------------------------------------------------- */

/**
 * The most important interaction in the product: every grounded split becomes
 * a sentence in one new Standards version, and the owner approves it on the
 * Standards page rather than editing here. The failure state is a sentence,
 * never a spinner.
 */
function StandardsHandoff({
  slug,
  roundId,
  token,
  splits,
  onError,
}: {
  slug: string;
  roundId: string;
  token: string;
  splits: number;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function write() {
    setBusy(true);
    setFailed(null);
    try {
      await api.writeStandards(roundId, token);
      window.location.href = `/s/${slug}?k=${encodeURIComponent(token)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The standards could not be written.';
      setFailed(message);
      onError(message);
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="between" style={{ alignItems: 'center' }}>
        <p style={{ margin: 0, maxWidth: 560 }}>
          {splits === 0
            ? 'No splits means no missing sentences from this round. Your standards stand as they are.'
            : 'Every split drafts the sentence your rubric was missing. Nothing is edited here; you read and approve the result on your Standards page.'}
        </p>
        <div className="shrink">
          <button onClick={write} disabled={busy || splits === 0}>
            {busy ? 'Writing…' : 'Write the next Standards'}
          </button>
        </div>
      </div>
      {failed ? (
        <p className="tiny" style={{ marginTop: 10 }}>
          {failed}{' '}
          <button className="ghost tiny-btn" onClick={write}>
            try again
          </button>
        </p>
      ) : null}
    </div>
  );
}

/* ---- The rubric diff ------------------------------------------------------ */

function PatchesSection({ roundId, token, onError }: { roundId: string; token: string; onError: (m: string) => void }) {
  const [patches, setPatches] = useState<PatchView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function mine() {
    setBusy(true);
    try {
      const res = await api.minePatches(roundId, token);
      setPatches(res.patches);
      if (res.dropped > 0) setNote(`${res.dropped} proposed clause${res.dropped === 1 ? '' : 's'} dropped for failing to quote the room verbatim.`);
      if (res.patches.length === 0 && res.dropped === 0) setNote('Nothing to propose: no contested cases in this round.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not mine the rubric diff.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(patch: PatchView, action: 'accept' | 'reject') {
    try {
      const res = await api.decidePatch(roundId, token, patch.id, action);
      setPatches((p) => (p ?? []).map((x) => (x.id === patch.id ? { ...x, status: res.patch.status } : x)));
      if (action === 'accept' && res.rubric) setNote(`Written into your standards as v${res.rubric.version}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not record that decision.');
    }
  }

  return (
    <section className="band" id="diff">
      <h2 style={{ marginBottom: 4 }}>The sentences your rubric is missing</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Mined from the contested cases. Every proposal quotes at least two verdict reasons verbatim, or it is dropped
        rather than shown: plausible ungrounded rubric language is the failure this exists to prevent.
      </p>
      {patches === null ? (
        <button onClick={mine} disabled={busy}>
          {busy ? 'Mining…' : 'Propose the missing sentences'}
        </button>
      ) : patches.length === 0 ? (
        <div className="empty">{note ?? 'Nothing to propose.'}</div>
      ) : (
        <>
          {note ? <p className="tiny">{note}</p> : null}
          {patches.map((p) => (
            <div key={p.id} className="panel">
              <p style={{ marginTop: 0, fontWeight: 550 }}>{p.text}</p>
              {p.evidence.map((e, i) => (
                <p key={i} className="tiny" style={{ margin: '4px 0' }}>
                  “{e.quote}” <span style={{ opacity: 0.7 }}>· {e.seat}</span>
                </p>
              ))}
              <p className="tiny">
                {p.seatsSided.length > 0 ? `Sides with ${p.seatsSided.join(', ')}. ` : ''}
                {p.projectedLift !== null ? `Would settle about ${pct(p.projectedLift, 0)} of the contested cases.` : ''}
              </p>
              {p.status === 'proposed' ? (
                <p style={{ margin: '10px 0 0' }}>
                  <button onClick={() => decide(p, 'accept')}>Add to my standards</button>{' '}
                  <button className="ghost" onClick={() => decide(p, 'reject')}>
                    Reject
                  </button>
                </p>
              ) : (
                <p className="tiny" style={{ margin: '10px 0 0' }}>{p.status}</p>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/* ---- The owner's ten ------------------------------------------------------ */

function SelfCheckSection({
  roundId,
  token,
  onError,
  onChanged,
}: {
  roundId: string;
  token: string;
  onError: (m: string) => void;
  onChanged: () => void;
}) {
  const { data, reload } = useAsync(() => api.selfCheck(roundId, token), [roundId, token]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [alignment, setAlignment] = useState<Awaited<ReturnType<typeof api.alignment>> | null>(null);

  const cases = data?.cases ?? [];
  const done = cases.filter((c) => c.myVerdict).length;
  const allDone = cases.length > 0 && done === cases.length;

  useEffect(() => {
    if (allDone) {
      api.alignment(roundId, token).then(setAlignment).catch(() => undefined);
    }
  }, [allDone, roundId, token]);

  async function grade(itemId: string, verdict: string) {
    try {
      await api.submitSelfCheck(roundId, token, { itemId, verdict, reason: reasons[itemId] ?? '' });
      reload();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save your call.');
    }
  }

  return (
    <section className="band" id="ten">
      <h2 style={{ marginBottom: 4 }}>Your ten</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Grade these yourself: four the panel fought over, four it settled, two more. This step is what keeps the whole
        thing honest. Where you disagree with a unanimous panel is a rubric clause no panel could ever have found,
        because it lives in your head or your business.
      </p>
      <p className="tiny">{done} of {cases.length} graded</p>
      {cases.map((c) => (
        <div key={c.itemId} className="panel">
          <h3 style={{ marginTop: 0 }}>{c.title}</h3>
          <div className="transcript" style={{ maxHeight: 180 }}>{c.content}</div>
          <div className="verdict-picker" style={{ marginTop: 10 }}>
            {['pass', 'recoverable', 'fail'].map((v) => (
              <button key={v} className={c.myVerdict === v ? 'selected' : ''} onClick={() => grade(c.itemId, v)}>
                {v}
              </button>
            ))}
          </div>
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <label htmlFor={`r-${c.itemId}`}>Why? One line.</label>
            <textarea
              id={`r-${c.itemId}`}
              rows={1}
              value={reasons[c.itemId] ?? c.myReason}
              onChange={(e) => setReasons((r) => ({ ...r, [c.itemId]: e.target.value }))}
              onBlur={() => (c.myVerdict ? grade(c.itemId, c.myVerdict) : undefined)}
            />
          </div>
        </div>
      ))}

      {alignment && alignment.graded > 0 ? (
        <>
          <h3>Who speaks for you</h3>
          <p className="note">
            Benchmarked against the 81 percent that expert humans reach with each other, never against 100. A seat
            near the ceiling speaks for you about as well as another person could.
          </p>
          <p style={{ margin: '0 0 12px' }}>
            <button
              className="ghost"
              onClick={async () => {
                try {
                  const res = await api.reweight(roundId, token);
                  onError(
                    res.changes.length === 0
                      ? 'No weights changed: the panel already matches your taste.'
                      : `Reweighted: ${res.changes.map((c) => `${c.seat} ${c.from} to ${c.to}`).join(', ')}. Applies to future rounds; history keeps its weights.`,
                  );
                } catch (err) {
                  onError(err instanceof Error ? err.message : 'Could not reweight.');
                }
              }}
            >
              Reweight the panel toward the seats that share your taste
            </button>
          </p>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th scope="col">Seat</th>
                  <th scope="col">Agreed with you</th>
                  <th scope="col">Rate</th>
                </tr>
              </thead>
              <tbody>
                {[...alignment.seats].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)).map((s) => (
                  <tr key={s.seatId}>
                    <td className="case">{s.name}</td>
                    <td>{s.agree} of {s.total}</td>
                    <td>{s.rate === null ? '–' : pct(s.rate, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Where the panel was confidently wrong</h3>
          {alignment.falseSettles.length === 0 ? (
            <p className="note">Nowhere, on the cases you checked. That is the panel earning some trust.</p>
          ) : (
            alignment.falseSettles.map((f) => (
              <div key={f.itemId} className="warn">
                <span className="metric-k">{f.title}</span>
                <p style={{ margin: '6px 0 0' }}>
                  The whole panel said {f.panelVerdict}; you said {f.yourVerdict}.
                  {f.yourReason ? ` Your reason: “${f.yourReason}”` : ''} This is a rubric sentence only you could
                  have written.
                </p>
                <p style={{ margin: '10px 0 0' }}>
                  <button
                    className="ghost tiny-btn"
                    onClick={async () => {
                      try {
                        await api.falseSettlePatch(roundId, token, f.itemId);
                        onError('Turned into a proposed patch. Find it in the missing-sentences list above.');
                      } catch (err) {
                        onError(err instanceof Error ? err.message : 'Could not make the patch.');
                      }
                    }}
                  >
                    Make it a rubric patch
                  </button>
                </p>
              </div>
            ))
          )}
        </>
      ) : null}
    </section>
  );
}

/* ---- Export --------------------------------------------------------------- */

function ExportSection({ roundId, token, onError }: { roundId: string; token: string; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const b = await api.bundle(roundId, token);
      const files: [string, string][] = [
        ['rubric.md', b.rubricMarkdown],
        ['golden-set.jsonl', b.goldenJsonl],
        ['judge-prompt.txt', b.judgeSystemPrompt],
        ['panel.json', JSON.stringify({ panel: b.panel, edits: b.panelEdits, pinnedModels: b.pinnedModels }, null, 2)],
        ['round.json', JSON.stringify({ cost: b.cost, falseSettleRate: b.falseSettleRate, pinnedModels: b.pinnedModels, hashes: b.hashes }, null, 2)],
        ['rerun.sh', b.rerunScript],
      ];
      for (const [name, content] of files) {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${b.project.slug}-${name}`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not build the bundle.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="band">
      <h2 style={{ marginBottom: 4 }}>Leave with files</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Rubric, golden set, judge prompt, panel config with its edit history, and a script that re-runs this eval.
        Framework agnostic; drop them in your repo. False settles never ship as golden.
      </p>
      <button onClick={download} disabled={busy}>
        {busy ? 'Building…' : 'Download the bundle'}
      </button>
    </section>
  );
}
