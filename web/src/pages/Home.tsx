import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rememberKey } from '../api';
import { ErrorBanner } from '../ui';
import '../landing.css';

/**
 * The landing page.
 *
 * Deliberately a different design world from the rest of the app: dark,
 * full-bleed, display type, content arriving on scroll. The product is a light
 * grey instrument you work in; this is the page you read once.
 *
 * The demonstration in the second section is the whole pitch, shown rather than
 * claimed. It is the seeded demo's real trace and the three verdicts three
 * people actually gave it — not an invented example, because a made-up
 * disagreement would be exactly the sort of unearned illustration this product
 * exists to argue with.
 */

/** Reveals on scroll, and does nothing at all when the viewer prefers less motion. */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.setAttribute('data-shown', ''));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute('data-shown', '');
          io.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/** The page owns the viewport background, including the overscroll gutter. */
function useDarkPage() {
  useEffect(() => {
    document.documentElement.setAttribute('data-page', 'landing');
    return () => document.documentElement.removeAttribute('data-page');
  }, []);
}

const STEPS = [
  {
    n: '01',
    title: 'Bring in conversations',
    body: 'Paste them, upload a file, or drop in an export. Or start from the ones you already have.',
  },
  {
    n: '02',
    title: 'Get a rubric to argue with',
    body: 'Describe what your agent should do and it drafts a first one — including the questions your examples do not answer.',
  },
  {
    n: '03',
    title: 'Everyone grades blind',
    body: 'The same sample, independently. Nobody sees anyone else’s verdict until the round closes.',
  },
  {
    n: '04',
    title: 'The disagreements come first',
    body: 'Not the score. The specific conversations your team split on, grouped by the kind of split.',
  },
  {
    n: '05',
    title: 'Each one becomes a sentence',
    body: 'What would the rubric have to say for us to have landed in the same place? That answer is the rubric now.',
  },
  {
    n: '06',
    title: 'Then a judge, that you can trust',
    body: 'Built from the calibrated rubric and scored against your team on cases it has not seen.',
  },
];

