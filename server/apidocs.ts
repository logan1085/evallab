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

Returns the project (its \`token\` is the master key), a first rubric version,
generated scenarios, and a seated panel.

\`\`\`bash
curl -s -X POST ${v1}/projects \\
  -H 'content-type: application/json' \\
  -d '{"name":"Acme Outdoor","description":"A support agent that answers billing questions and can refund up to $50 without approval."}'
# -> { "project": { "slug": "…", "token": "…" }, "rubric": …, "scenarioCount": 6, "seatCount": 6 }
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

### 4. The panel

Seated at creation; this endpoint is idempotent and never regenerates over
your edits. Seats can be added, edited (\`PATCH\`), and deleted; every edit is
recorded as signal.

\`\`\`bash
curl -s -X POST ${v1}/projects/$SLUG/panel -H "Authorization: Bearer $TOKEN"
curl -s ${v1}/projects/$SLUG/panel/archetypes -H "Authorization: Bearer $TOKEN"
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

With an OpenRouter key on the server the seats are real models on pinned
versions; per-request BYOK is accepted as \`x-openrouter-key\` and never stored.
With no key the run is a labeled simulation.

### 6. Read the disagreement map

\`\`\`bash
curl -s ${v1}/rounds/$RID/map -H "Authorization: Bearer $TOKEN"
\`\`\`

Settled, persona-driven, contested, and blind-spot cases; agreement (alpha
and AC1 with variance); per-seat weights and self-consistency; pinned models
and running cost.

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

### 9. Export

\`\`\`bash
curl -s ${v1}/rounds/$RID/bundle -H "Authorization: Bearer $TOKEN"
curl -s ${v1}/rounds/$RID/compare/$OTHER_RID -H "Authorization: Bearer $TOKEN"
\`\`\`

The bundle ships rubric.md, the golden set, the judge prompt, panel.json
with edit provenance, a rerun script, round cost, and a SHA-256 hash per
artifact. Bundles without a pinned model map are refused rather than shipped.

## Health

\`\`\`bash
curl -s ${base}/api/health
# -> { "ok": true, "database": { "driver": "postgres", … } }
\`\`\`

\`ok\` is false when the deployment has no database, because nothing would
survive; the error names the fix.
`;
}
