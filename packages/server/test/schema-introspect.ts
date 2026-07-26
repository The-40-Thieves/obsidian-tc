// THE-513 Part 2: shared Zod v4 introspection for the two new declaration-coverage gates
// (idempotency-declaration-coverage.test.ts, vault-arg-coverage.test.ts). Both need to answer a
// structural question about a tool's static inputSchema — "does this expose field X (possibly
// through a default/optional/prefault wrapper)?" — without invoking the schema.
//
// Mirrors scripts/docgen/extract-config.ts's local ZDef/ZSchema/unwrap (Zod v4: every schema
// carries `.def.type`; wrappers carry `.def.innerType`; ZodObject carries `.shape`). Kept local
// and loose, same reasoning as that file: a Zod point-release changing internals degrades to
// "field not found" rather than throwing.
interface ZDef {
  type: string;
  innerType?: ZSchema;
}
interface ZSchema {
  def: ZDef;
  shape?: Record<string, ZSchema>;
}

/** Peel optional/nullable/default/prefault wrappers off `schema` down to its leaf. `undefined`
 *  (a field that isn't present at all — e.g. probing a tool with no `options` field) passes
 *  through rather than throwing, so callers can probe absent fields unconditionally. */
export function unwrapSchema(schema: unknown): ZSchema | undefined {
  if (schema === undefined) return undefined;
  let s = schema as ZSchema;
  for (let guard = 0; guard < 8; guard++) {
    const t = s.def?.type;
    if (
      (t === "optional" || t === "nullable" || t === "default" || t === "prefault") &&
      s.def.innerType
    ) {
      s = s.def.innerType;
    } else {
      break;
    }
  }
  return s;
}

/** The top-level shape of an object schema (after unwrapping), or undefined for a non-object
 *  (or unrecognized) schema. */
export function topLevelShape(schema: unknown): Record<string, ZSchema> | undefined {
  return unwrapSchema(schema)?.shape;
}

/** True when `schema`'s top level (after unwrapping) has a field named `key` whose own
 *  (unwrapped) schema is reference-identical to `expected` — the same "same shared Zod primitive
 *  instance" test used to identify a vault-shaped field, since every tool imports the one exported
 *  `VaultId` from @the-40-thieves/obsidian-tc-shared rather than redeclaring it. */
export function fieldIs(
  shape: Record<string, ZSchema> | undefined,
  key: string,
  expected: unknown,
): boolean {
  const field = shape?.[key];
  if (!field) return false;
  return unwrapSchema(field) === (expected as ZSchema);
}
