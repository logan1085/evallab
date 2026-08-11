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

## Running it for a team

One container, one SQLite file on a volume. Deliberately not a cluster — v1 is
one team and one project, and a single process serving the API and the built
SPA from the same origin is the whole topology, which is why a shared link works
with no CORS or session story.

```
ANTHROPIC_API_KEY=sk-ant-... docker compose up -d --build
open http://localhost:8787          # create a project, or open the demo
```

The seed script is a dev-time convenience and is not in the production image;
create the demo from the home page instead, which hits the same endpoint.

- Data lives on the `grading-room-data` volume at `/data`, never in the image.
- `/api/health` performs a real read, so a wedged database fails the check.
  Point your platform's health probe at it.
- `SIGTERM` finishes in-flight requests before closing the database, so a
  deploy does not drop a grader's verdict mid-submit. `init: true` in the
  compose file ensures the signal actually reaches the process.
- Put it behind TLS. The project key travels in the URL on first open, and the
  app strips it from the address bar immediately, but the first request carries
  it.

**Backups.** `npm run backup -- backups/2026-08-11.db` uses SQLite's own
`VACUUM INTO`, which is the difference between a restorable snapshot and one
missing whatever was in the write-ahead log when you copied the file. Restore by
pointing `GR_DB` at the backup, or copying it back while stopped.

### Fly.io

`fly.toml` is checked in.

```
fly launch --no-deploy
fly volumes create grading_room_data --size 1
fly secrets set ANTHROPIC_API_KEY=sk-ant-...    # optional; enables the real judge
fly deploy
```

**Keep it at one machine.** The database is a file on a volume, so two machines
means two independent databases behind one hostname and graders silently landing
on different ones. `fly.toml` pins `min_machines_running = 1` and disables
auto-stop for that reason.

Railway and Render work the same way — point them at the `Dockerfile`, mount a
volume at `/data`, and keep the instance count at one.

### Not Vercel

Serverless is the wrong shape for this. The filesystem is ephemeral and
per-invocation, there are no volumes, and this is a long-running process rather
than a set of functions — so grades would be written to a disk that disappears.
Making it fit would mean replacing SQLite with hosted Postgres, which turns
every synchronous store call async and buys nothing for a single-tenant app.

## CI

`.github/workflows/ci.yml` runs typecheck, tests and the build, then builds the
Docker image and smoke-tests it: health probe, SPA served from the same origin,
a seeded project written to the mounted volume, and a clean `SIGTERM` shutdown.
The image build is the one thing that cannot be verified from a dev container,
which is exactly why it runs there.

## The loop

1. **Bring in traces.** Paste, JSONL, or CSV. Field names are matched loosely,
   because eval platforms disagree about whether the transcript lives under
   `output`, `completion`, `messages`, or `trace`.
2. **Write a rubric,** or import the one you have.
3. **Run a round.** Everyone grades the same sample independently and blind.
4. **See the splits first,** clustered by the kind of disagreement.
5. **Resolve each one.** The prompt is always the same: what would the rubric
   have to say for us to have landed in the same place?
6. **Ship the revised rubric,** with the agreement number before and after.
7. **Generate a judge** from the calibrated rubric and score it against the
   humans on cases it has not seen.
8. **Run it again.** Shipping a rubric offers the next round in one click,
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
server/     Express API over SQLite (node:sqlite, no native deps)
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
| `npm run backup -- <path>` | Consistent snapshot of a live database |
| `npm test` | 78 tests |
| `npm run typecheck` | `tsc --noEmit` across shared, server, web, tests |
| `npm run build` | SPA to `dist/web`, server bundle to `dist/server.js` |
| `npm start` | Serve both from :8787 on one origin |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `GR_DB` | `data/grading-room.db` | SQLite path; `:memory:` works |
| `ANTHROPIC_API_KEY` | unset | Enables the real judge |
| `GR_JUDGE_MODEL` | `claude-opus-5` | Model for judge runs |

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
- One instance serves one team. There are no accounts and no tenancy, so
  running it for several teams means running several containers.
- The Dockerfile is unverified in CI — it was written against a verified
  production run (`node dist/server.js`, health, graceful shutdown, backup and
  restore all exercised) but the image build itself has not been executed.
