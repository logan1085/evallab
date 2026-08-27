/**
 * The creator calls, printed in full: the exact body that goes on the wire and
 * the exact answer that comes back.
 *
 * This exists because "the router returned 400" was all anyone could see when
 * scenario writing broke. Run it dry to inspect the request and prove the
 * schemas survive strict validation offline; run it live to put the same
 * bodies in front of the real router with your key.
 *
 *   npm run creator:smoke           # offline, strict validation, no network
 *   npm run creator:smoke -- --live # one real call per creator path
 */
import { callModel, routerErrorMessage, type GatewayTransport } from '../server/gateway.js';
import { CREATOR_PIN } from '../server/openrouter.js';
import { resolvePin } from '../server/pins.js';
import { strictSchemaProblems } from '../shared/schema.js';
import { buildScenarioSystemPrompt, buildScenarioUserPrompt, scenarioJsonSchema } from '../shared/scenarios.js';
import { buildPanelSystemPrompt, buildPanelUserPrompt, panelJsonSchema } from '../shared/panel.js';

const live = process.argv.includes('--live');
const DESCRIPTION = 'We sell outdoor gear online; our AI answers billing questions and can refund up to $50.';

const CALLS = [
  {
    name: 'scenario writer',
    system: buildScenarioSystemPrompt(),
    user: buildScenarioUserPrompt({ description: DESCRIPTION, count: 6 }),
    schema: scenarioJsonSchema(6),
    maxTokens: 8192,
  },
  {
    name: 'panel writer',
    system: buildPanelSystemPrompt(),
    user: buildPanelUserPrompt(DESCRIPTION, 5),
    schema: panelJsonSchema(5),
    maxTokens: 4096,
  },
];

/** Refuses exactly what OpenRouter refuses, so a dry run still catches a 400. */
const strictStandIn: GatewayTransport = {
  async post(body) {
    const sent = body as { response_format?: { json_schema?: { strict?: boolean; schema?: unknown } } };
    const format = sent.response_format?.json_schema;
    const problems = format?.strict ? strictSchemaProblems(format.schema) : [];
    if (problems.length > 0) {
      return { status: 400, json: { error: { message: 'Invalid schema for response_format', metadata: { raw: problems.join('; ') } } } };
    }
    return {
      status: 200,
      json: {
        id: 'gen-dry',
        choices: [{ message: { content: '{"scenarios":[],"seats":[]}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
      },
    };
  },
};

const pin = resolvePin(CREATOR_PIN);
console.log(`creator pin: ${pin.pin_id}`);
console.log(`model:       ${pin.openrouter_model_id}`);
console.log(`provider:    ${pin.provider_slug} (allow_fallbacks: false)`);
console.log(`mode:        ${live ? 'LIVE against openrouter.ai' : 'dry, strict stand-in'}\n`);

if (live && !process.env.OPENROUTER_API_KEY) {
  console.error('--live needs OPENROUTER_API_KEY in the environment.');
  process.exit(2);
}

let failed = 0;
for (const call of CALLS) {
  console.log(`--- ${call.name} ---`);

  const problems = strictSchemaProblems(call.schema);
  console.log(`schema: ${problems.length === 0 ? 'strict-clean' : `${problems.length} problem(s)`}`);
  for (const p of problems) console.log(`  ${p}`);

  const request = {
    pin_id: CREATOR_PIN,
    messages: [
      { role: 'system' as const, content: call.system },
      { role: 'user' as const, content: call.user },
    ],
    max_tokens: call.maxTokens,
    response_format: {
      type: 'json_schema' as const,
      json_schema: { name: 'result', strict: true, schema: call.schema },
    },
    caller: { kind: 'creator' as const },
  };

  // The body as it goes on the wire, messages elided so the schema is readable.
  console.log(
    'request:',
    JSON.stringify(
      {
        model: pin.openrouter_model_id,
        max_tokens: call.maxTokens,
        provider: { only: [pin.provider_slug], allow_fallbacks: false },
        response_format: request.response_format,
        messages: `[${request.messages.length} messages, ${call.system.length + call.user.length} chars]`,
      },
      null,
      2,
    ),
  );

  const result = await callModel(request, {
    ...(live ? {} : { apiKey: 'dry-run', transport: strictStandIn }),
  });

  if (result.error) {
    failed++;
    console.log(`FAIL ${result.error.kind}: ${result.error.message}`);
    if (result.raw && Object.keys(result.raw).length > 0) {
      console.log('router said:', routerErrorMessage(result.raw) || JSON.stringify(result.raw).slice(0, 400));
    }
  } else {
    console.log(`OK ${result.usage.total_tokens} tokens, ${result.usage.cost_credits} credits`);
    console.log(`reply: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`);
  }
  console.log();
}

console.log(`${CALLS.length - failed}/${CALLS.length} creator calls succeeded.`);
process.exit(failed > 0 ? 1 : 0);
