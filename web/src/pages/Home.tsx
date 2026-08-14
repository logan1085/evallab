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
    title: 'Describe what your AI does',
    body: 'A sentence or two. Add whatever rules you already have written down — a policy, a checklist, the thread where someone settled a hard case.',
  },
  {
    n: '02',
    title: 'It writes the scenarios',
    body: 'Concrete situations for your team to judge: the clear cases, the boundary cases, and the ones your documents never imagined. None contain their own answer.',
  },
  {
    n: '03',
    title: 'Your team votes, blind',
    body: 'Everyone answers the same scenarios independently. Nobody sees anyone else’s vote until the poll closes — that is what makes the result a measurement.',
  },
  {
    n: '04',
    title: 'Agreement becomes test cases',
    body: 'Every scenario your team judged the same way exports as a test case, carrying their own words as the reason.',
  },
  {
    n: '05',
    title: 'Disagreement becomes a decision',
    body: 'Where careful people split, your team settles it once, on the record — instead of re-deciding it silently on every future run.',
  },
  {
    n: '06',
    title: 'Out comes an eval set',
    body: 'A .jsonl your eval platform can run, plus a judge built from the standard your team actually agreed on — and scored against them to prove it.',
  },
];

export function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
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
      const { project } = await api.createProject(name.trim(), description.trim());
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
            Tacit
          </span>
          <h1 className="l-title" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Your company already knows <span className="l-grad">what good looks like</span>
          </h1>
          <p className="l-sub" data-reveal style={{ ['--d' as string]: '120ms' }}>
            It just lives in your people&rsquo;s heads. Tacit polls your team on concrete scenarios, measures where
            they actually agree, and hands back an eval set your AI can be held to — extracted, not invented.
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
            Why polling
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Ask three people. Get three answers.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            A real scenario from the demo, and the three votes three teammates cast on it. Nobody here is wrong — the
            company just never decided. Every eval written by one person in an afternoon quietly picks one of these
            answers and calls it truth.
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
            The standard your AI is graded against should be what your team believes — measured, not assumed.
          </p>
        </div>
      </section>

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-kicker" data-reveal>
            How it works
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            From your team&rsquo;s heads to a .jsonl file.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            Six steps, and the honest part is the middle: the poll is blind, so what comes out is what your people
            actually believe — not what the loudest person in the room said first.
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
            Evals with receipts.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            Every test case can answer &ldquo;why?&rdquo; with a person, a vote, and a sentence — not &ldquo;a model
            decided&rdquo;. When the numbers are too thin to mean anything, they are withheld rather than estimated.
          </p>

          <div className="l-numbers">
            {[
              { v: '.jsonl', k: 'An eval set your platform can run today — one case per line, with your team’s own words as the evidence.' },
              { v: '2⁄2', k: 'A case exports only when the votes agree, or the disagreement was settled on the record. Nothing is averaged.' },
              { v: 'held back', k: 'Some scenarios never export — they measure whether your team’s agreement is improving on untouched ground.' },
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
              ['It does not grade your employees.', 'It asks them. Their judgment is the raw material, never the subject.'],
              ['It does not average disagreement away.', 'A 2–1 split is a decision your company has not made, not a data point.'],
              ['It does not run your evals.', 'It writes them. The .jsonl drops into whatever you already run.'],
              ['It does not let the AI vote.', 'A model can be scored against your team, never counted as one of them.'],
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
            Extract what your team knows.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '70ms' }}>
            No sign-up. Create a project, and you get a link — send it to the people whose judgment you trust.
          </p>

          <div className="l-cta-row" data-reveal style={{ ['--d' as string]: '120ms' }}>
            <button className="l-primary" onClick={openDemo} disabled={busy !== null}>
              {busy === 'demo' ? 'Building…' : 'Open the demo project'}
            </button>
          </div>

          <form className="l-start l-start--tall" onSubmit={createProject} data-reveal style={{ ['--d' as string]: '170ms' }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your company or team"
              aria-label="Company or team name"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What do you do, and what is your AI supposed to handle? e.g. We sell outdoor gear online; our AI answers billing questions and can refund up to $50 without approval."
              aria-label="What your company does and what your AI handles"
            />
            <button type="submit" className="l-primary" disabled={busy !== null || !name.trim()}>
              {busy === 'new' ? 'Writing your scenarios…' : 'Create my eval poll'}
            </button>
          </form>

          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      </section>

      <div className="l-wrap">
        <div className="l-foot">
          <span>Tacit</span>
          <span>Extract your company&rsquo;s experience into evals.</span>
        </div>
      </div>
    </main>
  );
}
