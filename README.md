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

**Held-out means held out.** The held-out arm is reserved before calibration
draws, so calibration can never eat the measurement set, and a follow-up round
can reuse the same held-out traces so before-and-after is measured on the same
cases.

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
| `npm test` | 65 tests |
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
