# The Grading Room

You cannot recruit five domain experts to argue about your outputs. You can
summon them.

Describe what you are building. The Grading Room drafts a rubric, writes the
hard cases, and seats a panel of models with conflicting stakes: the impatient
user, the safety reviewer, the domain stickler, the support lead, and always
the literalist, who grades only what the rubric says and refuses to fill gaps
with judgment. The panel grades blind. Where it splits, your rubric is silent,
and the product's output is not the score: it is the sentence your rubric was
missing, quoted verbatim from the room, plus a golden set and a judge prompt
you own and can re-run forever.

Then you grade ten cases yourself. Where you disagree with a unanimous panel
is a rubric clause no panel could have found, because it lives in your head or
your business. That list ships with the bundle, and nothing you overruled ever
exports as golden.

Every seat is editable before anything runs, and every edit is recorded as
signal about what good means for your project. Without model API keys the
whole loop runs against a deterministic simulation that is labeled simulated
on every surface: the flow is real, the verdicts are not, and the product says
so instead of pretending.

Verdicts are pass, recoverable, fail. Agreement reports Gwet's AC1 beside
Krippendorff's alpha, because under the skewed pass rates of a working system
alpha collapses toward zero and reads as no agreement while the room agrees on
nearly everything.

```
npm install
npm run dev      # http://localhost:5173
```

## Keys

One key: **`OPENROUTER_API_KEY`**. Every model call in the product goes
through OpenRouter, so that key seats a panel spanning Anthropic, OpenAI,
Google, Meta, DeepSeek and Mistral, and runs scenario writing, panel writing,
rubric drafting and the judge as well. With no key the loop still runs against
a deterministic simulation that is labeled simulated on every surface.

There is deliberately no per-vendor key path. A call that goes straight to a
vendor skips `callModel`, and skipping `callModel` means no version pin, no
`model_call` row, no spend ceiling and no typed error: the product would lose
the ability to account for itself exactly where it spends money. A test
(`tests/models.test.ts`) fails the build if a provider SDK or endpoint
reappears in `server/`.

Run `npm run pins:check` before the first live round. The registry pins exact
versioned model slugs, which is the right discipline and also the thing most
likely to go stale; that command checks every one against openrouter.ai's own
model list in a single request.

## Deploying it

Frontend and API both run on Vercel; the data lives in Postgres. There is no
server to keep alive and no disk to look after.

**1. Import the repo into Vercel.** Change no build settings; `vercel.json`
already handles them.

**2. Add a database from inside Vercel.** Project → Storage → Create Database →
Neon. It provisions one and writes the credentials into the project for you, so
you never handle the connection string. Redeploy once afterwards so the new
variables are picked up.