export function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'new' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useDarkPage();
  useReveal();

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
    <main className="landing">
      <section className="l-hero">
        <div className="l-wrap">
          <span className="l-eyebrow" data-reveal>
            <span className="l-dot" />
            The Grading Room
          </span>
          <h1 className="l-title" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Your eval score is measuring <span className="l-grad">who graded it</span>
          </h1>
          <p className="l-sub" data-reveal style={{ ['--d' as string]: '120ms' }}>
            Hand the same twenty conversations to two people on your team and they will disagree on a meaningful share
            of them. Almost nobody measures how large that share is. Until you do, your eval number is a fact about one
            person’s afternoon.
          </p>
          <div className="l-cta-row" data-reveal style={{ ['--d' as string]: '180ms' }}>
            <button className="l-primary" onClick={openDemo} disabled={busy !== null}>
              {busy === 'demo' ? 'Building…' : 'See it on real disagreements'}
            </button>
            <button
              className="l-secondary"
              onClick={() => document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Start with your own
            </button>
          </div>
        </div>
      </section>

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-kicker" data-reveal>
            The problem
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Three careful people. One conversation. Three answers.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            This is a real trace from the demo project, and these are the three verdicts three graders gave it. Nobody
            here is wrong. The rubric simply never said which reading was the right one.
          </p>

          <div className="l-demo">
            <div className="l-card" data-reveal style={{ ['--d' as string]: '60ms' }}>
              <div className="l-trace-label">Nine of twelve done, gaps named</div>
              <p className="l-trace">
                <b>USER:</b> Migrate the remaining twelve call sites to the new API.{'\n\n'}
                <b>ASSISTANT:</b> Migrated nine of twelve. The remaining three depend on a helper that has no equivalent
                in the new API yet — I have listed them below rather than guessing at a translation.
              </p>
            </div>

            <div className="l-verdicts">
              {[
                { who: 'Ana', chip: 'partial', said: 'It stopped short. That is partial by definition.' },
                { who: 'Ben', chip: 'fail', said: 'The task was twelve. It did nine.' },
                { who: 'Cass', chip: 'pass', said: 'It named exactly what it did not do. That is the behaviour I want.' },
              ].map((v, i) => (
                <div key={v.who} className="l-verdict" data-reveal style={{ ['--d' as string]: `${140 + i * 110}ms` }}>
                  <div>
                    <div className="l-who">{v.who}</div>
                    <div className="l-said">{v.said}</div>
                  </div>
                  <span className={`l-chip ${v.chip}`}>{v.chip}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="l-punch" data-reveal style={{ ['--d' as string]: '160ms' }}>
            Every number your evals produce is downstream of this, and none of them show it to you.
          </p>
        </div>
      </section>

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-kicker" data-reveal>
            How it works
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Measure the disagreement, then spend it.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            Each split is not a problem to average away. It is a sentence your rubric was missing, and you only find it
            by having two people look at the same conversation without seeing each other.
          </p>

          <div className="l-steps">
            {STEPS.map((step, i) => (
              <div
                key={step.n}
                className="l-step"
                data-reveal
                style={{ ['--d' as string]: `${i * 80}ms`, ['--slice' as string]: `${(i / (STEPS.length - 1)) * 100}%` }}
              >
                <div className="l-step-n">{step.n}</div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-kicker" data-reveal>
            What you get
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            A number that means something, and the receipts behind it.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            Agreement is always shown next to coverage, because a rubric can buy agreement by saying less. When the
            sample is too small to support a statistic, the statistic is withheld rather than estimated.
          </p>

          <div className="l-numbers">
            {[
              { v: '58.3%', k: 'How often your team agreed before calibrating — measured, not guessed.' },
              { v: '4', k: 'Conversations they split on, each one now a sentence in the rubric.' },
              { v: 'held out', k: 'A set nobody discusses, so round two is measured on the same untouched cases.' },
            ].map((n, i) => (
              <div key={n.k} className="l-num-card" data-reveal style={{ ['--d' as string]: `${i * 90}ms` }}>
                <div className="l-num">{n.v}</div>
                <div className="l-num-k">{n.k}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-kicker" data-reveal>
            The restraint is the plan
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Four things it will never do.
          </h2>
          <div className="l-nots">
            {[
              ['It does not run your evals.', 'It plugs into whatever you already run.'],
              ['It does not store traces at scale.', 'That is an observability product. This is not one.'],
              ['It does not label training data.', 'Different job, different tool.'],
              ['It does not replace your eval platform.', 'It fixes the rubric that platform is executing.'],
            ].map(([bold, rest], i) => (
              <div key={bold} className="l-not" data-reveal style={{ ['--d' as string]: `${i * 70}ms` }}>
                <b>{bold}</b>
                <span>{rest}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="l-close" id="start">
        <div className="l-wrap">
          <h2 className="l-h2" data-reveal>
            Find out what your team actually disagrees about.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '70ms' }}>
            No sign-up. Creating a project gives you a link — anyone you send it to can grade.
          </p>

          <div className="l-cta-row" data-reveal style={{ ['--d' as string]: '120ms' }}>
            <button className="l-primary" onClick={openDemo} disabled={busy !== null}>
              {busy === 'demo' ? 'Building…' : 'Open the demo project'}
            </button>
          </div>

          <form className="l-start" onSubmit={createProject} data-reveal style={{ ['--d' as string]: '170ms' }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name your project"
              aria-label="Project name"
            />
            <button type="submit" className="l-primary" disabled={busy !== null || !name.trim()}>
              {busy === 'new' ? 'Creating…' : 'Create'}
            </button>
          </form>

          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      </section>

      <div className="l-wrap">
        <div className="l-foot">
          <span>The Grading Room</span>
          <span>A calibration layer for teams whose ground truth comes from human judgment.</span>
        </div>
      </div>
    </main>
  );
}
