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

const SEAT_VOTES = [
  { who: 'The impatient user', chip: 'pass', chipClass: 'pass', said: 'The answer is up front. Nothing buried.' },
  { who: 'The support lead', chip: 'recoverable', chipClass: 'partial', said: 'It hands work back. That is a follow-up ticket.' },
  { who: 'The literalist', chip: 'fail', chipClass: 'fail', said: 'The rubric never says what partial completion counts as.' },
] as const;

/** Beats of the pinned sequence: three seats vote, then the punchline. */
const BEATS = SEAT_VOTES.length + 1;

const CAPTIONS = [
  'Scroll. The panel grades blind: no seat sees another seat\u2019s verdict.',
  'The impatient user is satisfied.',
  'The support lead sees a ticket.',
  <>And the literalist finds it: <b>the rubric never decided this case.</b></>,
  <>And the literalist finds it: <b>the rubric never decided this case.</b></>,
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
        // Small screens unpin the stage in CSS, so scroll progress no longer
        // maps to the sequence: show it finished rather than frozen at zero.
        if (travel <= 0 || window.matchMedia('(max-width: 860px)').matches) {
          setBeat(BEATS);
          return;
        }
        // 0 as the stage pins, 1 as it releases; the last stretch holds the
        // finished state so it is readable before the page moves on.
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

  return (
    <section className="l-scroller" ref={ref}>
      <div className="l-stage">
        <div className="l-wrap">
          <div className="l-stage-head">
            <span className="l-stage-title">One case, three stakes</span>
            <div className="l-tally" aria-hidden="true">
              <span className="n-pass"><b>{beat >= 1 ? 1 : 0}</b> pass</span>
              <span className="n-partial"><b>{beat >= 2 ? 1 : 0}</b> recoverable</span>
              <span className="n-fail"><b>{beat >= 3 ? 1 : 0}</b> fail</span>
            </div>
          </div>

          <div className="l-demo l-demo--stage">
            <div className="l-card">
              <div className="l-trace-label">Nine of twelve done, gaps named</div>
              <p className="l-trace">
                <b>USER:</b> Migrate the remaining twelve call sites to the new API.{'\n\n'}
                <b>ASSISTANT:</b> Migrated nine of twelve. The remaining three depend on a helper that has no
                equivalent in the new API yet, so I have listed them below rather than guessing at a translation.
              </p>
            </div>

            <div className="l-verdicts">
              {SEAT_VOTES.map((v, i) => (
                <div key={v.who} className="l-verdict" data-on={beat >= i + 1 ? '' : undefined}>
                  <div>
                    <div className="l-who">{v.who}</div>
                    <div className="l-said">{v.said}</div>
                  </div>
                  <span className={`l-chip ${v.chipClass}`}>{v.chip}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="l-stage-foot">{CAPTIONS[beat]}</p>
          <p className="l-stage-punch" data-on={beat >= BEATS ? '' : undefined}>
            Where the panel splits is where your rubric is silent. The sentence it was missing is the product; the
            score is the by-product.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The arrival is a conversation, not a form. Three questions, scripted on the
 * client so it works with or without a model behind the server; the model's
 * real work starts when the answers become scenarios. Short answers are met
 * with a nudge and re-asked, the way a person would.
 */
const INTERVIEW = [
  {
    q: 'Hi. I write evals. What is your company or team called?',
    placeholder: 'Acme Outdoor',
    min: 1,
    nudge: 'Just a name to put on the project.',
  },
  {
    q: 'What do you do, and what is your AI supposed to handle?',
    placeholder: 'We sell outdoor gear online; our AI answers billing questions and can refund up to $50.',
    min: 10,
    nudge: 'A little more detail helps: what does the AI actually handle, day to day?',
  },
  {
    q: 'Anything it must never do? Refund caps, escalation rules, hard limits. Type "skip" if nothing comes to mind.',
    placeholder: 'Refunds over $50 need approval. Or: skip',
    min: 1,
    nudge: 'A limit, or the word "skip".',
  },
] as const;

function ArrivalChat({ onError }: { onError: (m: string) => void }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<{ role: 'a' | 'u'; text: string }[]>([
    { role: 'a', text: INTERVIEW[0].q },
  ]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages.length]);

  function say(text: string) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => setMessages((m) => [...m, { role: 'a', text }]), reduced ? 0 : 420);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const step = answers.length;
    const spec = INTERVIEW[step]!;
    setMessages((m) => [...m, { role: 'u', text }]);
    setInput('');

    if (text.length < spec.min) {
      say(spec.nudge);
      return;
    }

    const done = [...answers, text];
    setAnswers(done);

    if (done.length < INTERVIEW.length) {
      say(INTERVIEW[done.length]!.q);
      return;
    }

    say('Good. Writing your scenarios and seating your panel now\u2026');
    setBusy(true);
    const limits = done[2]!.toLowerCase() === 'skip' ? '' : ` Hard limits: ${done[2]}`;
    try {
      const { project } = await api.createProject(done[0]!, `${done[1]}${limits}`.trim());
      rememberKey(project.slug, project.token);
      navigate(`/p/${project.slug}?k=${encodeURIComponent(project.token)}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create the project.');
      setBusy(false);
      setAnswers(done.slice(0, -1));
      say('Something went wrong on my side. Say that last part again?');
    }
  }

  return (
    <div className="l-chat" data-reveal style={{ ['--d' as string]: '130ms' }}>
      <div className="l-msgs" ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`l-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>
      <form onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Writing\u2026' : INTERVIEW[Math.min(answers.length, INTERVIEW.length - 1)]!.placeholder}
          aria-label="Your answer"
          disabled={busy}
        />
        <button type="submit" className="l-primary" disabled={busy || !input.trim()}>
          {busy ? 'Writing\u2026' : 'Answer'}
        </button>
      </form>
    </div>
  );
}

export function Home() {
  const [error, setError] = useState<string | null>(null);

  useDarkPage();
  useReveal();

  return (
    <main className="landing">
      <nav className="l-nav" aria-label="The Grading Room">
        <div className="l-wrap">
          <span className="l-nav-mark">The Grading Room</span>
          <button
            className="l-nav-cta"
            onClick={() => document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' })}
          >
            Set up
          </button>
        </div>
      </nav>

      <section className="l-hero">
        <div className="l-wrap">
          <div className="l-name" data-reveal>
            The Grading Room
          </div>
          <h1 className="l-title" data-reveal style={{ ['--d' as string]: '60ms' }}>
            You can&rsquo;t recruit five experts. <span className="l-mute">Summon them.</span>
          </h1>
          <p className="l-sub" data-reveal style={{ ['--d' as string]: '120ms' }}>
            A panel of models with conflicting stakes grades your outputs blind. Where they split, your rubric is
            silent. You leave with the missing sentence and an eval you own.
          </p>
          <div className="l-cta-row" data-reveal style={{ ['--d' as string]: '180ms' }}>
            <button
              className="l-primary"
              onClick={() => document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Set up your company
            </button>
            <button
              className="l-tlink"
              onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}
            >
              See how it works <span className="chev">›</span>
            </button>
          </div>
        </div>
      </section>

      <section className="l-section l-section--intro" id="how">
        <div className="l-wrap">
          <h2 className="l-h2" data-reveal>
            Disagreement is the signal.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '80ms' }}>
            Each seat is a stake: one line of what it optimizes for, one line of what it fails an answer for. The
            literalist grades only what the rubric says. Where the literalist and everyone else split, your rubric
            is missing a sentence.
          </p>
        </div>
      </section>

      <PinnedPoll />

      <section className="l-close" id="start">
        <div className="l-wrap">
          <h2 className="l-h2" data-reveal>
            Set up your company.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '70ms' }}>
            No form, no sign-up, no reviewers to schedule. Answer three questions and you leave with a rubric, a
            case set, and a seated panel. Twenty minutes to an eval you own.
          </p>

          <ArrivalChat onError={setError} />

          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      </section>

      <div className="l-wrap">
        <div className="l-foot">
          <span>The Grading Room</span>
          <span>The rubric diff is the product. The score is the by-product.</span>
        </div>
      </div>
    </main>
  );
}
