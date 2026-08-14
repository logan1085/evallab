import { useEffect, useRef, useState } from 'react';
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

const VOTES = [
  { who: 'Ana', chip: 'partial', said: 'It stopped short. That is partial by definition.' },
  { who: 'Ben', chip: 'fail', said: 'The task was twelve. It did nine.' },
  { who: 'Cass', chip: 'pass', said: 'It named exactly what it did not do. That is the behaviour I want.' },
] as const;

/** Beats of the pinned sequence: one per vote, then the punchline. */
const BEATS = VOTES.length + 1;

const CAPTIONS = [
  'Scroll — the poll is blind, so each vote lands without seeing the others.',
  'One vote in. Nobody can see it but Ana.',
  'Two votes, and already a disagreement.',
  <>Three careful people. <b>Three different answers.</b></>,
  <>Three careful people. <b>Three different answers.</b></>,
] as const;

/**
 * The scenario holds still while the three votes land, driven by scroll: a
 * tall scroller with a sticky stage inside it, scroll distance mapped to poll
 * progress. Ported from the direction-two prototype, which exists to get this
 * technique right. Under reduced motion, or wherever the stage cannot pin
 * (small screens, no travel), the finished poll is shown at once instead.
 */
function PinnedPoll() {
  const ref = useRef<HTMLElement>(null);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setBeat(BEATS);
      return;
    }
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const box = el!.getBoundingClientRect();
        const travel = box.height - window.innerHeight;
        if (travel <= 0) {
          setBeat(BEATS);
          return;
        }
        // 0 as the stage pins, 1 as it releases; the last stretch holds the
        // finished poll so it is readable before the page moves on.
        const p = Math.min(Math.max(-box.top / travel, 0), 1);
        setBeat(Math.round(Math.min(p / 0.82, 1) * BEATS));
      });
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const votesIn = Math.min(beat, VOTES.length);
  const tally = { pass: 0, partial: 0, fail: 0 };
  VOTES.slice(0, votesIn).forEach((v) => { tally[v.chip] += 1; });

  return (
    <section className="l-scroller" ref={ref}>
      <div className="l-stage">
        <div className="l-wrap">
          <div className="l-stage-head">
            <span className="l-stage-title">One scenario, three teammates</span>
            <div className="l-tally" aria-hidden="true">
              <span className="n-pass"><b>{tally.pass}</b> pass</span>
              <span className="n-partial"><b>{tally.partial}</b> partial</span>
              <span className="n-fail"><b>{tally.fail}</b> fail</span>
            </div>
          </div>

          <div className="l-demo l-demo--stage">
            <div className="l-card">
              <div className="l-trace-label">Nine of twelve done, gaps named</div>
              <p className="l-trace">
                <b>USER:</b> Migrate the remaining twelve call sites to the new API.{'\n\n'}
                <b>ASSISTANT:</b> Migrated nine of twelve. The remaining three depend on a helper that has no
                equivalent in the new API yet — I have listed them below rather than guessing at a translation.
              </p>
            </div>

            <div className="l-verdicts">
              {VOTES.map((v, i) => (
                <div key={v.who} className="l-verdict" data-on={i < votesIn ? '' : undefined}>
                  <div>
                    <div className="l-who">{v.who}</div>
                    <div className="l-said">{v.said}</div>
                  </div>
                  <span className={`l-chip ${v.chip}`}>{v.chip}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="l-stage-foot">{CAPTIONS[beat]}</p>
          <p className="l-stage-punch" data-on={beat >= BEATS ? '' : undefined}>
            Nobody here is wrong. The company just never decided — and an eval written by one person in an
            afternoon quietly decides it for everyone.
          </p>
        </div>
      </div>
    </section>
  );
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

      <section className="l-section l-section--intro">
        <div className="l-wrap">
          <p className="l-kicker" data-reveal>
            Why polling
          </p>
          <h2 className="l-h2" data-reveal style={{ ['--d' as string]: '60ms' }}>
            Ask three people. Get three answers.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '110ms' }}>
            A real scenario from the demo project, and the real votes three teammates cast on it — not an invented
            disagreement. Keep scrolling and watch the poll come in the way it actually happens: blind.
          </p>
        </div>
      </section>

      <PinnedPoll />

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
