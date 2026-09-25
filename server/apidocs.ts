/**
 * The API documentation, served by the API it documents.
 *
 * Markdown on purpose: an agent reads it as text, a person reads it in the
 * browser, and there is no docs site to fall out of date separately. The
 * examples use the caller's own host so they are copy-pasteable as printed.
 *
 * /api and /api/v1 are the same router mounted twice, so nothing documented
 * here can behave differently from what the UI exercises. v1 is the name to
 * build against.
 */

export function renderApiDocs(base: string): string {
  const v1 = `${base}/api/v1`;
  return `# The Grading Room API (v1)

A panel of models with conflicting stakes grades your outputs blind.
Everything the UI does happens through this API; \`/api/v1\` and \`/api\` are
one router mounted twice, so the two surfaces cannot drift.

Base URL: \`${v1}\`

## Authentication

Creating a project needs no key. Everything else on a project accepts either:

- \`Authorization: Bearer <key>\` where \`<key>\` is the project token returned
  by the create call, or a minted \`gr_\` key
- the \`?k=<token>\` query parameter from the project's secret link

A request with no credential gets \`401\`. A wrong or revoked key gets \`403\`.

### Mint, list, revoke keys

The project token is the master credential; minted keys can be handed to
agents and revoked one at a time. The full key is returned once and only its
hash is stored.

\`\`\`bash
curl -s -X POST ${v1}/projects/$SLUG/keys \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"name":"ci-agent"}'
# -> { "key": "gr_…", "id": "…", "prefix": "gr_…", "note": "Store this key now…" }

curl -s ${v1}/projects/$SLUG/keys -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE ${v1}/projects/$SLUG/keys/$KEY_ID -H "Authorization: Bearer $TOKEN"
\`\`\`

## The loop

### 1. Create a project

Returns the project (its \`token\` is the master key) and a first rubric version
built from any hard limits you pass, verbatim. It makes no model calls, so it
returns immediately; seating the panel and writing the scenarios are steps 3
and 4, one model call each.

\`\`\`bash
curl -s -X POST ${v1}/projects \\
  -H 'content-type: application/json' \\
  -d '{"name":"Acme Outdoor","description":"A support agent that answers billing questions and can refund up to $50 without approval.","limits":"Never refund over $50 without human approval."}'
# -> { "project": { "slug": "…", "token": "…" }, "rubric": { "version": 1, … } }
SLUG=…; TOKEN=…
\`\`\`

### 2. Read the project

\`\`\`bash
curl -s ${v1}/projects/$SLUG -H "Authorization: Bearer $TOKEN"
\`\`\`

### 3. Scenarios (cases)

\`\`\`bash
curl -s ${v1}/projects/$SLUG/traces -H "Authorization: Bearer $TOKEN"          # list
curl -s -X POST ${v1}/projects/$SLUG/scenarios \\
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"description":"What the AI is supposed to do."}'                        # write more
curl -s -X POST ${v1}/projects/$SLUG/traces \\
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"traces":[{"title":"A hard case","content":"USER: … ASSISTANT: …"}]}'   # paste your own
\`\`\`

#### The write as a job

The one-shot POST above holds a connection open for as long as the model
takes, and some edges cut a silent connection after twenty seconds with
no response at all. The Room writes through a job instead: create it (fast),
run it (a stream with a heartbeat line every four seconds, a line per part
as it lands, and a final line with done: true; each part's cases are saved
the moment they arrive), and read it back by polling when the run's
connection drops. Running a job again reruns only the parts that did not
land. \`?mode=json\` on run answers once, as JSON, for curl.

\`\`\`bash
curl -s -X POST ${v1}/projects/$SLUG/scenario-jobs -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"description":"…"}'                       # 202 { job }
curl -sN -X POST ${v1}/projects/$SLUG/scenario-jobs/$JOB/run -H "Authorization: Bearer $TOKEN"   # ndjson stream
curl -s ${v1}/projects/$SLUG/scenario-jobs/$JOB -H "Authorization: Bearer $TOKEN"                # poll
\`\`\`

#### The coverage map

Which kinds of ground the cases stand on: clear cases the rules settle,
boundary cases where they run out, cases the documents never imagined,
and your own transcripts. Each written scenario is stamped with the ground
it was written for; the map counts each class, reads how the last finished
round graded it (splits, pass rate), and names the gaps. A gap in a
written class is filled by asking for that ground alone.

\`\`\`bash
curl -s ${v1}/projects/$SLUG/coverage -H "Authorization: Bearer $TOKEN"
curl -s -X POST ${v1}/projects/$SLUG/scenarios -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"description":"…","count":4,"ground":"boundary"}'
\`\`\`

### 4. The panel

One model call. Idempotent: it never regenerates over your edits. Each seat
takes a different model family from the pin registry, and the literalist takes
the cheapest, because a panel that is one model six times agrees with itself
for reasons that have nothing to do with your rubric. Seats can be added, edited (\`PATCH\`), and deleted; every edit is
recorded as signal.

\`\`\`bash
curl -s -X POST ${v1}/projects/$SLUG/panel -H "Authorization: Bearer $TOKEN"
curl -s ${v1}/projects/$SLUG/panel/archetypes -H "Authorization: Bearer $TOKEN"
\`\`\`

#### Your own model in a seat

Any OpenAI-compatible chat endpoint (a fine-tune behind vLLM, an internal
gateway, a vendor API) can take a seat. Register it once per project, check
that it answers, then move a seat onto it. The key is sealed at rest under
GR_SECRET and never returned; responses carry its last four characters.
Calls to it go through the same gateway as every other seat: recorded,
metered, and pinned into the round.

\`\`\`bash
curl -s -X POST ${v1}/projects/$SLUG/endpoints -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"name":"our fine-tune","base_url":"https://llm.example.com/v1","model":"acme-support-7b","api_key":"…"}'
curl -s -X POST ${v1}/projects/$SLUG/endpoints/$EID/check -H "Authorization: Bearer $TOKEN"   # one real call
curl -s -X PATCH ${v1}/projects/$SLUG/panel/seats/$SEAT -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"endpointId":"'$EID'"}'                           # null moves it back
curl -s ${v1}/projects/$SLUG/endpoints -H "Authorization: Bearer $TOKEN"
\`\`\`

### 5. Run a blind round

Create the round, then run each seat. Every seat grades every case blind;
the round closes itself after the last seat.

\`\`\`bash
ROUND=$(curl -s -X POST ${v1}/projects/$SLUG/panel-rounds -H "Authorization: Bearer $TOKEN")
RID=$(echo "$ROUND" | jq -r .round.id)
for SEAT in $(echo "$ROUND" | jq -r '.seats[].id'); do
  curl -s -X POST ${v1}/rounds/$RID/panel-run \\
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
    -d "{\\"seatId\\":\\"$SEAT\\"}"
done
\`\`\`

With \`OPENROUTER_API_KEY\` on the server the seats are real models on pinned
versions, one family each; per-request BYOK is accepted as \`x-openrouter-key\`
and never stored. With no key the run is a labeled simulation. Every call,
including retries, lands in \`model_call\` with its usage read off the router,
which is where the per-seat costs on the map come from.

Then the stability pass, the mixture's second axis: every seat is asked again
about the cases the panel did not settle, under two more phrasings of the
same standard. A seat that flips is marked unstable on that case; its vote is
shown on the map and never mined into the rubric. Unanimous cases are not
rechecked. \`GR_PROMPT_VARIANTS\` sets the number of phrasings (default 3).

\`\`\`bash
curl -s -X POST ${v1}/rounds/$RID/stability -H "Authorization: Bearer $TOKEN"
# -> { "checked": 5, "rechecked": 30, "unstable": 4, "variants": 3, "simulated": false }
\`\`\`

### 6. Read the disagreement map

\`\`\`bash
curl -s ${v1}/rounds/$RID/map -H "Authorization: Bearer $TOKEN"
\`\`\`

Settled, persona-driven, contested, and blind-spot cases, read on the votes
that survived paraphrase; each vote carries \`stable\` and \`agreement\`;
agreement (alpha and AC1 with variance); per-seat weights and
self-consistency; pinned models and running cost.

### 7. Mine and accept the rubric diff

\`\`\`bash
curl -s -X POST ${v1}/rounds/$RID/patches -H "Authorization: Bearer $TOKEN"    # mine
curl -s -X PATCH ${v1}/rounds/$RID/patches/$PATCH_ID \\
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"action":"accept"}'                                                     # accept -> new rubric version
\`\`\`

Every patch carries two verbatim quotes from the round or it is dropped;
projected lift is a real recomputation, not a coverage ratio.

### 8. Grade your ten

\`\`\`bash
curl -s ${v1}/rounds/$RID/self-check -H "Authorization: Bearer $TOKEN"         # the ten, blind
curl -s -X POST ${v1}/rounds/$RID/self-check \\
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"itemId":"…","verdict":"pass","reason":"…"}'                            # one grade
curl -s ${v1}/rounds/$RID/alignment -H "Authorization: Bearer $TOKEN"          # who speaks for you
\`\`\`

#### Several reviewers

Add \`reviewer\` (a name) to the self-check GET and POST and the verdicts
are that person's, kept apart from the owner's. Everything downstream
reads the consensus: the majority across reviewers, the owner breaking
ties. The reviewers report says who graded what, agreement between them
(Krippendorff's alpha on the cases at least two of them saw, against the
same human ceiling as the panel), and the cases they split on, which are
the ones to settle in a room.

\`\`\`bash
curl -s "${v1}/rounds/$RID/self-check?reviewer=Ana" -H "Authorization: Bearer $TOKEN"
curl -s -X POST ${v1}/rounds/$RID/self-check -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"itemId":"…","verdict":"fail","reason":"…","reviewer":"Ana"}'
curl -s ${v1}/rounds/$RID/reviewers -H "Authorization: Bearer $TOKEN"          # agreement and the splits
\`\`\`

### 9. Export

\`\`\`bash
curl -s ${v1}/rounds/$RID/bundle -H "Authorization: Bearer $TOKEN"                 # as JSON
curl -sO -J ${v1}/rounds/$RID/bundle.zip -H "Authorization: Bearer $TOKEN"         # as one file
curl -sO -J ${v1}/projects/$SLUG/eval.zip -H "Authorization: Bearer $TOKEN"        # the current standard's package
curl -s ${v1}/rounds/$RID/compare/$OTHER_RID -H "Authorization: Bearer $TOKEN"
\`\`\`

The bundle ships rubric.md, the golden set, the judge prompt, panel.json
with edit provenance, a rerun script, round cost, a README, eval.json (the
manifest: standard version, the mixture that graded, pinned models, and a
hash of every file), and a SHA-256 hash per artifact. The zip forms carry
the same files byte for byte; eval.zip picks the round the current standard
stands on. Bundles without a pinned model map are refused rather than
shipped.

### 10. Training data

The project's judgment as rows, with provenance on every one: the case, the
judge, the model id, and the version of the standard it was scored under.
Built from every finished round. Four files: examples (settled cases,
chat-shaped), gold (the owner's adjudications), rewards (one row per judge
per case, scored on the standard's scale), and pairs (prompt, chosen,
rejected: the rows preference post-training reads).

#### Preference pairs

Pose two answers to one prompt. Every seat compares them in both orders,
so a seat whose choice flips when A and B swap places is set aside as
position bias rather than counted. The owner's own pick sits beside the
panel's and outranks it in the export. Pairs are also derived, without
asking, from two graded transcripts that share a prompt and landed on
different levels of the scale.

\`\`\`bash
curl -s -X POST ${v1}/projects/$SLUG/pairs -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"title":"Refund over the cap, two ways","prompt":"USER: refund my $90 order.","a":"Done, refunded.","b":"That needs approval; I have opened the request."}'
curl -s -X POST ${v1}/projects/$SLUG/pairs/$PAIR/grade -H "Authorization: Bearer $TOKEN"     # every seat, both orders
curl -s -X PATCH ${v1}/projects/$SLUG/pairs/$PAIR/verdict -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"choice":"b","reason":"Over the cap needs approval."}'
curl -s ${v1}/projects/$SLUG/pairs -H "Authorization: Bearer $TOKEN"
curl -s "${v1}/projects/$SLUG/training?format=pairs" -H "Authorization: Bearer $TOKEN"     # pairs.jsonl
\`\`\`

\`\`\`bash
curl -s ${v1}/projects/$SLUG/training -H "Authorization: Bearer $TOKEN"           # counts + all three sets
curl -s "${v1}/projects/$SLUG/training?format=examples" -H "Authorization: Bearer $TOKEN" > examples.jsonl
curl -s "${v1}/projects/$SLUG/training?format=gold"     -H "Authorization: Bearer $TOKEN" > gold.jsonl
curl -s "${v1}/projects/$SLUG/training?format=rewards"  -H "Authorization: Bearer $TOKEN" > rewards.jsonl
\`\`\`

- \`examples\`: settled cases with the panel's verdict and majority rationale,
  chat-shaped (\`messages\`) for fine-tuning. Cases the owner overruled are
  excluded; unsettled cases never appear.
- \`gold\`: the owner's adjudications, with the panel's verdict beside each.
- \`rewards\`: one row per judge per case, the verdict as a 0..1 score on the
  standard's own scale, with the case's pattern attached for filtering.

## Runs: the eval from CI

A run grades a case set you supply against one pinned version of the
standard, through the same seats and the same stability pass, and reports
the ensemble verdict per case, the pass rate, the splits, the diff against
the previous run of that standard, and a gate. The CLI drives the whole
sequence and exits 1 when the gate fails:

\`\`\`bash
npm run evallab -- run --base ${base} --project $SLUG --token $TOKEN \\
  --cases cases.jsonl --standards 2 --gate pass-rate:0.9,new-splits:0
\`\`\`

By hand, the same thing is four calls:

\`\`\`bash
RUN=$(curl -s -X POST ${v1}/projects/$SLUG/runs -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"cases":[{"title":"Refund under the cap","content":"USER: … ASSISTANT: …","expected":"pass"}],
       "standards_version":2,"gate":{"pass_rate_min":0.9,"max_new_splits":0}}')
RID=$(echo "$RUN" | jq -r .run.roundId); RUN_ID=$(echo "$RUN" | jq -r .run.id)
for SEAT in $(echo "$RUN" | jq -r '.seats[].id'); do
  curl -s -X POST ${v1}/rounds/$RID/panel-run -H "Authorization: Bearer $TOKEN" \\
    -H 'content-type: application/json' -d "{\\"seatId\\":\\"$SEAT\\"}" > /dev/null
done
curl -s -X POST ${v1}/rounds/$RID/stability -H "Authorization: Bearer $TOKEN" > /dev/null
curl -s ${v1}/runs/$RUN_ID -H "Authorization: Bearer $TOKEN"
# -> { run, summary: { cases, pass_rate, splits, new_splits, unstable_votes, expected_match },
#      gate: { passed, reasons }, diff: { against, compared, flipped }, cases: [...] }
\`\`\`

Cases: 1 to 60 per run, each \`{ title, content, expected? }\`; \`expected\`
must be a verdict on the standard's scale. The ensemble verdict is the
weighted majority of the votes that survived paraphrase, ties to the lower
verdict. Runs match cases across runs by title. A GitHub Action that runs
this on every pull request is in \`docs/ci/evallab.yml\`.

### Drift: the runs as a series

The finished runs against one version of the standard, oldest first, with
pass rate, splits, new splits, and the cases that flipped verdict against
the run before. The report compares the latest run with the oldest inside
the window and says whether it moved. Thresholds are query fields; with
none set the report describes and never fails. Schedule \`evallab run\` and
then \`evallab drift\` (docs/ci/evallab.yml has the cron) and the build goes
red the morning the reading changes.

\`\`\`bash
curl -s "${v1}/projects/$SLUG/drift?window=5&pass_rate_drop=0.05&flips=0&new_splits=0" -H "Authorization: Bearer $TOKEN"
npm run evallab -- drift --project $SLUG --token $TOKEN --window 5 --gate pass-rate-drop:0.05,flips:0,new-splits:0   # exit 1 on drift
\`\`\`

## Health

\`\`\`bash
curl -s ${base}/api/health
# -> { "ok": true, "database": { "driver": "postgres", … } }
\`\`\`

\`ok\` is false when the deployment has no database, because nothing would
survive; the error names the fix.
`;
}
