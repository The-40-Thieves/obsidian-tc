// A minimal-instance generator for the JSON Schemas `toJson()` emits (2020-12, reused subschemas
// inlined). It exists so a test can push a schema-VALID payload for every registered tool through
// the result builder without running 180 real handlers. Callers validate the sample with the SDK's
// own ajv validator, so an exotic constraint this does not model fails loudly there, by tool name.
type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);

function sampleString(s: Schema): string {
  const min = typeof s.minLength === "number" ? s.minLength : 0;
  const base = typeof s.pattern === "string" ? "a" : "x";
  const format = s.format;
  if (format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (format === "date") return "2026-01-01";
  if (format === "uri" || format === "url") return "https://example.com/x";
  if (format === "email") return "a@example.com";
  if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
  return base.repeat(Math.max(min, 1));
}

function sampleNumber(s: Schema, integer: boolean): number {
  const lo = typeof s.minimum === "number" ? s.minimum : undefined;
  const xlo = typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum + 1 : undefined;
  const base = lo ?? xlo ?? 0;
  const hi = typeof s.maximum === "number" ? s.maximum : undefined;
  const n = hi !== undefined && base > hi ? hi : base;
  return integer ? Math.ceil(n) : n;
}

export function sampleFromJsonSchema(schema: unknown): unknown {
  if (schema === true || !isObj(schema)) return {};
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const alt = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(alt) && alt.length > 0) {
    // Prefer a non-null branch: a sample of `null` for `T | null` proves the least.
    const pick = alt.find((a) => !(isObj(a) && a.type === "null")) ?? alt[0];
    return sampleFromJsonSchema(pick);
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((a) => sampleFromJsonSchema(a)));
  }
  const type = Array.isArray(schema.type)
    ? ((schema.type as string[]).find((t) => t !== "null") ?? "null")
    : schema.type;
  switch (type) {
    case "string":
      return sampleString(schema);
    case "integer":
      return sampleNumber(schema, true);
    case "number":
      return sampleNumber(schema, false);
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const n = typeof schema.minItems === "number" ? schema.minItems : 0;
      return Array.from({ length: n }, () => sampleFromJsonSchema(schema.items));
    }
    default: {
      const props = isObj(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const out: Record<string, unknown> = {};
      for (const key of required)
        out[key] = sampleFromJsonSchema(props[key] ?? schema.additionalProperties);
      // An enum-keyed record (z.record(z.enum([...]), T)) lists its keys under propertyNames.
      const names = isObj(schema.propertyNames) ? schema.propertyNames.enum : undefined;
      if (Array.isArray(names)) {
        for (const key of names as string[])
          out[key] ??= sampleFromJsonSchema(schema.additionalProperties);
      }
      return out;
    }
  }
}