The app reads whichever variable the integration wrote (`DATABASE_URL`,
`POSTGRES_URL`, or their unpooled counterparts), preferring a pooled one,
because serverless functions exhaust a direct connection under load. Provisioning
by hand from [neon.tech](https://neon.tech) works identically: set `DATABASE_URL`
to the **pooled** string, the one with `-pooler` in the hostname.

**Set `OPENROUTER_API_KEY`.** This one matters: scenario writing is the heart
of the product, and without a key every company gets the same six labelled
placeholder scenarios instead of ones written from its own description. The
panel, the judge and the rubric drafter also fall back to clearly labelled
stubs.

`vercel.json` points the build at the SPA, routes `/api/*` and `/s/*` to the
single function in `api/`, and gives that function 300 seconds. Setup never
needs that much: creating a project does no model work, and seating the panel
and writing scenarios are separate requests of one model call each, precisely
so neither runs into a function's wall clock.

**3. Create the schema.** If Vercel provisioned the database, pull its
variables first:

```
npx vercel env pull .env.local
set -a && . ./.env.local && set +a && npm run db:migrate
```

Or with a string you hold yourself. Single quotes, because `?` and `&` mean
things to your shell and a password can contain `$`:

```
DATABASE_URL='postgresql://…?sslmode=require' npm run db:migrate
```

It prints which variable it used, warns if that connection is unpooled, and
names any missing table. `openDb()` runs the same migration on every cold start,
so this is not strictly required, but running it explicitly means a bad
connection string fails here, with a clear message, rather than as a 500 on
somebody's first request.

Then open the deployment, create a project, and share the link.

### Running it locally

```
npm install
npm run dev      # API on :8787, UI on :5173
```

With no `DATABASE_URL` the app runs on PGlite, which is Postgres compiled to WASM, held
in memory. Nothing installed, nothing to start, and the data is gone when you
stop it. That last part is the point: a local file that looked durable would not
be the thing production runs on. Set `DATABASE_URL` to point at a real database.

### What is not on the queue yet

A judge run grades a whole arm through an LLM, which is the one operation here
that does not fit inside a request. It runs inline, capped at 16 items, and the
API refuses a larger batch rather than starting one it cannot finish: a run
that dies halfway would leave a partial set of verdicts that got scored as
though it were the whole arm.

Sixteen is derived, not picked. Items grade four at a time, so N items is
ceil(N/4) waves and a judge call takes roughly 5–12s: sixteen is four waves,
about 48s at the pessimistic end, inside a 60s function. It is also more than
the statistics need (five comparable items before alpha is reported at all,
eight before an interval is) and more than a round can realistically hold,
since the thirty-minute attention budget caps a round near 24 traces and a
judge run scores one arm of one. Lifting the ceiling means a queue, and that is
not built.

## An agent as the operator

Agents are a first-class user here, not an afterthought. The HTTP API is
versioned at `/api/v1` and documents itself: `GET /api/v1/docs` returns the
endpoint list with copy-pasteable curl examples. `/api/v1` and `/api` (what
the bundled UI calls) are one Express router mounted twice, so the two
surfaces cannot drift. Requests authenticate with `Authorization: Bearer
<key>`, where the key is the project token the create call returns or a named
key minted from the project page (or `POST /api/v1/projects/:slug/keys`);
minted keys are stored hashed, shown once, and revocable one at a time. A
request with no key gets 401, a wrong or revoked key 403.

`mcp/server.ts` is an MCP server over that API. It lets Claude, or anything
else that speaks MCP, run the whole loop: create a project, feed it your
policies, translate them into a rubric, open a round, read the report, score
a judge.

```
npm run build:mcp
```

Then point your agent host at it. For Claude Code:

```
claude mcp add tacit --env TACIT_BASE_URL=https://your-deployment.vercel.app -- node /abs/path/to/dist/mcp.js
```

Or in a Claude Desktop config:

```json
{
  "mcpServers": {
    "tacit": {
      "command": "node",
      "args": ["/abs/path/to/dist/mcp.js"],
      "env": { "TACIT_BASE_URL": "https://your-deployment.vercel.app" }
    }
  }
}
```

It talks to the HTTP API rather than the database, so the same binary works
against a local dev instance or the deployed one.

### The one thing an agent cannot do

**It cannot join a round as a grader.** There is no tool for it, and a test
asserts no tool name even contains "grade".

The product's central number is agreement between independent human raters. If
a model quietly becomes one of those raters, "your team agreed 72% of the time"
turns into "two people and a language model agreed 72% of the time": a
different claim, under the same name, that no caller would notice. The HTTP API
will happily let anything join with any name, so the guard lives where the agent
actually is.

An agent that wants a model's verdicts has a correct path: `run_judge` builds a
judge from the rubric and scores it *against* the humans on cases it has not
seen. Scored against, never counted among. That is the same line the schema
draws between `graders` and `judge_runs`, and the MCP surface refuses to blur
it, including in the tool descriptions, since a description is the only thing
the calling model reads before it picks a tool.

### A second direction, prototyped

`web/public/agent.html`, served at `/agent.html`, sketches the version of this
aimed at agents rather than companies: Claude reads a repository's own standards
(`CLAUDE.md`, the contributing guide, the review checklist) and hands back the
rules that cancel each other out. Same machinery, pointed somewhere new.

It is a prototype and says so on the page. The MCP server underneath it is real.

It is also a period piece: it was drawn in the product's earlier dark visual
world, which the hearing-room design replaced. It is kept as a sketch of the
idea, not as a live surface, and is no longer held to the current palette. The
drift test that used to guard it now guards a copy that matters: the Standards
page inlines its own CSS, so `tests/design-system.test.ts` asserts it and the
app never disagree about the palette, the three type families, or the rule that
the signal red belongs to splits alone.

## CI

`.github/workflows/ci.yml` runs typecheck, tests and the build. A second job
boots `api/index.ts`, the file Vercel actually invokes, over real HTTP and
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
   project page then plots held-out agreement across rounds, the only view
   that answers whether any of this worked.

## What the code is careful about

These are the parts where it would be easy to ship something that produces a
number without meaning one.

**Blindness is structural, not a preference.** While a round is open, no
endpoint returns another grader's verdict: not the queue, not the progress
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
zero and alpha is undefined, so the code returns `null` rather than the 1.0 that
would look like perfect agreement. Caveats travel with the number instead of
living in documentation, including an explicit one when the panel is small
enough to move the result by itself.

**The sampler says what it actually did.** Round one is random. Round two draws
from round one's splits and fills the rest at random. Neither is clever, and
the UI prints the real sentence, including how many items were carried versus
filled, rather than implying a boundary-seeking sampler that does not exist.

**Held-out means held out**, in three separate places. The arm is reserved
before calibration draws, so calibration can never eat the measurement set. A
held-out split cannot be resolved, because writing a rubric clause about a trace
you are measuring on is teaching to the test. And while any round is still being
graded, every other round's report withholds verdicts and notes for the traces
that round is using. Otherwise reusing a held-out set, which is exactly how
before-and-after gets measured on the same cases, would hand the later round's
graders the earlier answers.

**The trajectory refuses to draw a line it cannot justify.** Held-out agreement
only means "the rubric improved" if the later round graded the same held-out
traces with the same panel. Change either and the rounds are reported as
incomparable, the delta is withheld, and the chart leaves the gap open rather
than bridging it, naming who joined or dropped out.

**Translating a policy has exactly three outcomes, and only one of them is a
rule.** A sentence of policy either becomes a criterion, carrying the sentence
it encodes, quoted, so a person can check the translation did not add or drop a
condition, or it becomes a conflict, or it becomes an open question. The
drafter is explicitly forbidden from repairing a contradiction into a clean
criterion, because a model asked to turn a messy policy into a tidy rubric will
happily reconcile two conflicting rules and hand back something that looks
finished. That destroys the most valuable thing the translation finds: written
operations contradict themselves constantly, and most companies learn this the
first time somebody tries to automate them.

Conflicts never reach the judge: a rule that contradicts another rule is not
gradable by anybody, so a judge could only guess or abstain. Citations do reach
it, because the judge must read exactly what the humans read.

**A drafted rubric has to carry its own gaps.** Asked to draft from a handful
of transcripts, a model can produce something authoritative-sounding that is,
in the places that matter, a guess: the afternoon rubric this product exists
to argue with, written faster. So the draft is required to return the questions
the examples do not answer, and the drafter is told never to state an unsettled
case as a criterion. Those questions are stored with the rubric, travel with
its exports, and are struck by hand once a round has actually settled one.
They are also the useful half: they predict where round one will split.

They are deliberately kept out of the judge prompt. Telling a judge "abstain
when the case turns on one of these" would make an early rubric abstain often
and a calibrated one abstain rarely, and since abstentions never count as
agreement, calibration would post a win that had nothing to do with judgment.

Without `OPENROUTER_API_KEY` the drafter returns no criteria at all, plus the
questions teams argue about first, and says that is what it is doing.
Inventing criteria offline would hand someone a rubric that looks drafted from
their data and is not.

**Rubric versions a round has pinned are immutable.** Editing one forks a new
version. Otherwise a closed round's numbers would silently start referring to a
rubric nobody graded against.

**The judge reads the rubric verbatim**, the same text the humans read, and
is then scored as one more rater on the same units, with the same math. Without
`OPENROUTER_API_KEY` it falls back to a deterministic keyword scorer that is
labelled, in the UI and in the API response, as not a judge.

## Layout

```
shared/     domain types and pure logic: metrics, splits, sampling, rubric rendering
server/     Express API over Postgres; api/index.ts is the Vercel entry
web/        React SPA (Vite)
tests/      vitest: agreement math, split ordering, sampler, API behaviour
```

`shared/` is imported by both sides, so the agreement math the server computes
and the types the UI renders cannot drift.

## Commands

| | |
|---|---|
| `npm run dev` | API on :8787, UI on :5173 with a proxy |
| `npm run seed` | Create the demo project, print its link |
| `npm run db:migrate` | Create or update the schema on `DATABASE_URL` |
| `npm run pins:check` | Verify every pinned model slug against openrouter.ai |
| `npm run mcp` | Run the MCP server over stdio (dev) |
| `npm run build:mcp` | Bundle it to `dist/mcp.js` for an agent host |
| `npm test` | 152 tests |
| `npm run typecheck` | `tsc --noEmit` across shared, server, web, tests |
| `npm run build` | SPA to `dist/web`, server bundle to `dist/server.js` |
| `npm start` | Serve both from :8787 on one origin |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | unset | Postgres. Unset means in-memory PGlite, which is not durable |
| `POSTGRES_URL` | unset | Accepted too; whichever variable your host's integration wrote |
| `PORT` | `8787` | HTTP port, standalone server only |
| `OPENROUTER_API_KEY` | unset | The one model key. Enables the real panel, judge, drafter and scenarist |
| `GR_CREATOR_PIN` | `anthropic-frontier-1` | Which registry pin writes panels, scenarios, rubrics and judge verdicts |
| `GR_ROUND_COST_CEILING_CREDITS` | unset | Per-round spend ceiling, enforced inside `callModel` |
| `GR_DAILY_COST_CEILING_CREDITS` | unset | Daily spend ceiling, same enforcement |
| `GR_PG_MAX` | `4` | Pool size per serverless instance |
| `GR_BASE_URL` | `http://localhost:8787` | Which instance the MCP server talks to |

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
- Judge runs are capped at 16 items because they run inside the request. A
  queue is the fix and is not built.
- The deployment has been verified against PGlite (real Postgres, compiled to
  WASM) and against a real Postgres 16 server over the `pg` pool driver: the
  full browser journey, plus create-project, kill the server, reopen the
  secret link in a fresh browser. Not yet against a hosted Neon database on
  Vercel itself. A deployment without a connection string refuses every
  request with instructions rather than running in-memory and losing data;
  `/api/health` reports which database is live.
