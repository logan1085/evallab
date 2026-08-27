/**
 * The strict structured-output subset, as a rule you can check.
 *
 * Every creator call sends `response_format: json_schema` with `strict: true`,
 * and strict mode accepts only a subset of JSON Schema. Send a keyword outside
 * it and the router answers 400 before a model ever sees the request. That is
 * a whole class of outage that is invisible in review, because the schema
 * reads perfectly well as JSON Schema.
 *
 * Two rules bite in practice:
 *
 *   1. Size and format keywords are not supported. minItems, maxItems,
 *      minLength, pattern and friends are all rejected. Bounds belong in the
 *      prompt (which asks for a count) and in the normalizer (which clamps
 *      what comes back), never in a strict schema.
 *   2. Every object must set additionalProperties: false and must list every
 *      one of its properties in `required`. Optionality is expressed by
 *      allowing null in the type, not by leaving a key out.
 *
 * So this is checked rather than remembered: a schema that would 400 fails a
 * test here instead of in production.
 */

/** Keywords strict mode rejects outright. */
const UNSUPPORTED = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'minContains',
  'maxContains',
  'default',
] as const;

type Node = Record<string, unknown>;

const isObjectNode = (node: Node): boolean => {
  const type = node.type;
  return type === 'object' || (Array.isArray(type) && type.includes('object'));
};

/**
 * Every reason the given schema would be rejected, each naming its path.
 * An empty array means the schema is safe to send with strict: true.
 */
export function strictSchemaProblems(schema: unknown, path = '#'): string[] {
  if (typeof schema !== 'object' || schema === null) return [`${path}: not a schema object`];
  const node = schema as Node;
  const problems: string[] = [];

  for (const keyword of UNSUPPORTED) {
    if (keyword in node) problems.push(`${path}: "${keyword}" is not supported under strict`);
  }

  if (isObjectNode(node)) {
    if (node.additionalProperties !== false) {
      problems.push(`${path}: objects must set additionalProperties: false`);
    }
    const properties = (node.properties ?? {}) as Node;
    const names = Object.keys(properties);
    const required = Array.isArray(node.required) ? (node.required as string[]) : [];
    const missing = names.filter((n) => !required.includes(n));
    if (missing.length > 0) {
      // Strict has no optional keys: a field that may be absent is expressed
      // as a nullable type instead.
      problems.push(`${path}: every property must be required, missing ${missing.join(', ')}`);
    }
    for (const name of names) {
      problems.push(...strictSchemaProblems(properties[name], `${path}/${name}`));
    }
  }

  if (node.items !== undefined) problems.push(...strictSchemaProblems(node.items, `${path}[]`));

  return problems;
}

/** Throws with every problem at once, so one round trip fixes the schema. */
export function assertStrictSchema(schema: unknown, name: string): void {
  const problems = strictSchemaProblems(schema);
  if (problems.length > 0) {
    throw new Error(`The ${name} schema would be rejected by strict structured outputs:\n  ${problems.join('\n  ')}`);
  }
}
