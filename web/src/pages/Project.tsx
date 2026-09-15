import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MAX_DRAFT_EXAMPLES } from '@shared/drafting';
import { DEFAULT_SCENARIOS } from '@shared/scenarios';
import type { DocumentKind, DraftConflict, DraftQuestion, RubricCriterion, Trace, VerdictLevel } from '@shared/types';
import { api, recallKey, type DraftResponse, type EndpointView, type ProjectView } from '../api';
import { ErrorBanner, Loading, Masthead, useAsync } from '../ui';

/** The stored source values are import formats; the owner reads provenance. */
function sourceLabel(source: string): string {
  if (source === 'scenario') return 'written for you';
  if (source === 'paste') return 'pasted in';
  if (source === 'seed') return 'demo';
  if (source === 'jsonl' || source === 'csv') return `imported (${source})`;
  return source;
}

export function ProjectPage() {
  const { slug } = useParams<{ slug: string }>();
  const token = recallKey(slug!) ?? '';
  const [error, setError] = useState<string | null>(null);
  // Setup hands over the description in navigation state; the Room writes
  // the scenarios on arrival so the slowest call never gates the page.
  const location = useLocation();
  const handedOver = (location.state as { writeScenarios?: string } | null)?.writeScenarios ?? null;

  const { data, error: loadError, loading, reload } = useAsync<ProjectView>(() => api.project(slug!, token), [slug, token]);
  const tracesQ = useAsync<{ traces: Trace[] }>(() => api.traces(slug!, token), [slug, token]);

  if (loading && !data) return <main className="sheet"><Loading what="project" /></main>;
  if (!data) {
    // The server's own message names the cause (bad key, missing database);
    // a generic line here would hide the one sentence that explains the fix.
    return <main className="sheet"><ErrorBanner message={loadError ?? 'Could not load this project.'} /></main>;
  }

  const link = `${window.location.origin}/p/${data.project.slug}?k=${data.project.token}`;
  const traces = tracesQ.data?.traces ?? [];
  // The masthead counts come from the project view, which is server-computed
  // and loaded before this renders; waiting on the separate traces fetch here
  // would flash "0 cases" over a project that has eight.
  const caseCount = tracesQ.data ? traces.length : data.traceCount;
  const seats = data.graders.filter((g) => g.kind === 'panelist');
  // A fresh project with a description and no round yet writes its cases on
  // arrival, whether you came from Setup or opened the link in a new tab.
  // The description is stored, so nothing depends on navigation state.
  const autoWrite = handedOver ?? (data.rounds.length === 0 && data.project.description.trim() ? data.project.description : null);
  const refresh = () => {
    tracesQ.reload();
    reload();
  };

  return (
    <main className="sheet sheet--wide">
      <Masthead
        crumbs={[{ label: 'Home', to: '/' }, data.project.name]}
        title={data.project.name}
        standfirst={`Standards v${data.rubric?.version ?? 1} · panel of ${seats.length} · ${caseCount} case${caseCount === 1 ? '' : 's'} · Round ${data.rounds.length + 1} next`}
        right={
          (data.rubric?.version ?? 1) > 1 ? (
            <a href={`/s/${data.project.slug}?k=${encodeURIComponent(data.project.token)}`}>Your Standards page</a>
          ) : undefined
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="keyline">
        <span>Your key link</span>
        <span className="url" title={link}>{link}</span>
        <button className="ghost tiny-btn" onClick={() => navigator.clipboard?.writeText(link)}>
          Copy
        </button>
      </div>

      <PanelSection slug={slug!} token={token} seats={seats} onChange={reload} onError={setError} />

      <TracesTab
        slug={slug!}
        token={token}
        traces={traces}
        loading={tracesQ.loading}
        autoWrite={autoWrite}
        onChange={refresh}
        onError={setError}
      />

      <RunSection slug={slug!} token={token} seats={seats} caseCount={caseCount} rounds={data.rounds} onError={setError} />

      {seats.length > 0 ? (
        <DataSection slug={slug!} token={token} />
      ) : null}

      <details className="deep">
        <summary>Your documents: the rules you already have written down</summary>
        <OperationsTab slug={slug!} token={token} onError={setError} />
      </details>

      <details className="deep">
        <summary>Your standards and the judge prompt</summary>
        <RubricTab view={data} slug={slug!} token={token} onChange={reload} onError={setError} />
      </details>

    </main>
  );
}

/* ---- The panel ----------------------------------------------------------- */

/**
 * The seats, shown before anything runs, every one editable. Opacity here
 * would be fatal: the user has to be able to say "that seat is not a real
 * stakeholder for me" and delete it, and every edit is captured as signal.
 */
function PanelSection({
  slug,
  token,
  seats,
  onChange,
  onError,
}: {
  slug: string;
  token: string;
  seats: ProjectView['graders'];
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', objective: '', failsFor: '', endpointId: '' });
  const [adding, setAdding] = useState(false);
  const [archetypes, setArchetypes] = useState<{ id: string; name: string; objective: string; failsFor: string }[]>([]);
  // The company's own endpoints, loaded beside the seats. Optional: a project
  // with none registered sees only the offer to add one.
  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [secrets, setSecrets] = useState<'env' | 'dev-default'>('env');
  const [endpointsTick, setEndpointsTick] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .endpoints(slug, token)
      .then((r) => {
        if (!live) return;
        setEndpoints(r.endpoints);
        setSecrets(r.secrets);
      })
      .catch(() => {
        /* the seats still render without the endpoint list */
      });
    return () => {
      live = false;
    };
  }, [slug, token, endpointsTick, seats]);
  const endpointOf = (family: string) => (family.startsWith('endpoint:') ? family.slice('endpoint:'.length) : '');

  async function generate() {
    setBusy('generate');
    try {
      await api.generatePanel(slug, token);
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not seat the panel.');
    } finally {
      setBusy(null);
    }
  }

  async function loadArchetypes() {
    setAdding(true);
    if (archetypes.length === 0) {
      try {
        setArchetypes((await api.archetypes(slug, token)).archetypes);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Could not load the library.');
      }
    }
  }

  if (seats.length === 0) {
    return (
      <div className="panel">
        <div className="between">
          <div>
            <h3 style={{ margin: 0 }}>Your panel</h3>
            <p className="note" style={{ margin: '6px 0 0' }}>
              Five perspectives with conflicting stakes, generated for your project, plus the literalist, who grades
              only what the rubric says. Where the literalist and everyone else split, your rubric is missing a
              sentence.
            </p>
          </div>
          <div className="shrink">
            <button onClick={generate} disabled={busy !== null}>
              {busy === 'generate' ? 'Seating…' : 'Seat the panel'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Seats on the company's own endpoints are counted apart from registry
  // seats: they are real by definition, and named by endpoint, not by family.
  const ownSeats = seats.filter((s) => endpointOf(s.family));
  const registrySeats = seats.filter((s) => !endpointOf(s.family));
  const simulatedPanel = registrySeats.every((s) => s.family === 'offline' || s.model === 'simulated');
  const registryFamilies = [...new Set(registrySeats.map((s) => s.family))];
  const ownNames = [...new Set(ownSeats.map((s) => endpoints.find((e) => e.id === endpointOf(s.family))?.name ?? 'a removed endpoint'))];
  const ownClause = ownSeats.length > 0 ? `${ownSeats.length} on your own model (${ownNames.join(', ')})` : '';

  return (
    <div className="panel">
      <div className="sec-title">
        <span className="no">1</span>
        <h2>The panel</h2>
      </div>
      <p className="sec-sub" style={{ margin: '2px 0 0' }}>
        Five perspectives with conflicting stakes, plus the literalist, who grades only what the rubric says.
        Where the literalist and everyone else split, your rubric is missing a sentence. Every seat is editable;
        every edit is signal.
      </p>

      <p className="tiny" style={{ margin: '10px 0 0' }}>
        {simulatedPanel && ownSeats.length === 0
          ? 'Every seat is simulated: no OPENROUTER_API_KEY is set, so this is the labeled simulation rather than judgment.'
          : simulatedPanel
            ? `${registrySeats.length} simulated seats (no OPENROUTER_API_KEY is set) and ${ownClause}. The simulated seats show the loop; your model’s verdicts are real.`
            : `${seats.length} seats across ${registryFamilies.length} model famil${registryFamilies.length === 1 ? 'y' : 'ies'}: ${registryFamilies.join(', ')}${ownClause ? `, plus ${ownClause}` : ''}. Different families is the point, because a panel that is one model six times agrees with itself for reasons that have nothing to do with your rubric.`}
        {!simulatedPanel && registryFamilies.length + ownNames.length < 3
          ? ' Fewer than three disjoint families: the run will refuse until the spread is real.'
          : ''}
      </p>

      <div style={{ marginTop: 14 }}>
        {seats.map((seat) => (
          <div key={seat.id} className="seat-row">
            {editing === seat.id ? (
              <div className="seat-edit">
                <div>
                  <label htmlFor={`seat-name-${seat.id}`}>Name</label>
                  <input
                    id={`seat-name-${seat.id}`}
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor={`seat-wants-${seat.id}`}>Wants</label>
                  <textarea
                    id={`seat-wants-${seat.id}`}
                    rows={2}
                    value={draft.objective}
                    onChange={(e) => setDraft((d) => ({ ...d, objective: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor={`seat-fails-${seat.id}`}>Fails</label>
                  <textarea
                    id={`seat-fails-${seat.id}`}
                    rows={2}
                    value={draft.failsFor}
                    onChange={(e) => setDraft((d) => ({ ...d, failsFor: e.target.value }))}
                  />
                </div>
                {endpoints.length > 0 ? (
                  <div>
                    <label htmlFor={`seat-runs-${seat.id}`}>Runs on</label>
                    <select
                      id={`seat-runs-${seat.id}`}
                      value={draft.endpointId}
                      onChange={(e) => setDraft((d) => ({ ...d, endpointId: e.target.value }))}
                    >
                      <option value="">A registry model ({endpointOf(seat.family) ? 'reassigned by position' : seat.model})</option>
                      {endpoints.map((e) => (
                        <option key={e.id} value={e.id}>
                          Your endpoint: {e.name} ({e.model})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="row">
                  <button
                    className="tiny-btn"
                    onClick={async () => {
                      try {
                        const { endpointId, ...fields } = draft;
                        await api.updateSeat(slug, token, seat.id, {
                          ...fields,
                          // Only a changed placement is sent; an unchanged one is not an edit.
                          ...(endpointId !== endpointOf(seat.family) ? { endpointId: endpointId || null } : {}),
                        });
                        setEditing(null);
                        onChange();
                      } catch (err) {
                        onError(err instanceof Error ? err.message : 'Could not save the seat.');
                      }
                    }}
                  >
                    Save
                  </button>
                  <button className="ghost tiny-btn" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span className="seat-name">
                  {seat.name}
                  {/* An edit is a record, and the record shows: the seat's
                      origin flips to 'user' when its stake is rewritten. */}
                  {seat.origin === 'user' ? <span className="seat-note" style={{ marginLeft: 10 }}>edited by you</span> : null}
                </span>
                <span className="seat-stake">
                  {seat.objective}
                  <span className="fails">{seat.failsFor}</span>
                  {seat.sameFamilyAsSut ? (
                    <span className="fails" style={{ color: 'var(--split)' }}>
                      Same family as your system: excluded from settled-case math by default, because judges favor their own family.
                    </span>
                  ) : null}
                </span>
                {/* The model, named. "Six judges" is only a claim until you
                    can see that they are six different models. */}
                <span
                  className="seat-model"
                  title={endpointOf(seat.family) ? `your endpoint: ${endpoints.find((e) => e.id === endpointOf(seat.family))?.name ?? 'removed'}` : `${seat.family} family`}
                >
                  {seat.model === 'simulated' || seat.family === 'offline' ? 'simulated' : seat.model}
                  {endpointOf(seat.family) ? <span className="seat-note" style={{ marginLeft: 8 }}>yours</span> : null}
                </span>
                <span className="seat-actions">
                <button
                  onClick={() => {
                    setEditing(seat.id);
                    setDraft({ name: seat.name, objective: seat.objective, failsFor: seat.failsFor, endpointId: endpointOf(seat.family) });
                  }}
                >
                  edit
                </button>
                <button
                  onClick={async () => {
                    if (
                      /literalist/i.test(seat.name) &&
                      !window.confirm(
                        'The literalist is the instrument: without it, persona splits cannot be tested for theater and the map loses the "would the rubric alone have decided this" reading. Remove it anyway?',
                      )
                    ) {
                      return;
                    }
                    try {
                      await api.deleteSeat(slug, token, seat.id);
                      onChange();
                    } catch (err) {
                      onError(err instanceof Error ? err.message : 'Could not remove the seat.');
                    }
                  }}
                >
                  remove
                </button>
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      {adding ? (
        <div style={{ marginTop: 12 }}>
          <span className="metric-k">From the library</span>
          <div className="pill-row" style={{ marginTop: 8 }}>
            {archetypes
              .filter((a) => !seats.some((s) => s.archetypeId === a.id))
              .map((a) => (
                <button
                  key={a.id}
                  className="pill"
                  title={`${a.objective} ${a.failsFor}`}
                  onClick={async () => {
                    try {
                      await api.addSeat(slug, token, { archetypeId: a.id });
                      onChange();
                    } catch (err) {
                      onError(err instanceof Error ? err.message : 'Could not add the seat.');
                    }
                  }}
                >
                  {a.name}
                </button>
              ))}
          </div>
          <button className="ghost tiny-btn" style={{ marginTop: 8 }} onClick={() => setAdding(false)}>
            done
          </button>
        </div>
      ) : (
        <p style={{ margin: '12px 0 0' }}>
          <button className="ghost tiny-btn" onClick={loadArchetypes}>
            add a seat
          </button>
        </p>
      )}

      <EndpointsBlock
        slug={slug}
        token={token}
        endpoints={endpoints}
        secrets={secrets}
        onChange={() => {
          setEndpointsTick((n) => n + 1);
          onChange();
        }}
        onError={onError}
      />
    </div>
  );
}

/* ---- Your own model in a seat ------------------------------------------- */

/**
 * The company's endpoints, listed under the panel: a fine-tune behind vLLM,
 * an internal gateway, a vendor API. Register, check with one real call,
 * then move a seat onto it from the seat's edit form. The key never comes
 * back from the server; only its last four characters do.
 */
function EndpointsBlock({
  slug,
  token,
  endpoints,
  secrets,
  onChange,
  onError,
}: {
  slug: string;
  token: string;
  endpoints: EndpointView[];
  secrets: 'env' | 'dev-default';
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', base_url: '', model: '', api_key: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; text: string }>>({});

  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  async function add() {
    setBusy('add');
    try {
      await api.addEndpoint(slug, token, {
        name: form.name.trim(),
        base_url: form.base_url.trim(),
        model: form.model.trim(),
        ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}),
      });
      setForm({ name: '', base_url: '', model: '', api_key: '' });
      setAdding(false);
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add the endpoint.');
    } finally {
      setBusy(null);
    }
  }

  async function check(id: string) {
    setBusy(`check:${id}`);
    try {
      const r = await api.checkEndpoint(slug, token, id);
      setChecks((c) => ({
        ...c,
        [id]: r.ok
          ? { ok: true, text: `answered in ${r.latency_ms ?? 0} ms` }
          : { ok: false, text: r.error ?? 'did not answer' },
      }));
    } catch (err) {
      setChecks((c) => ({ ...c, [id]: { ok: false, text: err instanceof Error ? err.message : 'did not answer' } }));
    } finally {
      setBusy(null);
    }
  }

  async function remove(e: EndpointView) {
    if (!window.confirm(`Remove ${e.name}? Rounds already graded keep its name in their pinned models.`)) return;
    setBusy(`remove:${e.id}`);
    try {
      await api.deleteEndpoint(slug, token, e.id);
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not remove the endpoint.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: 22 }}>
      <span className="metric-k">Your own model</span>
      <p className="tiny" style={{ margin: '6px 0 0' }}>
        Any OpenAI-compatible chat endpoint can take a seat: a fine-tune behind vLLM, an internal gateway, a vendor API.
        Its verdicts sit beside the panel’s, graded blind like every other seat, so you can see where your model already
        agrees with the standard and where it does not yet.
        {secrets === 'dev-default' ? ' Keys are sealed under the development secret on this server; set GR_SECRET in production.' : ''}
      </p>

      {endpoints.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {endpoints.map((e) => (
            <div key={e.id} className="seat-row">
              <span className="seat-name">
                {e.name}
                {e.seats.length > 0 ? <span className="seat-note" style={{ marginLeft: 10 }}>seats: {e.seats.join(', ')}</span> : null}
              </span>
              <span className="seat-stake">
                {host(e.baseUrl)}
                <span className="fails">
                  {e.hasKey ? `key ${e.keyHint}` : 'no key'}
                  {checks[e.id] ? (
                    <span style={{ marginLeft: 10, color: checks[e.id]!.ok ? 'inherit' : 'var(--split)' }}>{checks[e.id]!.text}</span>
                  ) : null}
                </span>
              </span>
              <span className="seat-model" title="the model name sent to your endpoint">{e.model}</span>
              <span className="seat-actions">
                <button onClick={() => check(e.id)} disabled={busy !== null}>
                  {busy === `check:${e.id}` ? 'calling…' : 'check'}
                </button>
                <button onClick={() => remove(e)} disabled={busy !== null}>
                  remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {adding ? (
        <div className="seat-edit" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="ep-name">Name</label>
            <input id="ep-name" placeholder="our support fine-tune" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="ep-url">Base URL</label>
            <input
              id="ep-url"
              placeholder="https://llm.example.com/v1"
              value={form.base_url}
              onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="ep-model">Model</label>
            <input id="ep-model" placeholder="acme-support-7b" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="ep-key">API key (optional)</label>
            <input
              id="ep-key"
              type="password"
              autoComplete="off"
              placeholder="sealed at rest, never shown again"
              value={form.api_key}
              onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
            />
          </div>
          <div className="row">
            <button className="tiny-btn" onClick={add} disabled={busy !== null || !form.name.trim() || !form.base_url.trim() || !form.model.trim()}>
              {busy === 'add' ? 'Adding…' : 'Add the endpoint'}
            </button>
            <button className="ghost tiny-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p style={{ margin: '10px 0 0' }}>
          <button className="ghost tiny-btn" onClick={() => setAdding(true)}>
            add your own endpoint
          </button>
        </p>
      )}
    </div>
  );
}

/* ---- Run the round, and the rounds already run --------------------------- */

/**
 * Section 3 is one button with its cost and time beside it; section 4 lists
 * the rounds that exist, each a link to its spread. The button lives here
 * rather than beside the panel because the order on the page is the order
 * of the work: seats, cases, then the round.
 */
function RunSection({
  slug,
  token,
  seats,
  caseCount,
  rounds,
  onError,
}: {
  slug: string;
  token: string;
  seats: ProjectView['graders'];
  caseCount: number;
  rounds: ProjectView['rounds'];
  onError: (m: string) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const simulatedPanel = seats.length > 0 && seats.every((s) => s.family === 'offline' || s.model === 'simulated');
  const roundEstimate = simulatedPanel ? '~2 min · free, simulated' : '~12 min · est. under $1';
  const next = rounds.length + 1;
  const blocked = seats.length < 3 ? 'Seat at least three judges first.' : caseCount < 2 ? 'Add at least two cases first.' : null;

  async function run() {
    setBusy(true);
    try {
      const res = await api.createPanelRound(slug, token);
      navigate(`/p/${slug}/round/${res.round.id}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start the round.');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <div className="between">
          <div>
            <div className="sec-title">
              <span className="no">3</span>
              <h2>Run round {next}</h2>
            </div>
            <p className="sec-sub" style={{ margin: '2px 0 0' }}>
              Every seat grades every case, blind. Verdicts land one seat at a time, and you can watch the panel
              disagree as it happens.
            </p>
            {blocked ? <p className="tiny" style={{ margin: '8px 0 0' }}>{blocked}</p> : null}
          </div>
          <div className="shrink" style={{ textAlign: 'right' }}>
            <button onClick={run} disabled={busy || blocked !== null}>
              {busy ? 'Starting…' : `Run round ${next}`}
            </button>
            <p className="mono tiny" style={{ margin: '6px 0 0' }}>{roundEstimate}</p>
          </div>
        </div>
      </div>

      {rounds.length > 0 ? (
        <div className="panel">
          <div className="sec-title">
            <span className="no">4</span>
            <h2>The spread</h2>
          </div>
          <p className="sec-sub" style={{ margin: '2px 0 0' }}>Each round, and where the panel split in it.</p>
          <ul className="plain" style={{ marginTop: 10 }}>
            {rounds.map((r) => (
              <li key={r.id} className="mono">
                <Link to={`/p/${slug}/round/${r.id}`}>{r.name}</Link> · {r.items} case{r.items === 1 ? '' : 's'} ·{' '}
                {r.status}
                {r.rubricVersion !== null ? ` · graded against Standards v${r.rubricVersion}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/* ---- Your data ------------------------------------------------------------ */

/**
 * Section 5: the company's judgment as rows. Three files, one provenance:
 * every row names its case, its judge, its model id, and the version of the
 * standard it was scored under. Counts come from the same builder that
 * writes the files, so the numbers on screen are the numbers in the file.
 */
function DataSection({ slug, token }: { slug: string; token: string }) {
  const { data, loading, reload } = useAsync(() => api.training(slug, token), [slug, token]);
  const href = (format: 'examples' | 'gold' | 'rewards' | 'pairs') => api.trainingUrl(slug, token, format);
  const c = data?.counts;
  return (
    <div className="panel">
      <div className="sec-title">
        <span className="no">5</span>
        <h2>Your data</h2>
      </div>
      <p className="sec-sub" style={{ margin: '2px 0 0' }}>
        The judgment this room has produced, as rows a model can learn from. Every row carries its case, its judge, the
        model that judged, and the version of the standard it was scored under.
      </p>
      {loading && !data ? (
        <Loading what="data" />
      ) : c && c.rounds === 0 && c.pairs === 0 ? (
        <p className="tiny" style={{ margin: '10px 0 0' }}>
          Nothing to export yet. The first finished round fills examples, gold and rewards; pairs you pose below fill pairs.jsonl as soon as the panel compares them.
        </p>
      ) : c ? (
        <div className="scroll-x" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Rows</th>
                <th scope="col">What it is</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">examples.jsonl</td>
                <td className="mono">{c.examples}</td>
                <td>Settled cases with the panel's verdict and rationale, chat-shaped. Cases the owner overruled are left out ({c.excluded_false_settles} excluded).</td>
                <td><a className="btn ghost tiny-btn" href={href('examples')}>download</a></td>
              </tr>
              <tr>
                <td className="mono">gold.jsonl</td>
                <td className="mono">{c.gold}</td>
                <td>Your own adjudications, with the panel's verdict beside each one.</td>
                <td><a className="btn ghost tiny-btn" href={href('gold')}>download</a></td>
              </tr>
              <tr>
                <td className="mono">rewards.jsonl</td>
                <td className="mono">{c.rewards}</td>
                <td>One row per judge per case, the verdict as a score on your standard's scale, for training a reward model against your standard rather than a generic one.</td>
                <td><a className="btn ghost tiny-btn" href={href('rewards')}>download</a></td>
              </tr>
              <tr>
                <td className="mono">pairs.jsonl</td>
                <td className="mono">{c.pairs}</td>
                <td>
                  Preference pairs: one prompt, a chosen answer and a rejected one, the rows preference training reads. {c.pairs_compared} compared by the panel below, {c.pairs_derived} derived from graded cases that share a prompt.
                </td>
                <td><a className="btn ghost tiny-btn" href={href('pairs')}>download</a></td>
              </tr>
            </tbody>
          </table>
          <p className="tiny" style={{ marginTop: 10 }}>
            From {c.rounds} finished round{c.rounds === 1 ? '' : 's'} and {c.cases} graded case{c.cases === 1 ? '' : 's'}. Grade more of your ten and the gold file grows; run another round and the examples do.
          </p>
        </div>
      ) : null}
      <PairsBlock slug={slug} token={token} onChange={reload} />
    </div>
  );
}

/* ---- Preference pairs ---------------------------------------------------- */

/**
 * One prompt, two answers, which one the standard prefers. The panel
 * compares both orders, so a seat whose choice flips when A and B swap
 * places is set aside as position bias. The owner's own pick sits beside
 * the panel's and outranks it in the export.
 */
function PairsBlock({ slug, token, onChange }: { slug: string; token: string; onChange: () => void }) {
  const { data, loading, reload } = useAsync(() => api.pairs(slug, token), [slug, token]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', prompt: '', a: '', b: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const pairs = data?.pairs ?? [];

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      reload();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  const label = (p: (typeof pairs)[number]) => {
    if (p.preferred) return `${p.preferred.toUpperCase()} preferred`;
    if (p.ownerChoice === 'tie') return 'you called it a tie';
    if (!p.gradedAt) return 'not compared yet';
    return p.outcome.counted < 2 ? 'no preference held' : 'the panel split';
  };

  return (
    <div style={{ marginTop: 22 }}>
      <span className="metric-k">Preference pairs</span>
      <p className="tiny" style={{ margin: '6px 0 0' }}>
        Pose two answers to one prompt and the panel says which one the standard prefers, in both orders, so a seat that
        prefers whatever comes first is caught rather than counted. Your own pick outranks the panel’s in the export.
      </p>
      {error ? <p className="tiny" style={{ color: 'var(--split)', margin: '8px 0 0' }}>{error}</p> : null}

      {loading && !data ? <Loading what="pairs" /> : null}
      {pairs.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {pairs.map((p) => (
            <div key={p.id} className="seat-row">
              <span className="seat-name">
                {p.title}
                <span className="seat-note" style={{ marginLeft: 10 }}>{label(p)}</span>
              </span>
              <span className="seat-stake">
                {p.gradedAt ? (
                  <>
                    {p.votes.map((v) => (
                      <span key={v.seatId} className="vote-chip" title={v.reason} style={v.stable === false ? { color: 'var(--amber)' } : undefined}>
                        {v.seatName}: {v.choice.toUpperCase()}
                        {v.stable === false ? ' (flipped)' : ''}
                      </span>
                    ))}
                    <span className="fails">
                      {p.outcome.winner
                        ? `Panel prefers ${p.outcome.winner.toUpperCase()} with ${Math.round(p.outcome.support * 100)}% of counted weight`
                        : 'The panel did not settle it'}
                      {p.outcome.flipped ? `; ${p.outcome.flipped} vote${p.outcome.flipped === 1 ? '' : 's'} flipped under the swap` : ''}
                      {p.standards_version ? ` · Standards v${p.standards_version}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="fails">Compare to see every seat’s choice and reason.</span>
                )}
                {open === p.id ? (
                  <div className="tiny" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    <b>Prompt.</b> {p.prompt}
                    {'\n\n'}
                    <b>A.</b> {p.a}
                    {'\n\n'}
                    <b>B.</b> {p.b}
                  </div>
                ) : null}
              </span>
              <span className="seat-model">{p.ownerChoice ? `you: ${p.ownerChoice.toUpperCase()}` : ''}</span>
              <span className="seat-actions">
                <button onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'hide' : 'read'}</button>
                <button disabled={busy !== null} onClick={() => run(`grade:${p.id}`, () => api.gradePair(slug, token, p.id))}>
                  {busy === `grade:${p.id}` ? 'comparing…' : p.gradedAt ? 'compare again' : 'compare'}
                </button>
                {(['a', 'b', 'tie'] as const).map((c) => (
                  <button
                    key={c}
                    disabled={busy !== null}
                    title={`Your call: ${c === 'tie' ? 'a tie' : c.toUpperCase()}`}
                    style={p.ownerChoice === c ? { fontWeight: 600 } : undefined}
                    onClick={() => run(`pick:${p.id}`, () => api.setPairVerdict(slug, token, p.id, { choice: p.ownerChoice === c ? null : c }))}
                  >
                    {c === 'tie' ? 'tie' : c.toUpperCase()}
                  </button>
                ))}
                <button disabled={busy !== null} onClick={() => run(`rm:${p.id}`, () => api.deletePair(slug, token, p.id))}>
                  remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {adding ? (
        <div className="seat-edit" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="pair-title">Title</label>
            <input id="pair-title" placeholder="Refund over the cap, two ways" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pair-prompt">Prompt</label>
            <textarea id="pair-prompt" rows={3} placeholder="USER: I want a refund on my $90 order." value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pair-a">Answer A</label>
            <textarea id="pair-a" rows={3} value={form.a} onChange={(e) => setForm((f) => ({ ...f, a: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pair-b">Answer B</label>
            <textarea id="pair-b" rows={3} value={form.b} onChange={(e) => setForm((f) => ({ ...f, b: e.target.value }))} />
          </div>
          <div className="row">
            <button
              className="tiny-btn"
              disabled={busy !== null || !form.title.trim() || !form.prompt.trim() || !form.a.trim() || !form.b.trim()}
              onClick={() =>
                run('add', async () => {
                  await api.addPair(slug, token, { title: form.title.trim(), prompt: form.prompt.trim(), a: form.a.trim(), b: form.b.trim() });
                  setForm({ title: '', prompt: '', a: '', b: '' });
                  setAdding(false);
                })
              }
            >
              {busy === 'add' ? 'Adding…' : 'Add the pair'}
            </button>
            <button className="ghost tiny-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p style={{ margin: '10px 0 0' }}>
          <button className="ghost tiny-btn" onClick={() => setAdding(true)}>
            add a pair
          </button>
        </p>
      )}
    </div>
  );
}

/* ---- Operating documents ------------------------------------------------ */

const DOC_KINDS: { id: DocumentKind; label: string; hint: string }[] = [
  { id: 'policy', label: 'Policy', hint: 'The rules. Refund limits, escalation thresholds, what is never allowed.' },
  { id: 'sop', label: 'Procedure', hint: 'How the work is done, step by step.' },
  { id: 'decision', label: 'Decision record', hint: 'The thread or memo where someone settled a hard case.' },
  { id: 'other', label: 'Other', hint: 'Anything else that encodes how you decide.' },
];

/**
 * Where a team puts what they have already written down.
 *
 * These are read, never graded. They are kept apart from traces on purpose: a
 * policy in a grading queue would be nonsense, and the separation is enforced
 * by the schema rather than by remembering.
 */
function OperationsTab({ slug, token, onError }: { slug: string; token: string; onError: (m: string) => void }) {
  const { data, loading, reload } = useAsync(() => api.documents(slug, token), [slug, token]);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocumentKind>('policy');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const documents = data?.documents ?? [];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setBusy(true);
    try {
      await api.addDocuments(slug, token, [{ title: title.trim() || 'Untitled document', kind, content }]);
      setTitle('');
      setContent('');
      reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save that document.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="col">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>What you already have written down</h3>
          <p className="tiny" style={{ marginTop: 0 }}>
            Your refund policy, your escalation rules, the thread where someone settled a hard case. These become the
            standards. Each criterion quotes the sentence it came from, and anything that contradicts itself or cannot be
            checked from a conversation gets handed back rather than quietly tidied up.
          </p>

          <form onSubmit={add}>
            <div className="row">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="doc-title">Title</label>
                <input
                  id="doc-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Refund policy, Q3"
                />
              </div>
              <div className="field shrink" style={{ marginBottom: 0, width: 200 }}>
                <label htmlFor="doc-kind">Kind</label>
                <select id="doc-kind" value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
                  {DOC_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="doc-body">Paste it in</label>
              <textarea
                id="doc-body"
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={DOC_KINDS.find((k) => k.id === kind)?.hint}
              />
            </div>
            <button type="submit" disabled={busy || !content.trim()}>
              {busy ? 'Saving…' : 'Add document'}
            </button>
          </form>
        </div>

        {loading && !data ? (
          <Loading what="documents" />
        ) : documents.length === 0 ? (
          <div className="empty">
            Nothing yet. Most teams already have this written somewhere. Start with whatever governs the decisions your
            agent is making.
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <caption>{documents.length} document{documents.length === 1 ? '' : 's'}</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Length</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td className="case">{doc.title}</td>
                    <td>{DOC_KINDS.find((k) => k.id === doc.kind)?.label ?? doc.kind}</td>
                    <td>{doc.content.length.toLocaleString()} chars</td>
                    <td>
                      <button
                        className="ghost tiny-btn"
                        onClick={async () => {
                          try {
                            await api.deleteDocument(slug, token, doc.id);
                            reload();
                          } catch (err) {
                            onError(err instanceof Error ? err.message : 'Could not remove that document.');
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

/* ---- Scenario writing ---------------------------------------------------- */

/**
 * The step that removes the blank page. Most teams do not have transcripts
 * lying around; they have a description of what their AI does. This writes the
 * situations the poll will ask about — clear cases, boundary cases, and the
 * cases the written rules never imagined.
 */
function ScenarioWriter({
  slug,
  token,
  onDone,
  onError,
}: {
  slug: string;
  token: string;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function write(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await api.generateScenarios(slug, token, { description });
      setResult(
        res.provider.real
          ? `${res.scenarios.length} scenarios written from your description and documents. They are in the list below. Edit or remove any before you poll.`
          : `${res.scenarios.length} starter scenarios added. No OPENROUTER_API_KEY is set, so these are the situations every operation meets rather than ones written from your documents.`,
      );
      setDescription('');
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not write scenarios.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Write the scenarios for me</h3>
      <p className="tiny" style={{ marginTop: 0 }}>
        Describe what your AI is supposed to do. You get concrete situations to make calls on: the clear cases,
        the boundary cases, and the ones your documents never imagined. None of them contain their own answer.
      </p>
      <form onSubmit={write}>
        <div className="field">
          <label htmlFor="scenario-desc">What is your AI supposed to do?</label>
          <textarea
            id="scenario-desc"
            rows={3}
            value={description}
            placeholder="A support agent that answers billing questions and can issue refunds up to $50 without approval."
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy || description.trim().length < 10}>
          {busy ? 'Writing…' : 'Write scenarios'}
        </button>
        {result ? <span className="tiny" style={{ marginLeft: 12 }}>{result}</span> : null}
      </form>
    </div>
  );
}

/* ---- Scenarios, answered in place ---------------------------------------- */

/**
 * The heart of the solo flow. Each scenario is a card: read it, say what
 * should happen, say why. The verdict saves on click; the reason saves when
 * you leave the field. Answered cards are test cases already.
 */
function TracesTab({
  slug,
  token,
  traces,
  loading,
  autoWrite,
  onChange,
  onError,
}: {
  slug: string;
  token: string;
  traces: Trace[];
  loading: boolean;
  /** The description from Setup, when the Room should write the cases on arrival. */
  autoWrite: string | null;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const [format, setFormat] = useState<'paste' | 'jsonl' | 'csv'>('paste');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);

  // The arrival write: placeholders while it runs, the error in place with a
  // retry if it fails, never a spinner with nothing to say.
  const [arrival, setArrival] = useState<{ status: 'idle' | 'writing' | 'failed'; message: string }>({ status: 'idle', message: '' });
  const startedRef = useRef(false);

  async function writeOnArrival() {
    if (!autoWrite) return;
    setArrival({ status: 'writing', message: '' });
    try {
      await api.generateScenarios(slug, token, { description: autoWrite });
      setArrival({ status: 'idle', message: '' });
      onChange();
    } catch (err) {
      setArrival({ status: 'failed', message: err instanceof Error ? err.message : 'The scenarios could not be written.' });
    }
  }

  useEffect(() => {
    if (!autoWrite || loading || traces.length > 0 || startedRef.current) return;
    // Once per project per browser session: deleting every case on purpose
    // must not summon twelve more on the next reload.
    const key = `grading-room:autowrote:${slug}`;
    let already = false;
    try {
      already = sessionStorage.getItem(key) === '1';
      sessionStorage.setItem(key, '1');
    } catch {
      // Storage blocked: write once per mount, which is the same promise.
    }
    startedRef.current = true;
    if (!already) void writeOnArrival();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoWrite, loading, traces.length]);

  const stubScenarios = traces.filter((t) => t.meta?.generated === true && t.meta?.real === false).length;

  async function importTraces(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await api.importTraces(slug, token, format, body);
      setResult(
        `Added ${res.traces.length} scenario${res.traces.length === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} that did not parse` : ''}.`,
      );
      setBody('');
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not import those conversations.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="col">
        <div className="between">
          <div>
            <div className="sec-title">
              <span className="no">2</span>
              <h2>The cases</h2>
            </div>
            <p className="sec-sub" style={{ margin: '2px 0 0' }}>
              The clear cases, the boundary cases, and the ones your documents never imagined. Your own transcript
              is the one that proves the product on your actual problem.
            </p>
          </div>
          <div className="shrink">
            <button type="button" className="ghost" onClick={() => setPasting((p) => !p)} aria-expanded={pasting}>
              Paste a real transcript
            </button>
          </div>
        </div>
        {stubScenarios > 0 ? (
          <div className="warn">
            <span className="metric-k">Placeholder scenarios</span>
            <p style={{ margin: '6px 0 0' }}>
              {stubScenarios} of these scenarios are generic starters, not written from your description, because
              the server has no OPENROUTER_API_KEY. Set one in your deployment, then use the writer below to replace
              them with scenarios about your actual operation.
            </p>
          </div>
        ) : null}

        {pasting ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <h3 style={{ marginTop: 0 }}>Paste a real transcript</h3>
            <p className="tiny" style={{ marginTop: 0 }}>
              Transcripts of your AI at work make the best cases. You judge what actually happened instead of a
              written situation.
            </p>
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
                    ? 'One conversation per block, separated by a line of three dashes'
                    : format === 'jsonl'
                      ? 'One JSON object per line, or a JSON array'
                      : 'CSV with a header row'}
                </label>
                <textarea
                  id="import-body"
                  rows={8}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={
                    format === 'paste'
                      ? 'Refund outside policy window\nUSER: …\nASSISTANT: …\n---\nNext conversation\n…'
                      : format === 'jsonl'
                        ? '{"name": "Refund case", "output": "ASSISTANT: …"}'
                        : 'name,output\nRefund case,"ASSISTANT: …"'
                  }
                />
                <p className="tiny" style={{ marginTop: 6 }}>
                  Field names are matched loosely: title, name, id, case for the label; content, transcript, output,
                  completion, messages for the body. Everything else is kept as metadata.
                </p>
              </div>
              <button type="submit" disabled={busy || !body.trim()}>
                {busy ? 'Parsing…' : 'Import'}
              </button>
              <button type="button" className="ghost" style={{ marginLeft: 8 }} onClick={() => setPasting(false)}>
                Close
              </button>
              {result ? <span className="tiny" style={{ marginLeft: 12 }}>{result}</span> : null}
            </form>
          </div>
        ) : null}

        {arrival.status === 'writing' ? (
          <div style={{ marginTop: 14 }}>
            <p className="progress-line" style={{ marginTop: 0 }}>
              Writing {DEFAULT_SCENARIOS} scenarios for your product. They land here as a list; the first ones usually
              take under a minute.
            </p>
            {Array.from({ length: DEFAULT_SCENARIOS }, (_, i) => (
              <div className="case-row" key={i} style={{ borderTopStyle: 'dashed' }}>
                <span className="no">{String(i + 1).padStart(2, '0')}</span>
                <p className="probe" style={{ fontStyle: 'italic' }}>being written</p>
              </div>
            ))}
          </div>
        ) : arrival.status === 'failed' ? (
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>The scenarios could not be written.</h3>
            <p className="sec-sub">{arrival.message} Your panel is unaffected.</p>
            <button onClick={() => void writeOnArrival()}>Try the scenarios again</button>
          </div>
        ) : loading && traces.length === 0 ? (
          <Loading what="scenarios" />
        ) : traces.length === 0 ? (
          <div className="empty">No cases yet. Describe your AI below and they will be written for you, or paste a transcript.</div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {traces.map((trace, i) => {
              const probe = typeof trace.meta?.probe === 'string' ? trace.meta.probe : '';
              return (
                <div className="case-row" key={trace.id}>
                  <span className="no">{String(i + 1).padStart(2, '0')}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="case-head">
                      <h3>{trace.title}</h3>
                      <span className="tiny shrink">{sourceLabel(trace.source)}</span>
                    </div>
                    {probe ? <p className="probe">probes: {probe}</p> : null}
                    <div className="body">{trace.content}</div>
                    <div className="case-actions">
                      <button
                        onClick={async () => {
                          try {
                            await api.deleteTrace(slug, token, trace.id);
                            onChange();
                          } catch (err) {
                            onError(err instanceof Error ? err.message : 'Could not remove that scenario.');
                          }
                        }}
                      >
                        remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <ScenarioWriter slug={slug} token={token} onDone={onChange} onError={onError} />
      </div>
    </section>
  );
}

/* ---- Rubric ------------------------------------------------------------- */

/**
 * Drafting a first rubric from conversations already in the project.
 *
 * The draft is shown in full before it can be accepted, and accepting it only
 * fills the form below — a rubric nobody read is not a rubric, so the save is
 * always a separate, deliberate act.
 */
function DraftPanel({
  slug,
  token,
  traceCount,
  startOpen,
  onAccept,
  onError,
}: {
  slug: string;
  token: string;
  traceCount: number;
  startOpen: boolean;
  onAccept: (draft: DraftResponse) => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [pickedDocs, setPickedDocs] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftResponse | null>(null);

  const traces = useAsync(() => (open ? api.traces(slug, token) : Promise.resolve({ traces: [] })), [slug, token, open]);
  const docs = useAsync(
    () => (open ? api.documents(slug, token) : Promise.resolve({ documents: [] })),
    [slug, token, open],
  );
  const available = traces.data?.traces ?? [];
  const availableDocs = docs.data?.documents ?? [];
  // Documents are the point, so they are all selected by default.
  const selectedDocs = pickedDocs ?? new Set(availableDocs.map((d) => d.id));

  // Pre-select enough to see a pattern without making the first click a chore.
  const selected = picked ?? new Set(available.slice(0, Math.min(6, available.length)).map((t) => t.id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  function toggleDoc(id: string) {
    const next = new Set(selectedDocs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPickedDocs(next);
  }

  async function requestDraft(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setDraft(null);
    try {
      setDraft(
        await api.draftRubric(slug, token, {
          description,
          documentIds: [...selectedDocs],
          traceIds: [...selected],
        }),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not draft your standards.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="panel">
        <div className="between">
          <div>
            <h3 style={{ margin: 0 }}>Draft your standards from what you have</h3>
            <p className="tiny" style={{ margin: '4px 0 0' }}>
              Useful when you are starting over, or when the standards no longer match what your AI does.
            </p>
          </div>
          <div className="shrink">
            <button type="button" className="ghost" onClick={() => setOpen(true)}>
              Draft
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Draft your standards from what you have</h3>

      {traceCount === 0 && availableDocs.length === 0 ? (
        <div className="empty">
          Add what you have already written down under &ldquo;Your documents&rdquo; below, or some scenarios
          first. Standards drafted from nothing are just a guess with formatting.
        </div>
      ) : (
        <form onSubmit={requestDraft}>
          <div className="field">
            <label htmlFor="draft-description">What is your agent supposed to do?</label>
            <textarea
              id="draft-description"
              rows={3}
              value={description}
              placeholder="A support agent that answers billing questions and can issue refunds up to $50 without approval."
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="tiny" style={{ margin: 0 }}>
              A sentence or two. Include the limits it is supposed to respect. Those are where graders argue.
            </p>
          </div>

          {availableDocs.length > 0 ? (
            <div className="field">
              <label>Which of your operating documents to read</label>
              <div className="pill-row">
                {availableDocs.map((doc) => (
                  <button
                    type="button"
                    key={doc.id}
                    className={`pill${selectedDocs.has(doc.id) ? ' on' : ''}`}
                    onClick={() => toggleDoc(doc.id)}
                    aria-pressed={selectedDocs.has(doc.id)}
                  >
                    {doc.title}
                  </button>
                ))}
              </div>
              <p className="tiny" style={{ margin: 0 }}>
                Every criterion will quote the sentence it came from. Anything that contradicts itself, or that nobody
                could check from a conversation, comes back as a conflict instead of a rule.
              </p>
            </div>
          ) : null}

          <div className="field">
            <label>Which conversations to read{availableDocs.length > 0 ? ' as well' : ''}</label>
            {traces.loading ? (
              <Loading what="conversations" />
            ) : (
              <div className="pill-row">
                {available.slice(0, MAX_DRAFT_EXAMPLES).map((trace) => (
                  <button
                    type="button"
                    key={trace.id}
                    className={`pill${selected.has(trace.id) ? ' on' : ''}`}
                    onClick={() => toggle(trace.id)}
                    aria-pressed={selected.has(trace.id)}
                  >
                    {trace.title}
                  </button>
                ))}
              </div>
            )}
            <p className="tiny" style={{ margin: 0 }}>
              {available.length > MAX_DRAFT_EXAMPLES
                ? `Showing the first ${MAX_DRAFT_EXAMPLES} of ${available.length}. `
                : ''}
              Pick a spread: the ones that went well, the ones that did not, and the ones you argued about.
            </p>
          </div>

          <button
            type="submit"
            disabled={busy || (selected.size === 0 && selectedDocs.size === 0) || description.trim().length < 10}
          >
            {busy
              ? 'Reading…'
              : `Draft from ${[
                  selectedDocs.size > 0 ? `${selectedDocs.size} document${selectedDocs.size === 1 ? '' : 's'}` : '',
                  selected.size > 0 ? `${selected.size} conversation${selected.size === 1 ? '' : 's'}` : '',
                ]
                  .filter(Boolean)
                  .join(' and ')}`}
          </button>
          <button type="button" className="ghost" style={{ marginLeft: 8 }} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      )}

      {draft ? (
        <div style={{ marginTop: 20 }}>
          {!draft.provider.real ? (
            <div className="warn">
              <span className="metric-k">No model configured</span>
              <p style={{ margin: '6px 0 0' }}>
                Nothing read your conversations, so there are no criteria below. Inventing some would give you standards
                that look drafted from your data and are not. What you get instead is a blank three-point scale and the
                questions teams argue about first. Set OPENROUTER_API_KEY to draft from your own material.
              </p>
            </div>
          ) : null}

          <h4>{draft.draft.name}</h4>
          {draft.draft.preamble ? <p>{draft.draft.preamble}</p> : null}

          <div className="pill-row">
            {[...draft.draft.scale]
              .sort((a, b) => b.rank - a.rank)
              .map((level) => (
                <span key={level.id} className="pill static">
                  {level.label}
                </span>
              ))}
          </div>

          {draft.draft.criteria.length > 0 ? (
            <ul className="plain">
              {draft.draft.criteria.map((c) => (
                <li key={c.id} style={{ marginBottom: 12 }}>
                  <strong>{c.title}</strong>: {c.body}
                  {c.source ? (
                    <div className="quote">
                      “{c.source.quote}”
                      <span className="quote-src">{c.source.document}</span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {draft.draft.conflicts.length > 0 ? (
            <>
              <h4>What could not become a rule</h4>
              <p className="tiny" style={{ marginTop: 0 }}>
                These are left exactly as found. Reconciling them here would hand you tidy standards built on a decision
                nobody in your team actually made.
              </p>
              <ul className="plain">
                {draft.draft.conflicts.map((c) => (
                  <li key={c.id} style={{ marginBottom: 10 }}>
                    <span className={`verdict ${c.kind === 'contradiction' ? 'v-fail' : 'v-mid'}`}>
                      {c.kind === 'contradiction' ? 'contradiction' : 'not checkable'}
                    </span>{' '}
                    <strong>{c.statement}</strong>
                    {c.detail ? (
                      <div className="tiny" style={{ marginTop: 3 }}>
                        {c.detail}
                        {c.documents.length > 0 ? ` · ${c.documents.join(', ')}` : ''}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h4>What it does not answer</h4>
          <p className="tiny" style={{ marginTop: 0 }}>
            {draft.provider.real
              ? 'These are the cases your conversations left open. They are where your first round will split.'
              : 'These are not from your conversations. They are the questions most teams turn out to disagree about.'}
          </p>
          <ul className="plain">
            {draft.draft.openQuestions.map((q) => (
              <li key={q.id} style={{ marginBottom: 8 }}>
                <strong>{q.question}</strong>
                {q.why ? (
                  <div className="tiny" style={{ marginTop: 2 }}>
                    {q.why}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => {
              onAccept(draft);
              setDraft(null);
              setOpen(false);
            }}
          >
            Use this draft
          </button>
          <button type="button" className="ghost" style={{ marginLeft: 8 }} onClick={() => setDraft(null)}>
            Discard
          </button>
          <p className="tiny" style={{ marginBottom: 0 }}>
            Using it fills the form below. Nothing is saved until you press Save standards.
          </p>
        </div>
      ) : null}
    </div>
  );
}

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
  const [scale, setScale] = useState<VerdictLevel[]>(rubric?.scale ?? []);
  const [questions, setQuestions] = useState<DraftQuestion[]>(rubric?.openQuestions ?? []);
  const [conflicts, setConflicts] = useState<DraftConflict[]>(rubric?.conflicts ?? []);
  const [draftedFrom, setDraftedFrom] = useState(rubric?.draftedFrom ?? null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const history = useAsync(() => api.rubrics(slug, token), [slug, token, rubric?.id]);

  if (!rubric) return <div className="empty">This project has no standards yet.</div>;

  /** Accepting a draft only fills the form. Nothing is stored until Save. */
  function applyDraft(draft: DraftResponse) {
    setName(draft.draft.name);
    setPreamble(draft.draft.preamble);
    setCriteria(draft.draft.criteria);
    setScale(draft.draft.scale);
    setQuestions(draft.draft.openQuestions);
    setConflicts(draft.draft.conflicts);
    setDraftedFrom(draft.draftedFrom);
    setSaved(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(null);
    try {
      const res = await api.saveRubric(slug, token, {
        name,
        preamble,
        criteria,
        scale,
        openQuestions: questions,
        conflicts,
        draftedFrom,
      });
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
    <section>
      <div className="col">
        <DraftPanel
          slug={slug}
          token={token}
          traceCount={view.traceCount}
          startOpen={rubric.criteria.length === 0 && rubric.clauses.length === 0}
          onAccept={applyDraft}
          onError={onError}
        />

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

          {draftedFrom ? (
            <div className="warn">
              <span className="metric-k">Drafted, not calibrated</span>
              <p style={{ margin: '6px 0 0' }}>
                {draftedFrom.provider !== 'offline'
                  ? `A model wrote this from ${draftedFrom.exampleCount} of your conversations.`
                  : 'This is a starting skeleton, not a draft from your conversations.'}{' '}
                Nobody has yet checked whether two people apply it the same way. Run a round before trusting any number
                that comes out of it.
                {draftedFrom.truncated ? ' Some conversations were trimmed to fit.' : ''}
              </p>
            </div>
          ) : null}

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
                {[...scale]
                  .sort((a, b) => b.rank - a.rank)
                  .map((level) => (
                    <span key={level.id} className="pill static">
                      {level.label}
                    </span>
                  ))}
                <span className="pill static muted">abstain</span>
              </div>
              {scale.map((l) => l.id).join('|') !== rubric.scale.map((l) => l.id).join('|') ? (
                <p className="tiny" style={{ margin: 0 }}>
                  This scale differs from the saved one. Saving keeps every closed round on the scale it was graded
                  against. An edit forks a new version rather than rewriting the old one.
                </p>
              ) : null}
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

            {conflicts.length > 0 ? (
              <div className="field">
                <label>Rules that could not become tests</label>
                <p className="tiny" style={{ marginTop: 0 }}>
                  Straight from your own documents, unreconciled. Settle each one where it lives, in the policy, then
                  strike it here and redraft.
                </p>
                {conflicts.map((c, i) => (
                  <div key={c.id} className="panel" style={{ marginBottom: 10, padding: '14px 16px' }}>
                    <div className="between">
                      <span className={`verdict ${c.kind === 'contradiction' ? 'v-fail' : 'v-mid'}`}>
                        {c.kind === 'contradiction' ? 'contradiction' : 'not checkable'}
                      </span>
                      <button
                        type="button"
                        className="ghost tiny-btn"
                        onClick={() => setConflicts(conflicts.filter((_, j) => j !== i))}
                      >
                        settled
                      </button>
                    </div>
                    <p style={{ margin: '8px 0 0' }}>{c.statement}</p>
                    {c.detail ? (
                      <p className="tiny" style={{ margin: '4px 0 0' }}>
                        {c.detail}
                        {c.documents.length > 0 ? ` · ${c.documents.join(', ')}` : ''}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {questions.length > 0 ? (
              <div className="field">
                <label>What this rubric does not answer yet</label>
                <p className="tiny" style={{ marginTop: 0 }}>
                  Expect your first disagreements here. Strike one once a round has settled it and the answer is written
                  into a criterion or a clause.
                </p>
                {questions.map((q, i) => (
                  <div key={q.id} className="panel" style={{ marginBottom: 10, padding: '14px 16px' }}>
                    <div className="row">
                      <input
                        value={q.question}
                        onChange={(e) =>
                          setQuestions(questions.map((x, j) => (i === j ? { ...x, question: e.target.value } : x)))
                        }
                        aria-label="Open question"
                      />
                      <div className="shrink">
                        <button
                          type="button"
                          className="ghost tiny-btn"
                          onClick={() => setQuestions(questions.filter((_, j) => j !== i))}
                        >
                          answered
                        </button>
                      </div>
                    </div>
                    {q.why ? (
                      <p className="tiny" style={{ margin: '8px 0 0' }}>
                        {q.why}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {rubric.clauses.length > 0 ? (
              <div className="field">
                <label>Clauses from resolved disagreements</label>
                <ul className="plain">
                  {rubric.clauses.map((clause) => (
                    <li key={clause.id}>{clause.text}</li>
                  ))}
                </ul>
                <p className="tiny" style={{ margin: 0 }}>
                  These are written when a disagreement is settled, not here. Each one exists because two people
                  voted differently on a real scenario.
                </p>
              </div>
            ) : null}

            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save standards'}
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
