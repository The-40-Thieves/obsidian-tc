// THE-513 Part 2 guarantee test: `extractIdempotencyKey` (mcp/registry.ts) sniffs the input SHAPE
// at runtime for every one of the ~150 tools — a top-level `idempotency_key`, the
// `bulk_idempotency_key` alias, or a nested `options.idempotency_key` — but before this gate
// nothing declared which capabilities actually expose one of those. A capability that SHOULD be
// idempotent and isn't (or a stale declaration nobody actually reads at runtime) was invisible.
//
// This is a BIDIRECTIONAL cross-check, not a one-way coverage count — the precedent
// (output-schema-coverage.test.ts) only had to prove "declared", never "declared AND consistent
// with what the runtime path actually reads". A tool declaring `acceptsIdempotencyKey: true` whose
// schema exposes none of the three recognized shapes is just as wrong as one whose schema exposes
// one but doesn't declare it — both directions are asserted here.
//
// Registry assembly reuses buildFullRegistry() rather than re-assembling the M1-M8 registration
// recipe by hand (see output-schema-coverage.test.ts, which found that recipe copied a third time
// with only one copy read by the version gate).
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { topLevelShape } from "./schema-introspect";

/** Mirrors extractIdempotencyKey's three recognized shapes, structurally rather than by parsing a
 *  value: a top-level `idempotency_key` or `bulk_idempotency_key` field, or a nested `options`
 *  object whose own shape has `idempotency_key`. Field TYPE is not checked (extractIdempotencyKey
 *  itself only cares whether the parsed value is a non-empty string at runtime) — this is a
 *  structural "is the key name present" probe, not a value-level one. */
function schemaExposesIdempotencyKey(inputSchema: unknown): boolean {
  const shape = topLevelShape(inputSchema);
  if (!shape) return false;
  if ("idempotency_key" in shape || "bulk_idempotency_key" in shape) return true;
  const optionsShape = topLevelShape(shape.options);
  return optionsShape != null && "idempotency_key" in optionsShape;
}

describe("THE-513 Part 2: idempotency declaration coverage", () => {
  const registered = buildFullRegistry().list();

  // A truncated/empty registry would make both directions below pass vacuously.
  it("checked a non-empty registry, so coverage is not vacuous", () => {
    expect(registered.length).toBeGreaterThan(100);
  });

  it("every tool whose schema exposes an idempotency key declares acceptsIdempotencyKey", () => {
    const undeclared = registered
      .filter((t) => schemaExposesIdempotencyKey(t.inputSchema) && t.acceptsIdempotencyKey !== true)
      .map((t) => t.name)
      .sort();
    expect(
      undeclared,
      `tool(s) whose input schema accepts an idempotency key but don't declare it: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("every tool that declares acceptsIdempotencyKey has a schema that actually exposes one", () => {
    const overclaimed = registered
      .filter(
        (t) => t.acceptsIdempotencyKey === true && !schemaExposesIdempotencyKey(t.inputSchema),
      )
      .map((t) => t.name)
      .sort();
    expect(
      overclaimed,
      `tool(s) declaring acceptsIdempotencyKey but whose schema exposes no recognized key: ${overclaimed.join(", ")}`,
    ).toEqual([]);
  });

  it("re-derives the known 14-tool idempotency surface (THE-513 Part 2)", () => {
    // Named explicitly (not just counted) so a future addition/removal is visible in the diff
    // rather than as a bare number change — the same reasoning as REGISTERED_TOOL_COUNT.
    const expected = [
      "add_observation",
      "append_note",
      "append_to_periodic_note",
      "bulk_create_notes",
      "bulk_move_notes",
      "copy_note",
      "create_base",
      "create_canvas",
      "create_periodic_note",
      "enqueue_capture",
      "move_attachment",
      "move_note",
      "start_session",
      "write_note",
    ];
    const actual = registered
      .filter((t) => schemaExposesIdempotencyKey(t.inputSchema))
      .map((t) => t.name)
      .sort();
    expect(actual).toEqual(expected);
  });
});
