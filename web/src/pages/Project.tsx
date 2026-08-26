import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MAX_DRAFT_EXAMPLES } from '@shared/drafting';
import type { DocumentKind, DraftConflict, DraftQuestion, RubricCriterion, Trace, VerdictLevel } from '@shared/types';
import { api, recallKey, type DraftResponse, type ProjectView } from '../api';
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

      <div className="panel">
        <div className="between" style={{ alignItems: 'center' }}>
          <div style={{ flex: '1 1 340px', minWidth: 0 }}>
            <p style={{ margin: '0 0 6px', fontWeight: 550 }}>This link is your key. Keep it.</p>
            <div className="link-box">{link}</div>
          </div>
          <div className="shrink">
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(link)}>
              Copy link
            </button>
          </div>
        </div>
      </div>

      <PanelSection slug={slug!} token={token} seats={seats} caseCount={caseCount} onChange={reload} onError={setError} />

      <TracesTab
        slug={slug!}
        token={token}
        traces={traces}
        loading={tracesQ.loading}
        onChange={refresh}
        onError={setError}
      />

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
  caseCount,
  onChange,
  onError,
}: {
  slug: string;
  token: string;
  seats: ProjectView['graders'];
  caseCount: number;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', objective: '', failsFor: '' });
  const [adding, setAdding] = useState(false);
  const [archetypes, setArchetypes] = useState<{ id: string; name: string; objective: string; failsFor: string }[]>([]);
  const navigate = useNavigate();

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

  async function run() {
    setBusy('run');
    try {
      const res = await api.createPanelRound(slug, token);
      navigate(`/p/${slug}/round/${res.round.id}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start the round.');
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

  const simulatedPanel = seats.every((s) => s.family === 'offline' || s.model === 'simulated');
  const roundEstimate = simulatedPanel ? '~2 min · free, simulated' : '~12 min · est. under $1';

  return (
    <div className="panel">
      <div className="between">
        <div>
          <div className="sec-title">
            <span className="no">1</span>
            <h2>The panel</h2>
          </div>
          <p className="sec-sub" style={{ margin: '2px 0 0' }}>
            Five perspectives with conflicting stakes, plus the literalist, who grades only what the rubric says.
            Where the literalist and everyone else split, your rubric is missing a sentence. Every seat is editable;
            every edit is signal.
          </p>
        </div>
        <div className="shrink" style={{ textAlign: 'right' }}>
          <button onClick={run} disabled={busy !== null || caseCount < 2 || seats.length < 3}>
            {busy === 'run' ? 'Starting…' : 'Run the round'}
          </button>
          <p className="mono tiny" style={{ margin: '6px 0 0' }}>{roundEstimate}</p>
        </div>
      </div>

      <p className="tiny" style={{ margin: '10px 0 0' }}>
        {simulatedPanel
          ? 'Every seat is simulated: no OPENROUTER_API_KEY is set, so this is the labeled simulation rather than judgment.'
          : `${seats.length} seats across ${new Set(seats.map((s) => s.family)).size} model families: ${[...new Set(seats.map((s) => s.family))].join(', ')}. Different families is the point, because a panel that is one model six times agrees with itself for reasons that have nothing to do with your rubric.`}
        {new Set(seats.map((s) => s.family)).size < 3 && !simulatedPanel
          ? ' Fewer than three disjoint families: the run will refuse until the spread is real.'
          : ''}
      </p>

      <div style={{ marginTop: 14 }}>
        {seats.map((seat) => (
          <div key={seat.id} className="seat-row" style={{ display: 'block' }}>
            {editing === seat.id ? (
              <>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  aria-label="Seat name"
                  style={{ marginBottom: 6, width: '100%' }}
                />
                <textarea
                  rows={2}
                  value={draft.objective}
                  onChange={(e) => setDraft((d) => ({ ...d, objective: e.target.value }))}
                  aria-label="What this seat optimizes for"
                  style={{ marginBottom: 6, width: '100%' }}
                />
                <textarea
                  rows={2}
                  value={draft.failsFor}
                  onChange={(e) => setDraft((d) => ({ ...d, failsFor: e.target.value }))}
                  aria-label="What it fails an answer for"
                  style={{ marginBottom: 6, width: '100%' }}
                />
                <button
                  className="tiny-btn"
                  onClick={async () => {
                    try {
                      await api.updateSeat(slug, token, seat.id, draft);
                      setEditing(null);
                      onChange();
                    } catch (err) {
                      onError(err instanceof Error ? err.message : 'Could not save the seat.');
                    }
                  }}
                >
                  Save
                </button>{' '}
                <button className="ghost tiny-btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <div className="between">
                  <strong style={{ fontSize: 15 }}>{seat.name}</strong>
                  {/* The model, named. "Six judges" is only a claim until you
                      can see that they are six different models. */}
                  <span className="seat-model shrink" title={`${seat.family} family`}>
                    {seat.model === 'simulated' || seat.family === 'offline' ? 'simulated' : seat.model}
                  </span>
                </div>
                <p className="tiny" style={{ margin: '6px 0 0' }}>{seat.objective}</p>
                <p className="tiny" style={{ margin: '4px 0 8px', opacity: 0.75 }}>{seat.failsFor}</p>
                {seat.sameFamilyAsSut ? (
                  <p className="tiny" style={{ margin: '0 0 8px', color: 'var(--split)' }}>
                    Same family as your system: excluded from settled-case math by default, because judges favor their own family.
                  </p>
                ) : null}
                <button
                  className="ghost tiny-btn"
                  onClick={() => {
                    setEditing(seat.id);
                    setDraft({ name: seat.name, objective: seat.objective, failsFor: seat.failsFor });
                  }}
                >
                  edit
                </button>{' '}
                <button
                  className="ghost tiny-btn"
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
    <section className="rail-grid">
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
  onChange,
  onError,
}: {
  slug: string;
  token: string;
  traces: Trace[];
  loading: boolean;
  onChange: () => void;
  onError: (m: string) => void;
}) {
  const [format, setFormat] = useState<'paste' | 'jsonl' | 'csv'>('paste');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

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
    <section className="rail-grid">
      <div className="col">
        <div className="sec-title">
          <span className="no">2</span>
          <h2>The cases</h2>
        </div>
        <p className="sec-sub">
          The clear cases, the boundary cases, and the ones your documents never imagined. Your own transcript is
          the one that proves the product on your actual problem: paste one below.
        </p>
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

        {loading && traces.length === 0 ? (
          <Loading what="scenarios" />
        ) : traces.length === 0 ? (
          <div className="empty">No scenarios yet. Describe your AI below and they will be written for you.</div>
        ) : (
          traces.map((trace) => {
            const probe = typeof trace.meta?.probe === 'string' ? trace.meta.probe : '';
            return (
              <div className="panel" key={trace.id}>
                <div className="between" style={{ marginBottom: 8 }}>
                  <h3 style={{ margin: 0 }}>{trace.title}</h3>
                  <span className="tiny shrink">{sourceLabel(trace.source)}</span>
                </div>
                {probe ? (
                  <p className="tiny" style={{ marginTop: 0 }}>
                    Probes: {probe}
                  </p>
                ) : null}
                <div className="transcript" style={{ maxHeight: 220 }}>{trace.content}</div>

                <p className="tiny" style={{ margin: '10px 0 0' }}>
                  <button
                    className="ghost tiny-btn"
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
                </p>
              </div>
            );
          })
        )}

        <ScenarioWriter slug={slug} token={token} onDone={onChange} onError={onError} />

        <details className="deep">
          <summary>Paste a real transcript</summary>
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="tiny" style={{ marginTop: 0 }}>
              Already have transcripts of your AI at work? They make scenarios too. You judge what actually
              happened instead of a written situation.
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
              {result ? <span className="tiny" style={{ marginLeft: 12 }}>{result}</span> : null}
            </form>
          </div>
        </details>
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
    <section className="rail-grid">
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
                {draftedFrom.provider === 'anthropic'
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
