# Where this is going

The product shipped in this repo is single-tenant and self-hosted: one team, one
SQLite file, a shared link as the only credential. That was the right shape for
an eval lead who can run a container.

It is the wrong shape for the users we are now aiming at — teams who have no
evals yet and nobody who will run Docker. This file records the decisions that
follow from that, so the rebuild happens once.

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

**Postgres, not SQLite.** Forced twice over — by serverless (no local disk) and
by multi-tenancy (one file per instance is a single point of failure with no
horizontal scale). Every store function becomes async, and `PRAGMA` /
`VACUUM INTO` / the backup script are replaced by the provider's tooling. Tests
use PGlite, which is Postgres compiled to WASM and runs in-process, so the suite
stays fast and needs no server.

**Frontend and API both on Vercel; Neon Postgres.** Use Neon's pooled
connection string — serverless functions exhaust a normal Postgres connection
limit quickly.

**Judge runs go on a queue.** A judge batch grades ~20 traces through an LLM,
which takes minutes and cannot complete inside a serverless function's timeout.
This is the one part of the system that does not fit request/response.

**Plain language everywhere.** No *held-out arm*, *calibration*, or
*Krippendorff's alpha* in the interface. "The held-back conversations." "How
often your team agrees." The honesty guards have to survive the translation —
small-sample caveats and the refusal to compare incomparable rounds are the
product, not jargon around it.

## What has to be rebuilt, and what does not

`shared/` is pure logic — agreement maths, split classification, sampling,
rubric rendering — with 45 tests and no database access. It is untouched by any
of this. That is most of the value in the test suite.

`server/store.ts` and `server/app.ts` get rewritten for async Postgres.

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

Built in `shared/drafting.ts` (pure) and `server/drafter.ts` (providers), on
SQLite. It ports to Postgres with the two new columns on `rubric_versions` and
nothing else.

## Still open

- **Whether a calibrated rubric measurably improves an LLM judge.** The
  commercial claim, still untested on real data. No amount of engineering
  settles it.
- **Whether a drafted rubric is a better starting point than a blank page.**
  Now testable: draft one, run a round, compare round-one agreement against a
  project whose rubric a person wrote unaided.
