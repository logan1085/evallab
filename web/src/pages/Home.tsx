import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import '../landing.css';

/**
 * The landing: one promise, proved in thirty seconds, artifact shown, setup
 * started. Same paper as the product; the only red on the page is the split
 * row in the demonstration. Setup lives on its own page now, so this page
 * has exactly one job.
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
function usePaperPage() {
  useEffect(() => {
    document.documentElement.setAttribute('data-page', 'landing');
    return () => document.documentElement.removeAttribute('data-page');
  }, []);
}

const SEAT_VOTES = [
  { who: 'The impatient user', chip: 'pass', chipClass: 'pass', split: false, said: 'The answer is up front. Nothing buried.' },
  { who: 'The support lead', chip: 'recoverable', chipClass: 'partial', split: false, said: 'It hands work back. That is a follow-up ticket.' },
  { who: 'The literalist', chip: 'fail', chipClass: 'fail', split: true, said: 'The rubric never says what partial completion counts as.' },
] as const;

/** Beats of the pinned sequence: three seats vote, then the punchline. */
const BEATS = SEAT_VOTES.length + 1;

const CAPTIONS = [
  'Scroll. The panel grades blind: no seat sees another seat’s verdict.',
  'The impatient user is satisfied.',
  'The support lead sees a ticket.',
  <>And the literalist splits the room: <b>the rubric never decided this case.</b></>,
  <>And the literalist splits the room: <b>the rubric never decided this case.</b></>,
] as const;

/**
 * The scenario holds still while the three votes land, driven by scroll: a
 * tall scroller with a sticky stage inside it, scroll distance mapped to
 * progress. Under reduced motion, or wherever the stage cannot pin, the
 * finished state shows at once.
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
        if (travel <= 0 || window.matchMedia('(max-width: 860px)').matches) {
          setBeat(BEATS);
          return;
        }
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
    <section className="l-scroller" ref={ref} aria-label="Watch them disagree">
      <div className="l-stage">
        <div className="l-wrap">
          <div className="l-stage-head">
            <span className="l-stage-title">Watch them disagree.</span>
            <div className="l-tally" aria-hidden="true">
              <span className="n-pass"><b>{beat >= 1 ? 1 : 0}</b> pass</span>
              <span className="n-partial"><b>{beat >= 2 ? 1 : 0}</b> recoverable</span>
              <span className="n-fail"><b>{beat >= 3 ? 1 : 0}</b> fail</span>
            </div>
          </div>

          <div className="l-demo l-demo--stage">
            <div className="l-card">
              <div className="l-trace-label">One case, graded blind</div>
              <p className="l-trace">
                <b>USER:</b> Migrate the remaining twelve call sites to the new API.{'\n\n'}
                <b>ASSISTANT:</b> Migrated nine of twelve. The remaining three depend on a helper that has no
                equivalent in the new API yet, so I have listed them below rather than guessing at a translation.
              </p>
            </div>

            <div className="l-verdicts">
              {SEAT_VOTES.map((v, i) => (
                <div
                  key={v.who}
                  className="l-verdict"
                  data-on={beat >= i + 1 ? '' : undefined}
                  data-split={v.split ? '' : undefined}
                >
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
            Where they split, your rubric is silent. The split writes the missing sentence.
          </p>
        </div>
      </div>
    </section>
  );
}

/** The artifact, shown before any button is clicked: a Standards page in miniature. */
function ArtifactCard() {
  return (
    <div className="l-artifact" data-reveal style={{ ['--d' as string]: '90ms' }}>
      <div className="t">Standards v2</div>
      <div className="s">Meridian Outfitters support agent</div>
      <div className="stamp">Graded by 5 experts + the literalist · 12 cases · 14 splits · Aug 2026</div>
      <div className="clause">
        Refunds up to $50 are issued without asking; a request above $50 is declined and routed to a human, never
        improvised.
      </div>
      <div className="clause">The answer to the question asked appears in the first two sentences, before any caveat.</div>
      <div className="clause added">
        <span className="tag">added after a split</span>
        Stopping early counts as recoverable when the remaining gap is named explicitly; unfinished work handed
        back without a named gap is a fail.
      </div>
    </div>
  );
}

export function Home() {
  usePaperPage();
  useReveal();

  return (
    <main className="landing">
      <nav className="l-nav" aria-label="The Grading Room">
        <div className="l-wrap">
          <span className="l-nav-mark">The Grading Room</span>
          <Link className="l-primary" to="/setup">
            Seat your panel
          </Link>
        </div>
      </nav>

      <section className="l-hero">
        <div className="l-wrap">
          <h1 className="l-title" data-reveal>
            Five experts walk in.
            <br />
            One framework walks out.
          </h1>
          <p className="l-sub" data-reveal style={{ ['--d' as string]: '90ms' }}>
            The Grading Room seats a panel of simulated expert judges with conflicting stakes. They grade your AI
            blind. They argue. Every argument ends as a sentence in your evaluation framework: <b>named, versioned,
            and yours.</b>
          </p>
          <div className="l-cta-row" data-reveal style={{ ['--d' as string]: '160ms' }}>
            <Link className="l-primary" to="/setup">
              Seat your panel
            </Link>
            <a className="l-tlink" href="/s/example">
              See a real framework <span className="chev">›</span>
            </a>
          </div>
        </div>
      </section>

      <PinnedPoll />

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-eyebrow">The artifact</p>
          <h2 className="l-h2" data-reveal>
            The framework is the product.
          </h2>
          <p className="l-lede" data-reveal style={{ ['--d' as string]: '70ms' }}>
            Not a dashboard, not a score. A written document your team can read, argue with, and ship beside your
            agent.
          </p>
          <ArtifactCard />
          <p className="l-caption">This is what you leave with. It has a name, a version, and a link.</p>
        </div>
      </section>

      <section className="l-section">
        <div className="l-wrap">
          <p className="l-eyebrow">How it works</p>
          <h2 className="l-h2" data-reveal>
            One sitting, start to framework.
          </h2>
          <ol className="l-steps">
            <li data-reveal>Describe your AI. We seat five judges and a literalist.</li>
            <li data-reveal style={{ ['--d' as string]: '60ms' }}>Run one round. Every seat grades every case, blind.</li>
            <li data-reveal style={{ ['--d' as string]: '120ms' }}>Every split becomes a sentence. You leave with Standards v1.</li>
          </ol>
        </div>
      </section>

      <section className="l-close">
        <div className="l-wrap">
          <p className="line" data-reveal>
            The rubric diff is the product. The score is the by-product.
          </p>
          <Link className="l-primary" to="/setup" data-reveal style={{ ['--d' as string]: '100ms' }}>
            Seat your panel
          </Link>
        </div>
      </section>

      <div className="l-wrap">
        <div className="l-foot">
          <span className="mark">The Grading Room</span>
          <span>Built for people who ship AI and have to defend it.</span>
        </div>
      </div>
    </main>
  );
}
