// Strict tool use (`strict: true`) accepts only a subset of JSON Schema:
// basic types, enum, const, anyOf, allOf, $ref, a few string formats, and
// additionalProperties: false. Length, range, and item-count constraints are
// rejected with a 400. Zod emits all of those, so we strip them from the
// schema sent to the API. The Zod schema itself still validates tool inputs
// client-side before `run` is called, so nothing is lost.

const UNSUPPORTED_KEYWORDS = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "uniqueItems",
  "$schema",
]);

export function toStrictSchema<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map(toStrictSchema) as T;
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    // Strict mode lists anyOf but not oneOf; for a discriminated union the
    // branches are mutually exclusive anyway, so the meaning is unchanged.
    out[key === "oneOf" ? "anyOf" : key] = toStrictSchema(value);
  }
  return out as T;
}
