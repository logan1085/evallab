# The Grading Room

A calibration layer for teams whose ground truth comes from human judgment.

Every team building agents writes evals. The eval produces a number. The number
depends on a rubric one person wrote in an afternoon. Hand the same twenty
traces to two people on that team and they will disagree on a meaningful share,
and almost nobody measures how large that share is.

This measures it, surfaces the specific cases, and turns each one into a
sentence the rubric was missing.

```
npm install
npm run seed     # demo project: 12 transcripts, 3 graders, round 1 already graded
npm run dev      # http://localhost:5173
```

`npm run seed` prints a shared link. Open it.

## Deploying it

Frontend and API both run on Vercel; the data lives in Postgres. There is no
server to keep alive and no disk to look after.

**1. A Postgres database.** Any provider works; [Neon](https://neon.tech) has a
free tier. Copy the **pooled** connection string — serverless functions open
connections quickly and a direct connection runs out of them.

**2. Import the repo into Vercel** and set two environment variables:

| | |
|---|---|
| `DATABASE_URL` | the pooled connection string, required |
| `ANTHROPIC_API_KEY` | optional; without it the judge and the rubric drafter are labelled stubs |

`vercel.json` already points the build at the SPA, routes `/api/*` to the single
function in `api/`, and gives that function the full 60 seconds a judge run
needs.

**3. Create the schema.**

```
DATABASE_URL='postgresql://…' npm run db:migrate
```

`openDb()` also runs this on every cold start, so it is not strictly required —
but running it explicitly means a bad connection string fails here, with a clear
message, instead of as a 500 on somebody's first request.

Then open the deployment, create a project, and share the link.

### Running it locally

```
npm install
npm run dev      # API on :8787, UI on :5173
```

With no `DATABASE_URL` the app runs on PGlite — Postgres compiled to WASM, held
in memory. Nothing installed, nothing to start, and the data is gone when you
stop it. That last part is the point: a local file that looked durable would not
be the thing production runs on. Set `DATABASE_URL` to point at a real database.

### What is not on the queue yet

A judge run grades a whole arm through an LLM, which is the one operation here
that does not fit inside a request. It runs inline, capped at 40 items, and the
API refuses a larger batch rather than starting one it cannot finish — a run
that dies halfway would leave a partial set of verdicts that got scored as
though it were the whole arm. Lifting the cap means a queue, and that is not
built.

## CI

`.github/workflows/ci.yml` runs typecheck, tests and the build. A second job
boots `api/index.ts` — the file Vercel actually invokes — over real HTTP and
creates a project through it, because the test suite drives the Express app
directly and would not catch a broken import or a pool rebuilt per request.

## The loop

1. **Bring in traces.** Paste, JSONL, or CSV. Field names are matched loosely,
   because eval platforms disagree about whether the transcript lives under
   `output`, `completion`, `messages`, or `trace`.
2. **Bring in what you already decided.** Your refund policy, your escalation
   SOP, the thread where someone settled a hard case. These are read, never
   graded, and they live in their own table so a policy can never appear in
   somebody's grading queue.
3. **Turn them into a rubric.** Every rule you have written down gets exactly
   one of three fates: a criterion that quotes the sentence it came from, a
   conflict handed back unreconciled, or an open question because the documents
   never covered the case.
4. **Run a round.** Everyone grades the same sample independently and blind.
5. **See the splits first,** clustered by the kind of disagreement.
6. **Resolve each one.** The prompt is always the same: what would the rubric
   have to say for us to have landed in the same place?
7. **Ship the revised rubric,** with the agreement number before and after.
8. **Generate a judge** from the calibrated rubric and score it against the
   humans on cases it has not seen.
9. **Run it again.** Shipping a rubric offers the next round in one click,
   drawn from this round's splits and reusing the identical held-out set. The
   project page then plots held-out agreement across rounds — the only view
   that answers whether any of this worked.

## What the code is careful about

These are the parts where it would be easy to ship something that produces a
number without meaning one.

**Blindness is structural, not a preference.** While a round is open, no
endpoint returns another grader's verdict — not the queue, not the progress
readout, not the report. The report is gated on the round being closed, and
closing a round stops accepting grades. There is no ordering in which a grader
can read first and grade second. The grading queue also withholds which *arm*
an item is in, since a grader who knows a trace is held out grades it
differently.

**Agreement never appears without coverage.** A rubric can buy agreement by
saying less. Participation, abstention rate and clause coverage are rendered in
the same block as the agreement number, so a rubric that narrows its way to 95%
is visible as one.

**Statistics are withheld rather than approximated.** Krippendorff's alpha is
not reported below five comparable items; a bootstrap interval is not reported
below eight. When every grader used a single category, expected disagreement is
zero and alpha is undefined — the code returns `null` rather than the 1.0 that
would look like perfect agreement. Caveats travel with the number instead of
living in documentation, including an explicit one when the panel is small
enough to move the result by itself.

**The sampler says what it actually did.** Round one is random. Round two draws
from round one's splits and fills the rest at random. Neither is clever, and
the UI prints the real sentence — including how many items were carried versus
filled — rather than implying a boundary-seeking sampler that does not exist.

**Held-out means held out**, in three separate places. The arm is reserved
before calibration draws, so calibration can never eat the measurement set. A
held-out split cannot be resolved, because writing a rubric clause about a trace
you are measuring on is teaching to the test. And while any round is still being
graded, every other round's report withholds verdicts and notes for the traces
that round is using — otherwise reusing a held-out set, which is exactly how
before-and-after gets measured on the same cases, would hand the later round's
graders the earlier answers.

**The trajectory refuses to draw a line it cannot justify.** Held-out agreement
only means "the rubric improved" if the later round graded the same held-out
traces with the same panel. Change either and the rounds are reported as
incomparable, the delta is withheld, and the chart leaves the gap open rather
than bridging it — naming who joined or dropped out.

**Translating a policy has exactly three outcomes, and only one of them is a
rule.** A sentence of policy either becomes a criterion — carrying the sentence
it encodes, quoted, so a person can check the translation did not add or drop a
condition — or it becomes a conflict, or it becomes an open question. The
drafter is explicitly forbidden from repairing a contradiction into a clean
criterion, because a model asked to turn a messy policy into a tidy rubric will
happily reconcile two conflicting rules and hand back something that looks
finished. That destroys the most valuable thing the translation finds: written
operations contradict themselves constantly, and most companies learn this the
first time somebody tries to automate them.

Conflicts never reach the judge — a rule that contradicts another rule is not
gradable by anybody, so a judge could only guess or abstain. Citations do reach
it, because the judge must read exactly what the humans read.

**A drafted rubric has to carry its own gaps.** Asked to draft from a handful
of transcripts, a model can produce something authoritative-sounding that is,
in the places that matter, a guess — the afternoon rubric this product exists
to argue with, written faster. So the draft is required to return the questions
the examples do not answer, and the drafter is told never to state an unsettled
case as a criterion. Those questions are stored with the rubric, travel with
its exports, and are struck by hand once a round has actually settled one.
They are also the useful half: they predict where round one will split.

They are deliberately kept out of the judge prompt. Telling a judge "abstain
when the case turns on one of these" would make an early rubric abstain often
and a calibrated one abstain rarely, and since abstentions never count as
agreement, calibration would post a win that had nothing to do with judgment.

Without `ANTHROPIC_API_KEY` the drafter returns no criteria at all, plus the
questions teams argue about first — and says that is what it is doing.
Inventing criteria offline would hand someone a rubric that looks drafted from
their data and is not.

**Rubric versions a round has pinned are immutable.** Editing one forks a new
version. Otherwise a closed round's numbers would silently start referring to a
rubric nobody graded against.

**The judge reads the rubric verbatim** — the same text the humans read — and
is then scored as one more rater on the same units, with the same math. Without
`ANTHROPIC_API_KEY` it falls back to a deterministic keyword scorer that is
labelled, in the UI and in the API response, as not a judge.

## Layout

```
shared/     domain types and pure logic — metrics, splits, sampling, rubric rendering
server/     Express API over Postgres; api/index.ts is the Vercel entry
web/        React SPA (Vite)
tests/      vitest — agreement math, split ordering, sampler, API behaviour
```

`shared/` is imported by both sides, so the agreement math the server computes
and the types the UI renders cannot drift.

## Commands

| | |
|---|---|
| `npm run dev` | API on :8787, UI on :5173 with a proxy |
| `npm run seed` | Create the demo project, print its link |
| `npm run db:migrate` | Create or update the schema on `DATABASE_URL` |
| `npm test` | 114 tests |
| `npm run typecheck` | `tsc --noEmit` across shared, server, web, tests |
| `npm run build` | SPA to `dist/web`, server bundle to `dist/server.js` |
| `npm start` | Serve both from :8787 on one origin |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | unset | Postgres. Unset means in-memory PGlite, which is not durable |
| `PORT` | `8787` | HTTP port, standalone server only |
| `ANTHROPIC_API_KEY` | unset | Enables the real judge and the real rubric drafter |
| `GR_JUDGE_MODEL` | `claude-opus-5` | Model for judge runs |
| `GR_DRAFT_MODEL` | `claude-opus-5` | Model for rubric drafting |
| `GR_PG_MAX` | `4` | Pool size per serverless instance |

## Scope

Deliberately not an eval platform. It does not run evals, store traces at
scale, do observability, or label training data. It improves the rubric the
platform you already have is executing. The restraint is the plan: the moment
this grows into a pipeline product it is competing on pipeline features against
funded incumbents with no wedge left.

Known limits of this version, stated rather than managed away:

- The shared link is the entire auth model. Anyone with it can grade and read
  the report.
- The demo transcripts are authored, not captured from production runs. Every
  seeded trace is tagged `authored-demo` and the UI says so.
- Clause coverage means "this case was argued about and the rubric now says
  something about it", tracked by provenance. It is not a semantic match.
- Round-two sampling is splits-then-random. It is not a boundary-seeking
  sampler and does not claim to be.
- The shared link is still the only tenancy. Every project in one deployment
  sits in one database, separated by an unguessable slug and token and nothing
  else. Accounts are meant to come from Clerk; see `ARCHITECTURE.md`.
- Judge runs are capped at 40 items because they run inside the request. A
  queue is the fix and is not built.
- The deployment has been verified against PGlite — real Postgres, compiled to
  WASM — and through the serverless entry over HTTP, but not yet against a
  hosted Neon database on Vercel itself.
