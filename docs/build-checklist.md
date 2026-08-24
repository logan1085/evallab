# The Grading Room: the ten-sitting build, mapped to this repo

The build-prompts doc assumes a fresh Next.js + Supabase repo. This repo
already implements much of the product on Express + Vercel + Neon, with the
same product rules and a tested offline mode. This checklist maps each sitting
to what exists, and the boxes are the deltas. The two cross-cutting rules hold
here as they do there:

- Every number the product prints is computed by tested code against recorded
  fixtures before a live model is involved.
- No rubric clause reaches the screen without verbatim evidence behind it.

Status: [x] built and tested here · [ ] to build

## Sitting 1: the model gateway on OpenRouter

- [x] OpenRouter as the one router; fake/offline provider; every test offline
- [ ] Checked-in pin registry: pin_id, family, explicit versioned model id,
      provider_slug, tier, status; Ploom-compatible field names
- [ ] One `callModel()` gateway: caller tags, provider.only single slug,
      allow_fallbacks false, never the models array, retries (429/5xx,
      jittered, max 4, every attempt recorded), typed errors incl.
      model_deprecated, generation_id captured
- [ ] BYOK: the key arrives per request, never module-global, never persisted
      or logged; a test proves absence from every recorded object
- [ ] scripts/model-smoke.ts

## Sitting 2: schema and typed data layer

- [x] Projects, rubric versions (append-only), cases, seats-as-graders,
      rounds, verdicts, panel_edits, patches, user_verdicts, archetype library
- [ ] model_call table: one row per attempt incl. retries/failures, usage read
      off the router, generation_id, indexed by round and seat
- [ ] costForRound / costForPanelist aggregates; nothing rolled up
- [ ] Spend guard: per-round + daily ceilings from env, typed budget_exceeded,
      enforced inside callModel

## Sitting 3: the Eval Creator

- [x] Description in → rubric + cases + panel out, all editable drafts, cases
      capped, generated cases labeled, literalist always seated
- [x] Schema-validated generation with offline fallback
- [ ] Family-spread failure is loud at creation when under three real families
      (currently reported, not blocking)
- [ ] Live-call cost cross-check against the OpenRouter dashboard (needs key;
      external)

## Sitting 4: the panel surface

- [x] Seats as readable paragraphs; edit, delete, add from library; every edit
      a panel_edit row with before/after
- [ ] Family-spread summary line and under-three-families inline block
- [ ] same_family_as_sut label with its one-sentence explanation
- [ ] Delete-literalist warning naming what goes with it

## Sitting 5: the round runner

- [x] Every seat grades every case, blind (prompt carries no other seat's
      text); per-seat shuffle; per-seat progress; self-closing round
- [ ] Required reason enforced as schema failure, not defaulted
- [ ] 20% repeat sample per seat → self_consistency; below-threshold seats
      flagged and down-weighted
- [ ] output_length recorded per verdict; shuffle seed stored
- [ ] Pinned model-version map stored on the round row
- [ ] Running cost on the status endpoint, summed from model_call

## Sitting 6: the agreement math

- [x] Observed agreement, Krippendorff's alpha, Gwet's AC1 with worked
      examples; skew divergence asserted
- [ ] AC1 variance estimator (Gwet 2008), cited
- [ ] Length-vs-pass correlation per seat
- [ ] Typed undefined results: { value: null, reason } surfaced to the UI

## Sitting 7: the disagreement map

- [x] Four patterns; settled provisional until checked; dissenter named;
      ranked sections
- [ ] The literalist test: persona-driven splits the literalist does not
      corroborate are marked theater and excluded from patch mining
- [ ] same_family_as_sut seats excluded from settled math by default, with a
      visible toggle
- [ ] Down-weighted seats shown as down-weighted

## Sitting 8: the rubric diff

- [x] Grounding gate: two verbatim quotes by substring match or dropped, drop
      rate counted; accept writes a new rubric version
- [ ] Projected lift as a real recomputation of the agreement statistic under
      the amended outcome, not a coverage ratio
- [ ] panel_edit rows as candidate clauses (the deleted-seat signal)
- [ ] Changelog on the new version naming patches and source round

## Sitting 9: ten cases, graded by you

- [x] 4/4/2 draw with degraded fallback; blind until submitted; per-seat
      alignment; false settles as their own surface
- [ ] False-settle rate recorded on the round
- [ ] Who-speaks-for-you benchmarked against the 81% human ceiling in copy
- [ ] Re-weighting the panel toward the seats that share the user's taste
- [ ] A false settle convertible to a rubric patch in one click

## Sitting 10: export, re-run, recovery

- [x] Bundle: rubric.md, golden set (false settles excluded), judge prompt,
      panel.json with edit provenance, rerun script
- [ ] Round cost (total + per seat) in the bundle
- [ ] Content hash per artifact, recorded in an export table
- [ ] Re-run comparison: flip list with old verdict, new verdict
- [ ] scripts/recovery-test.ts: delete a clause, re-run, check the patch
      reconstructs it; three fixtures; pass rate printed; stability reported

## Deliberately out (per the spec's cut list)

Accounts, invites, orgs, SSO; trace/SDK ingestion; hosted CI; pairwise arena;
human seats (v1's mechanism, returns as a mode); dataset marketplace.
