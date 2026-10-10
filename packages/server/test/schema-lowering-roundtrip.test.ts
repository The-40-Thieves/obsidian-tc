// Round trip. The invariants the lowering pass keeps, for every registered tool, checked with the
// SDK's own validator (what a client runs):
//   OUTPUTS: everything the server emits validates against the advertised schema (an instance valid
//     for the ORIGINAL zod schema validates against the lowered one). An output whose root cannot
//     honestly be `type: object` (z.unknown()) is not advertised at all, so it is not round-tripped.
//   INPUTS: the advertised schema may be NARROWER in exactly one way - an explicit `null` for a
//     nullable optional field is not advertised (the server's zod still accepts it) - and may be WIDER
//     where a constraint was dropped (restated in the description; zod still enforces it). The test
//     "the explicit null on an optional field is the ONLY input narrowing" pins the first half.
// The instances come from a small generator over the original JSON Schema: a minimal one (required
// keys only, first branch) and a maximal one (every key, last branch, so a nullable output field
// carries its `null`). Dispatch itself keeps validating with the zod original.

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { JSON_SCHEMA_OPTS, toInputJson, toJson } from "../src/mcp/facade";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const CANDIDATES = ["a", "0", "a".repeat(32), "obs_1", "2026-01-01", "2026-01-01T00:00:00Z", ""];

function sampleString(s: Json): string {
  const min = typeof s.minLength === "number" ? s.minLength : 0;
  const max = typeof s.maxLength === "number" ? s.maxLength : Number.POSITIVE_INFINITY;
  if (s.format === "date-time") return "2026-01-01T00:00:00Z";
  const fits = (c: string) => c.length >= min && c.length <= max;
  const re = typeof s.pattern === "string" ? new RegExp(s.pattern) : undefined;
  const pick = CANDIDATES.find((c) => fits(c) && (re === undefined || re.test(c)));
  if (pick !== undefined) return re === undefined && min === 0 ? "a" : pick;
  return "a".repeat(Math.min(Math.max(min, 1), max));
}

function sampleNumber(s: Json): number {
  const lo = typeof s.minimum === "number" ? s.minimum : undefined;
  const exLo = typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum : undefined;
  const hi = typeof s.maximum === "number" ? s.maximum : undefined;
  if (exLo !== undefined) return exLo + 1;
  if (lo !== undefined) return lo;
  return hi !== undefined && hi < 0 ? hi : 0;
}

// The one deliberate narrowing: an INPUT no longer advertises a `null` branch (a nullable optional
// field is advertised as just optional), so the "input" witnesses never pick `null`. The
// "input-nulls" mode picks it everywhere it is allowed; the named narrowing test below accounts for
// every witness that mode makes the lowered schema reject.
type Mode = "input" | "output" | "input-nulls";
function sample(s: unknown, maximal: boolean, role: Mode): unknown {
  if (!isObj(s)) return {};
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[maximal ? s.enum.length - 1 : 0];
  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(union)) {
    const isNull = (b: unknown) => isObj(b) && b.type === "null";
    const nonNull = union.filter((b) => !isNull(b));
    if (role === "input-nulls" && nonNull.length !== union.length) return null;
    const branches =
      maximal && role === "output"
        ? [...union].reverse()
        : [...(maximal ? nonNull.reverse() : nonNull)];
    return sample(branches[0], maximal, role);
  }
  const type = Array.isArray(s.type) ? s.type[maximal ? s.type.length - 1 : 0] : s.type;
  switch (type) {
    case "string":
      return sampleString(s);
    case "integer":
    case "number":
      return sampleNumber(s);
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const n = typeof s.minItems === "number" ? s.minItems : maximal ? 1 : 0;
      return Array.from({ length: n }, () => sample(s.items, maximal, role));
    }
    default: {
      const props = isObj(s.properties) ? s.properties : {};
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const out: Json = {};
      for (const [k, v] of Object.entries(props))
        if (maximal || required.has(k)) out[k] = sample(v, maximal, role);
      return out;
    }
  }
}

/** Root `anyOf` yields one instance per branch, so every arm of a union output is exercised. */
function instances(root: Json, role: Mode): unknown[] {
  const branches = Array.isArray(root.anyOf) ? (root.anyOf as unknown[]) : [root];
  return branches.flatMap((b) => [sample(b, false, role), sample(b, true, role)]);
}

const validatorFor = (schema: unknown) =>
  new AjvJsonSchemaValidator().getValidator(schema as never);

interface Tally {
  checked: number;
  skipped: string[];
}

function roundTrip(
  name: string,
  original: Json,
  lowered: unknown,
  zodSchema: z.ZodType,
  role: Mode,
  tally: Tally,
  failures: string[],
): void {
  const originalOk = validatorFor(original);
  const loweredOk = validatorFor(lowered);
  let usable = 0;
  for (const inst of instances(original, role)) {
    // Only an instance both the original JSON Schema and the zod parse accept is a fair witness.
    if (!originalOk(inst).valid || !zodSchema.safeParse(inst).success) continue;
    usable++;
    tally.checked++;
    const verdict = loweredOk(inst);
    if (!verdict.valid)
      failures.push(`${name}: ${verdict.errorMessage} for ${JSON.stringify(inst).slice(0, 160)}`);
  }
  if (usable === 0) tally.skipped.push(name);
}

