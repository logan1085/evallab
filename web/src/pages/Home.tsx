import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rememberKey } from '../api';
import { ErrorBanner, Masthead } from '../ui';

export function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'new' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy('new');
    setError(null);
    try {
      const { project } = await api.createProject(name.trim());
      rememberKey(project.slug, project.token);
      navigate(`/p/${project.slug}?k=${encodeURIComponent(project.token)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
      setBusy(null);
    }
  }

  async function openDemo() {
    setBusy('demo');
    setError(null);
    try {
      const seeded = await api.createDemo();
      rememberKey(seeded.slug, seeded.token);
      navigate(`/p/${seeded.slug}?k=${encodeURIComponent(seeded.token)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the demo project.');
      setBusy(null);
    }
  }

  return (
    <main className="sheet">
      <Masthead
        crumbs={['v1', 'Calibration']}
        title="Your eval score is measuring who graded it"
        standfirst="A calibration layer for teams whose ground truth comes from human judgment, which is all of them."
      />

      <section className="band rail-grid">
        <div className="rail">
          <span className="num">01</span>
          <span className="rail-label">Start</span>
          <span className="rail-note">Two ways in.</span>
        </div>
        <div className="col two-up">
          <div className="panel">
            <h2>Open the demo</h2>
            <p className="lede">
              Twelve transcripts, a three-way rubric, and one round already graded by three people, so the split report
              has something in it before you have done any work. The transcripts are authored rather than captured from
              production runs, and the project banner says so.
            </p>
            <button onClick={openDemo} disabled={busy !== null}>
              {busy === 'demo' ? 'Building…' : 'Open the demo project'}
            </button>
          </div>

          <div className="panel">
            <h2>Start with your own traces</h2>
            <p className="lede">
              Creates an empty project and a shared link. There is no sign-up: the link is the credential, and anyone
              who has it can grade.
            </p>
            <form onSubmit={createProject}>
              <div className="row">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="project-name">Project name</label>
                  <input
                    id="project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Support agent, weekly eval"
                  />
                </div>
                <div className="shrink">
                  <button type="submit" disabled={busy !== null || !name.trim()}>
                    {busy === 'new' ? 'Creating…' : 'Create project'}
                  </button>
                </div>
              </div>
            </form>
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        </div>
      </section>

      <section className="band rail-grid">
        <div className="rail">
          <span className="num">02</span>
          <span className="rail-label">The loop</span>
          <span className="rail-note">Seven steps.</span>
        </div>
        <div className="col">
          <h2>Grade blind, surface the splits, turn each one into a sentence</h2>
          <ol className="plain" style={{ paddingLeft: 22 }}>
            <li>Bring in traces — paste, upload, or drop in a platform export.</li>
            <li>Write a rubric, or import the one you have.</li>
            <li>Run a round. Everyone grades the same sample independently and blind.</li>
            <li>See the splits first, not the aggregate, clustered by the kind of disagreement.</li>
            <li>Resolve each one: what would the rubric have to say for us to have landed in the same place?</li>
            <li>Ship the revised rubric, with the agreement number before and after.</li>
            <li>Generate a judge from the calibrated rubric and see how well it agrees with the humans.</li>
          </ol>
          <div className="keyline">
            <p>
              Step seven is the commercial reason this exists. You cannot responsibly automate grading until humans
              agree on what grading means.
            </p>
          </div>
        </div>
      </section>

      <section className="band rail-grid">
        <div className="rail">
          <span className="num">03</span>
          <span className="rail-label">What it is not</span>
          <span className="rail-note">The restraint is the plan.</span>
        </div>
        <div className="col">
          <ul className="plain">
            <li>
              <strong>It does not run evals.</strong> It plugs into what you already run.
            </li>
            <li>
              <strong>It does not store traces at scale</strong> or do observability.
            </li>
            <li>
              <strong>It does not label training data.</strong> Different job, different tool.
            </li>
            <li>
              <strong>It does not replace your eval platform.</strong> It improves the rubric that platform is
              executing.
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
