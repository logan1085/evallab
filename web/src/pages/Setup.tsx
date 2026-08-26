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

type Phase = 'interview' | 'seating' | 'failed' | 'seated';

export function SetupPage() {
  const navigate = useNavigate();
  const [answers, setAnswers] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [nudge, setNudge] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('interview');
  const [failure, setFailure] = useState('');
  const [project, setProject] = useState<Project | null>(null);
  const [seats, setSeats] = useState<Grader[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [email, setEmail] = useState('');
  const [emailNoted, setEmailNoted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const step = Math.min(answers.length, QUESTIONS.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, [answers.length, phase]);

  // The bench fills one seat at a time.
  useEffect(() => {
    if (phase !== 'seated' || revealed >= seats.length) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => setRevealed((n) => n + 1), reduced ? 0 : 450);
    return () => window.clearTimeout(t);
  }, [phase, revealed, seats.length]);

  async function create(done: string[]) {
    setPhase('seating');
    setFailure('');
    // The limits stay a separate field: they become rubric clauses in the
    // owner's own words, not prose folded into the description.
    const limits = done[2]!.trim().toLowerCase() === 'skip' ? '' : done[2]!.trim();
    try {
      const res = await api.createProject(done[0]!, done[1]!.trim(), limits);
      rememberKey(res.project.slug, res.project.token);
      const view = await api.project(res.project.slug, res.project.token);
      setProject(res.project);
      setSeats(view.graders.filter((g) => g.kind === 'panelist'));
      setPhase('seated');
    } catch (err) {
      setFailure(
        err instanceof Error && err.message
          ? err.message
          : 'The judges could not be seated. Nothing was lost; your answers are still here.',
      );
      setPhase('failed');
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
    if (done.length === QUESTIONS.length) void create(done);
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

  const benchDone = phase === 'seated' && revealed >= seats.length;

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

      {phase === 'seating' ? (
        <section className="panel">
          <div className="sec-title">
            <h2>Seating your panel</h2>
          </div>
          <p className="progress-line">Judges are being written for your product, and your scenarios with them. About half a minute.</p>
        </section>
      ) : null}

      {phase === 'failed' ? (
        <section className="panel">
          <div className="sec-title">
            <h2>The seating failed</h2>
          </div>
          <p className="sec-sub">{failure}</p>
          <button onClick={() => void create(answers)}>Try the seating again</button>
        </section>
      ) : null}

      {phase === 'seated' && project ? (
        <>
          <section className="panel" aria-label="The bench">
            <div className="sec-title">
              <h2>Your panel is seated.</h2>
            </div>
            <div>
              {seats.map((s, i) => (
                <div key={s.id} className={`bench-seat${i < revealed ? ' seated' : ''}`}>
                  <span className="seat-name">{s.name}</span>
                  <span className="seat-stake">
                    {s.objective} · fails: {s.failsFor.replace(/^Fails /i, '')}
                  </span>
                </div>
              ))}
            </div>
            {benchDone ? (
              <p className="progress-line">Your scenarios are written and waiting in the Room. Every seat is editable there.</p>
            ) : null}
          </section>

          {benchDone ? (
            <section className="panel">
              <h3 style={{ marginTop: 0 }}>This link is the only way back to your project. Keep it.</h3>
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
        </>
      ) : null}
    </main>
  );
}