describe("lowering round trip: outputs always validate, inputs narrow only on an explicit null", () => {
  const defs = buildFullRegistry().list();

  it("inputs, every registered tool", () => {
    expect(defs.length).toBeGreaterThan(150);
    const tally: Tally = { checked: 0, skipped: [] };
    const failures: string[] = [];
    for (const def of defs) {
      const original = z.toJSONSchema(def.inputSchema, {
        ...JSON_SCHEMA_OPTS,
        io: "input",
      }) as Json;
      roundTrip(
        `${def.name}/input`,
        original,
        toInputJson(def.inputSchema),
        def.inputSchema,
        "input",
        tally,
        failures,
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
    // Existence floor: the generator must actually witness most tools, or this proves nothing.
    expect(tally.checked).toBeGreaterThan(defs.length);
    expect(tally.skipped.length, `no witness for: ${tally.skipped.join(", ")}`).toBeLessThan(
      defs.length * 0.1,
    );
  }, 60_000);

  it("outputs, every registered tool that declares one (union arms included)", () => {
    const withOutput = defs.filter((d) => d.outputSchema && toJson(d.outputSchema) !== undefined);
    expect(withOutput.length).toBeGreaterThan(150);
    const tally: Tally = { checked: 0, skipped: [] };
    const failures: string[] = [];
    for (const def of withOutput) {
      const zodOut = def.outputSchema as z.ZodType;
      const original = z.toJSONSchema(zodOut, JSON_SCHEMA_OPTS) as Json;
      roundTrip(`${def.name}/output`, original, toJson(zodOut), zodOut, "output", tally, failures);
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(tally.checked).toBeGreaterThan(withOutput.length);
    expect(tally.skipped.length, `no witness for: ${tally.skipped.join(", ")}`).toBeLessThan(
      withOutput.length * 0.1,
    );
  }, 60_000);

  it("the server still accepts the explicit null an input no longer advertises", () => {
    const def = defs.find((d) => d.name === "vault_graph_search");
    if (!def) throw new Error("fixture: vault_graph_search is not registered");
    const base = { vault: "t", query: "q" };
    expect(def.inputSchema.safeParse({ ...base, hypothetical_answer: null }).success).toBe(true);
    const advertised = JSON.stringify((toInputJson(def.inputSchema) as Json).properties);
    expect(advertised).not.toContain('"null"');
  });

  it("the explicit null on an optional field is the ONLY input narrowing", () => {
    // Witnesses that pick `null` wherever the original schema allows it. Every one the lowered
    // schema rejects must (a) be rejected only because of null-valued OBJECT KEYS and (b) stay valid
    // for the original once those keys are removed - i.e. the null sat on an optional field.
    const stripNullKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(stripNullKeys)
        : isObj(v)
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([, x]) => x !== null)
                .map(([k, x]) => [k, stripNullKeys(x)]),
            )
          : v;
    const narrowed = new Set<string>();
    const unexplained: string[] = [];
    for (const def of defs) {
      const original = z.toJSONSchema(def.inputSchema, {
        ...JSON_SCHEMA_OPTS,
        io: "input",
      }) as Json;
      const originalOk = validatorFor(original);
      const loweredOk = validatorFor(toInputJson(def.inputSchema));
      for (const inst of instances(original, "input-nulls")) {
        if (!originalOk(inst).valid || !def.inputSchema.safeParse(inst).success) continue;
        if (loweredOk(inst).valid) continue;
        const stripped = stripNullKeys(inst);
        const explained = loweredOk(stripped).valid && def.inputSchema.safeParse(stripped).success;
        if (explained) narrowed.add(def.name);
        else unexplained.push(`${def.name}: ${JSON.stringify(inst).slice(0, 160)}`);
      }
    }
    expect(unexplained, unexplained.join("\n")).toEqual([]);
    // Existence floor: the known narrowing is witnessed, so this cannot pass by generating no nulls.
    expect([...narrowed]).toContain("vault_graph_search");
    expect(narrowed.size).toBeGreaterThan(0);
  }, 60_000);

  it("the advertised input still constrains: {} is rejected wherever a key is still required", () => {
    let constrained = 0;
    for (const def of defs) {
      const lowered = toInputJson(def.inputSchema) as Json;
      if (!Array.isArray(lowered.required) || lowered.required.length === 0) continue;
      constrained++;
      expect(validatorFor(lowered)({}).valid, def.name).toBe(false);
    }
    expect(constrained).toBeGreaterThan(100);
  }, 60_000);

  it("is idempotent: lowering an already-lowered schema changes nothing", async () => {
    const { lowerSchema } = await import("../src/mcp/schema-lowering");
    for (const def of defs) {
      const once = toInputJson(def.inputSchema);
      expect(lowerSchema(once, "input"), def.name).toEqual(once);
      if (def.outputSchema) {
        const out = toJson(def.outputSchema);
        if (out !== undefined) expect(lowerSchema(out, "output"), def.name).toEqual(out);
      }
    }
  }, 60_000);
});
