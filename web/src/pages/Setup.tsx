import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rememberKey } from '../api';
import type { Grader, Project } from '@shared/types';

/**
 * Setup: three questions to a seated panel. The chat format stays because it
 * tested well; what it gains here is a page of its own, a progress line, and
 * a real failure state. The rule: no silent spinner, ever. If generation
 * fails the page says so in words and offers one retry.
 *
 * The seating sequence is the first moment of delight: each seat fills in
 * order with a name and a stake, in mono, one at a time.
 */

const QUESTIONS = [
  {
    q: 'What is your company or team called?',
    placeholder: 'Meridian Outfitters',
    min: 1,
    nudge: 'Just a name to put on the framework.',
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

/**
 * Setup runs as three steps with their own requests, not one long one.
 *
 * Two reasons, and they are the same reason. A serverless function has a wall
 * clock, and seating a panel plus writing scenarios is two model calls: in
 * series inside the create request they ran it out and returned 504. Split
 * apart, each step also has a truthful moment of completion, so the page can
 * say "your panel is seated" when the panel is actually seated rather than
 * while it is still being written.
 */
type Step = 'creating' | 'seating' | 'writing';
type Phase = 'interview' | Step | 'done';

const STEP_COPY: Record<Step, { doing: string; failed: string }> = {
  creating: { doing: 'Opening your project.', failed: 'The project could not be created.' },
  seating: { doing: 'Writing five judges for your product, and seating the literalist with them.', failed: 'The judges could not be seated.' },
  writing: { doing: 'Writing the scenarios they will grade.', failed: 'The scenarios could not be written.' },
};

export function SetupPage() {
  const navigate = useNavigate();
  const [answers, setAnswers] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [nudge, setNudge] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('interview');
  const [failure, setFailure] = useState<{ step: Step; message: string } | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [seats, setSeats] = useState<Grader[]>([]);
  const [seatingFallback, setSeatingFallback] = useState<string | null>(null);
  const [caseCount, setCaseCount] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [email, setEmail] = useState('');
  const [emailNoted, setEmailNoted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const step = Math.min(answers.length, QUESTIONS.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, [answers.length, phase]);

  // The bench fills one seat at a time, but only once the seats are real.
  useEffect(() => {
    if (seats.length === 0 || revealed >= seats.length) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => setRevealed((n) => n + 1), reduced ? 0 : 400);
    return () => window.clearTimeout(t);
  }, [seats.length, revealed]);

  /**
   * Run the three steps in order, resuming at whichever one failed. Each step
   * announces itself before it starts and is only reported done when its own
   * request has returned.
   */
  async function run(done: string[], from: Step = 'creating') {
    const description = done[1]!.trim();
    // The limits stay a separate field: they become rubric clauses in the
    // owner's own words, not prose folded into the description.
    const limits = done[2]!.trim().toLowerCase() === 'skip' ? '' : done[2]!.trim();
    let current = project;
    // Tracked locally, not read back from state: state reads inside this
    // closure are stale, and blaming the wrong step would make "try again"
    // re-run a step that succeeded — for seating, that replaces the panel.
    let reached: Step = from;

    try {
      if (from === 'creating') {
        reached = 'creating';
        setPhase('creating');
        setFailure(null);
        const res = await api.createProject(done[0]!, description, limits);
        rememberKey(res.project.slug, res.project.token);
        current = res.project;
        setProject(res.project);
      }
      if (!current) throw new Error('The project is missing.');

      if (from === 'creating' || from === 'seating') {
        reached = 'seating';
        setPhase('seating');
        setFailure(null);
        const seated = await api.generatePanel(current.slug, current.token);
        setSeats(seated.seats);
        setSeatingFallback(seated.fallbackReason ?? null);
      }

      reached = 'writing';
      setPhase('writing');
      setFailure(null);
      const written = await api.generateScenarios(current.slug, current.token, { description });
      setCaseCount(written.scenarios.length);
      setPhase('done');
    } catch (err) {
      setFailure({
        step: reached,
        message: err instanceof Error && err.message ? err.message : STEP_COPY[reached].failed,
      });
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const spec = QUESTIONS[answers.length]!;
    if (text.length < spec.min) {
      setNudge(spec.nudge);
      return;
    }
    setNudge(null);
    setInput('');
    const done = [...answers, text];
    setAnswers(done);
    if (done.length === QUESTIONS.length) void run(done);
  }

  async function noteEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !email.trim()) return;
    try {
      await api.saveEmail(project.slug, project.token, email.trim());
      setEmailNoted(true);
    } catch {
      setEmailNoted(false);
    }
  }

  const benchSeated = seats.length > 0 && revealed >= seats.length;
  const working = phase === 'creating' || phase === 'seating' || phase === 'writing';

  return (
    <main className="sheet">
      <header className="masthead">
        <div className="stamp">
          <span><b>The Grading Room</b></span>
          <span>Setup</span>
        </div>
        <h1>Three questions.</h1>
        <p className="standfirst">Then five judges and a literalist, seated for your product.</p>
      </header>

      <section className="panel interview">
        <div className="msgs">
          {answers.map((a, i) => (
            <div key={i}>
              <div className="q">{QUESTIONS[i]!.q}</div>
              <div className="a">{a}</div>
            </div>
          ))}
          {phase === 'interview' ? <div className="q">{QUESTIONS[step]!.q}</div> : null}
        </div>

        {phase === 'interview' ? (
          <>
            <form onSubmit={submit}>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={QUESTIONS[step]!.placeholder}
                aria-label="Your answer"
              />
              <button type="submit" className="shrink" disabled={!input.trim()}>
                Answer
              </button>
            </form>
            {nudge ? <p className="progress-line">{nudge}</p> : null}
            <p className="progress-line">
              Question {Math.min(answers.length + 1, QUESTIONS.length)} of {QUESTIONS.length}
            </p>
          </>
        ) : null}
      </section>

      {working && !failure ? (
        <section className="panel">
          <div className="sec-title">
            <h2>{phase === 'seating' ? 'Seating your panel' : phase === 'writing' ? 'Writing your scenarios' : 'Opening your project'}</h2>
          </div>
          <p className="progress-line">{STEP_COPY[phase as Step].doing}</p>
        </section>
      ) : null}

      {failure ? (
        <section className="panel">
          <div className="sec-title">
            <h2>{STEP_COPY[failure.step].failed}</h2>
          </div>
          <p className="sec-sub">
            {failure.message} Nothing before this step was lost.
          </p>
          <button onClick={() => void run(answers, failure.step)}>Try {failure.step === 'writing' ? 'the scenarios' : failure.step === 'seating' ? 'the seating' : 'again'}</button>
        </section>
      ) : null}

      {seats.length > 0 ? (
        <section className="panel" aria-label="The bench">
          <div className="sec-title">
            <h2>{benchSeated ? 'Your panel is seated.' : 'Taking their seats.'}</h2>
          </div>
          <div>
            {seats.map((s, i) => (
              <div key={s.id} className={`bench-seat${i < revealed ? ' seated' : ''}`}>
                <span className="seat-name">{s.name}</span>
                <span className="seat-stake">
                  {s.objective} · fails: {s.failsFor.replace(/^Fails /i, '')}
                </span>
                <span className="seat-model">{s.model === 'simulated' ? 'simulated' : s.model}</span>
              </div>
            ))}
          </div>
          {benchSeated && seatingFallback ? (
            <p className="progress-line">
              These are the stock seats, not seats written for your product: the writer failed with
              {' '}{seatingFallback.trim().replace(/\.?$/, '.')} You can edit any of them in the Room, or retry the
              seating there.
            </p>
          ) : null}
          {benchSeated ? (
            <p className="progress-line">
              {seats.every((s) => s.family === 'offline')
                ? 'Six seats, all simulated: no model key is set, so this is the labeled simulation.'
                : `Six seats, ${new Set(seats.map((s) => s.family)).size} model families. They will not agree with each other for free.`}
            </p>
          ) : null}
        </section>
      ) : null}

      {phase === 'done' && project ? (
        <section className="panel">
          <div className="sec-title">
            <h2>{caseCount} scenarios written.</h2>
          </div>
          <p className="sec-sub">
            Your panel and your cases are waiting in the Room. Every seat and every case is editable there.
          </p>
          <h3 style={{ marginTop: 18 }}>This link is the only way back to your project. Keep it.</h3>
          <div className="link-box">{`${window.location.origin}/p/${project.slug}?k=${project.token}`}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="ghost"
              onClick={() =>
                navigator.clipboard?.writeText(`${window.location.origin}/p/${project.slug}?k=${project.token}`)
              }
            >
              Copy link
            </button>
            <form onSubmit={noteEmail} className="row" style={{ gap: 8 }}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                aria-label="Email for your link"
                style={{ width: 220 }}
              />
              <button type="submit" className="ghost" disabled={!email.trim() || emailNoted}>
                {emailNoted ? 'Noted' : 'Keep my email with it'}
              </button>
            </form>
          </div>
          {emailNoted ? (
            <p className="tiny" style={{ marginTop: 8 }}>
              Noted on the project. The link stays the key, so copy it too.
            </p>
          ) : null}
          <div style={{ marginTop: 22 }}>
            <button onClick={() => navigate(`/p/${project.slug}`)}>Enter the Room</button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
