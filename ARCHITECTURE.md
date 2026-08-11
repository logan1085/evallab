# Where this is going

This started single-tenant and self-hosted: one team, one SQLite file, a shared
link as the only credential. That was the right shape for an eval lead who can
run a container, and the wrong one for the teams we are aiming at — who have no
evals yet and nobody who will run Docker.

This file records the decisions that followed, and marks which are done. The
data layer and the hosting are; identity and the judge queue are not.

The flow these decisions serve is prototyped, clickable, at
`prototype/flow.html` — eight screens, nothing wired up.

## Decisions

**We host it, multi-tenant.** Non-technical users will not deploy anything, so
self-hosting is off the table. That makes tenancy a correctness problem rather
than a feature: every read is scoped by workspace membership, and the failure
mode is one customer seeing another's traces.

**Identity comes from Clerk, later.** Not built yet, and deliberately not
hand-rolled in the meantime. This removes most of the tenancy schema rather than
postponing it: Clerk Organizations already provides workspaces, roles and invite
links, so `users`, `sessions` and `invites` are theirs and never ours. What stays
is a thin mapping — a project carries a Clerk organization id, a grader carries a
Clerk user id — and roles are read from Clerk membership. Until then the existing
shared-link model stands.

**Postgres, not SQLite.** *Done.* Forced twice over — by serverless (no local
disk) and by multi-tenancy. Every store function is async; `PRAGMA`,
`VACUUM INTO` and the backup script are gone, replaced by the provider's
tooling. Tests use PGlite, which is Postgres compiled to WASM and runs
in-process, so the suite needs no server. Sharing one instance per test file
rather than per test kept it at fourteen seconds instead of ninety.

**Frontend and API both on Vercel; Neon Postgres.** *Done.* `api/index.ts` is
the single function; `vercel.json` routes `/api/*` to it and everything else to
the SPA. The pool and the app are built once per instance, not once per request.
Use Neon's pooled connection string — serverless functions exhaust a normal
connection limit quickly.

**Judge runs go on a queue.** *Not done.* A judge batch grades a whole arm
through an LLM, which is the one operation that does not fit request/response.
The interim is a hard cap of 40 items and a refusal above it: a run that dies
halfway leaves a partial set of verdicts that would be scored as though it were
the whole arm, and reporting agreement over the items that happened to finish
first is exactly the kind of unearned number this product exists to prevent.

**Plain language everywhere.** No *held-out arm*, *calibration*, or
*Krippendorff's alpha* in the interface. "The held-back conversations." "How
often your team agrees." The honesty guards have to survive the translation —
small-sample caveats and the refusal to compare incomparable rounds are the
product, not jargon around it.

## What moved, and what did not

`shared/` is pure logic — agreement maths, split classification, sampling,
rubric rendering, drafting — with no database access. The port did not touch a
line of it, which is most of the value in the test suite and the reason the
statistics were never at risk.

`server/store.ts` and `server/app.ts` are now async over Postgres. The store
still writes `?` placeholders and `db.ts` rewrites them to `$1..$n`, so the port
was one adapter plus a mechanical change at the call sites rather than a rewrite
of every query string.

## Tenancy model

Drafted against SQLite and dropped rather than half-ported. Recorded here
because the shape is what matters, not the SQL.

Most of it is now Clerk's. What remains on our side:

```
projects   gains org_id      -- Clerk organization
graders    gains user_id     -- Clerk user
```

Two things worth keeping from that draft:

**Roles are owner and member.** Owners manage traces, the rubric and rounds;
members grade. Clerk membership roles map onto this directly. It also fixes a
hazard in the current build, where anyone with the link can close a round while
three colleagues are halfway through it and the number then gets computed from
their half-finished work.

**A grader row stays keyed on the account, not the typed name.** Every metric
and report query keys on `grader_id`, so keeping that row stable means the whole
tested statistics layer is untouched by the move to accounts — and a rename
mid-round cannot fork one person into two graders and quietly corrupt their
agreement scores.

## Settled since

**What "draft a rubric from these conversations" returns.** A scale, criteria
grounded in the transcripts, and — the part that makes it this product's
drafter rather than a prompt anyone could write — the questions the examples do
not answer. The drafter is forbidden from stating an unsettled case as a
criterion; if the examples do not decide it, it goes in the open questions. The
draft is never written on acceptance by the model, only by a human, and a
drafted rubric is labelled as never having been read by a second person.

Built in `shared/drafting.ts` (pure) and `server/drafter.ts` (providers), and
carried through the Postgres port on two columns of `rubric_versions`.

## Still open

- **Whether a calibrated rubric measurably improves an LLM judge.** The
  commercial claim, still untested on real data. No amount of engineering
  settles it.
- **Whether a drafted rubric is a better starting point than a blank page.**
  Now testable: draft one, run a round, compare round-one agreement against a
  project whose rubric a person wrote unaided.
