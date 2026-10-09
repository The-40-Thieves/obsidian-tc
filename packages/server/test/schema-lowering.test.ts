// One test per construct the lowering pass rewrites (src/mcp/schema-lowering.ts). Each pins the
// rewrite, that the original is untouched, and - where a constraint is dropped - that an INPUT
// description says so while an OUTPUT description and an untouched description stay byte-identical.

import { describe, expect, it } from "vitest";
import { type LoweringReport, lowerSchema } from "../src/mcp/schema-lowering";
import { portabilityViolations } from "./schema-portability-rules";

const S2020 = "https://json-schema.org/draft/2020-12/schema";
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  $schema: S2020,
  type: "object",
  properties,
  ...extra,
});
const prop = (schema: unknown, key = "x", role: "input" | "output" = "input") =>
  (lowerSchema(schema as object, role) as { properties: Record<string, any> }).properties[key];

describe("lowerSchema", () => {
  it("inlines $ref/$defs and removes $defs", () => {
    const input = obj(
      { a: { $ref: "#/$defs/Tag" }, b: { $ref: "#/$defs/Tag", description: "second" } },
      { $defs: { Tag: { type: "string", minLength: 1 } } },
    );
    const snapshot = structuredClone(input);
    const out = lowerSchema(input, "input") as any;
    expect(out.$defs).toBeUndefined();
    expect(out.properties.a).toEqual({ type: "string", minLength: 1 });
    expect(out.properties.b).toEqual({ type: "string", minLength: 1, description: "second" });
    expect(input).toEqual(snapshot);
    expect(portabilityViolations(out, "input")).toEqual([]);
  });

  it("replaces a recursive $ref with a permissive object and says so on an input", () => {
    const tree = {
      $schema: S2020,
      type: "object",
      properties: { children: { type: "array", items: { $ref: "#" } } },
    };
    const report: LoweringReport = {};
    const out = lowerSchema(tree, "input", report) as any;
    expect(out.properties.children.items.type).toBe("object");
    expect(out.properties.children.items.description).toMatch(/not described/);
    expect(report["ref-recursive"]).toBe(1);
    const viaDefs = lowerSchema(
      obj(
        { n: { $ref: "#/$defs/Node" } },
        { $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } } },
      ),
      "output",
    ) as any;
    expect(viaDefs.properties.n.properties.next).toEqual({ type: "object" });
  });

  it("turns a type array into an anyOf of single types, siblings kept with their own type", () => {
    const out = prop(
      obj({ x: { type: ["string", "null"], minLength: 2, description: "d" } }),
      "x",
      "output",
    );
    expect(out).toEqual({
      anyOf: [{ type: "string", minLength: 2, description: "d" }, { type: "null" }],
    });
  });

  it("drops the null branch on an INPUT (the field is optional) and keeps it on an OUTPUT", () => {
    const nullable = {
      anyOf: [{ type: "string", maxLength: 9 }, { type: "null" }],
      description: "d",
    };
    expect(prop(obj({ x: nullable }))).toEqual({ type: "string", maxLength: 9, description: "d" });
    const o = prop(obj({ x: nullable }), "x", "output");
    expect(o.anyOf).toHaveLength(2);
    expect(o.anyOf[0]).toEqual({ type: "string", maxLength: 9, description: "d" });
  });

  it("moves a description beside anyOf onto its first branch and drops other siblings", () => {
    const out = prop(
      obj({
        x: { anyOf: [{ type: "boolean" }, { type: "string" }], description: "d", default: true },
      }),
    );
    expect(out).toEqual({ anyOf: [{ type: "boolean", description: "d" }, { type: "string" }] });
  });

  it("string const becomes a one-value enum", () => {
    expect(prop(obj({ x: { type: "string", const: "heading" } }))).toEqual({
      type: "string",
      enum: ["heading"],
    });
  });

  it("non-string const is dropped, and an input description keeps the value", () => {
    expect(prop(obj({ x: { type: "boolean", const: true, description: "ok" } }))).toEqual({
      type: "boolean",
      description: "ok Must be true.",
    });
    expect(
      prop(obj({ x: { type: "boolean", const: true, description: "ok" } }), "x", "output"),
    ).toEqual({
      type: "boolean",
      description: "ok",
    });
  });

  it("collapses an anyOf of same-type consts into one enum", () => {
    const strings = prop(
      obj({
        x: {
          anyOf: [
            { type: "string", const: "a" },
            { type: "string", const: "b" },
          ],
        },
      }),
    );
    expect(strings).toEqual({ type: "string", enum: ["a", "b"] });
    const numbers = prop(
      obj({
        x: {
          anyOf: [-1, 0, 1].map((n) => ({ type: "number", const: n })),
          description: "-1 bad, +1 good.",
        },
      }),
    );
    expect(numbers).toEqual({
      type: "number",
      minimum: -1,
      maximum: 1,
      description: "-1 bad, +1 good. Allowed values: -1, 0, 1.",
    });
  });

  it("leaves a string enum alone and drops a non-string one, naming the values on an input", () => {
    expect(prop(obj({ x: { type: "string", enum: ["a", "b"], description: "d" } }))).toEqual({
      type: "string",
      enum: ["a", "b"],
      description: "d",
    });
    expect(prop(obj({ x: { type: "integer", enum: [1, 2, 3] } }))).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 3,
      description: "Allowed values: 1, 2, 3.",
    });
  });

  it("rewrites oneOf to anyOf", () => {
    const out = prop(obj({ x: { oneOf: [{ type: "string" }, { type: "number" }] } }));
    expect(out).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("folds a discriminated union of objects into one object and keeps the field description", () => {
    const branch = (kind: string, extra: Record<string, unknown>) => ({
      type: "object",
      properties: { type: { type: "string", const: kind }, ...extra },
      required: ["type"],
      additionalProperties: false,
    });
    const out = prop(
      obj({
        x: {
          description: "Where to act.",
          oneOf: [
            branch("heading", { heading: { type: "string" } }),
            branch("block", { block_id: { type: "string" } }),
          ],
        },
      }),
    );
    expect(out.description).toBe("Where to act.");
    expect(out.anyOf).toBeUndefined();
    expect(out.properties.type).toEqual({ type: "string", enum: ["heading", "block"] });
    expect(Object.keys(out.properties).sort()).toEqual(["block_id", "heading", "type"]);
    expect(out.required).toEqual(["type"]);
    expect(out.additionalProperties).toBe(false);
  });

  it("merges allOf of objects", () => {
    const out = prop(
      obj({
        x: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
          ],
        },
      }),
    );
    expect(out).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    });
  });

  it("integer exclusiveMinimum/Maximum become minimum/maximum (+1 / -1)", () => {
    expect(prop(obj({ x: { type: "integer", exclusiveMinimum: 0 } }))).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(prop(obj({ x: { type: "integer", exclusiveMaximum: 10, minimum: 2 } }))).toEqual({
      type: "integer",
      minimum: 2,
      maximum: 9,
    });
    expect(prop(obj({ x: { type: "integer", exclusiveMinimum: 3, minimum: 5 } }))).toEqual({
      type: "integer",
      minimum: 5,
    });
  });

  it("a non-integer exclusive bound cannot be expressed: dropped, and an input says so", () => {
    expect(prop(obj({ x: { type: "number", exclusiveMinimum: 0, description: "w" } }))).toEqual({
      type: "number",
      description: "w Must be greater than 0.",
    });
    expect(prop(obj({ x: { type: "number", exclusiveMaximum: 1 } }), "x", "output")).toEqual({
      type: "number",
    });
  });

  it("drops a regex lookaround pattern (server-side zod still validates) and keeps a plain one", () => {
    expect(prop(obj({ x: { type: "string", pattern: "^(?=.*a).+$" } }))).toEqual({
      type: "string",
      description: "Must match the regular expression ^(?=.*a).+$",
    });
    expect(prop(obj({ x: { type: "string", pattern: "^(?<!x)a$" } }), "x", "output")).toEqual({
      type: "string",
    });
    expect(prop(obj({ x: { type: "string", pattern: "^(?:a|b)+$" } }))).toEqual({
      type: "string",
      pattern: "^(?:a|b)+$",
    });
  });

  it("restricts format to the OpenAI list", () => {
    expect(prop(obj({ x: { type: "string", format: "date-time" } })).format).toBe("date-time");
    expect(prop(obj({ x: { type: "string", format: "uri" } }))).toEqual({
      type: "string",
      description: "Format: uri.",
    });
  });

  it("adds items to an array without them", () => {
    expect(prop(obj({ x: { type: "array" } }))).toEqual({ type: "array", items: {} });
    expect(
      prop(obj({ x: { type: "array", prefixItems: [{ type: "string" }] } })).prefixItems,
    ).toBeUndefined();
  });

  it("drops propertyNames and additionalProperties inside an anyOf branch", () => {
    const out = prop(
      obj({
        x: {
          anyOf: [
            { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
            { type: "string" },
          ],
        },
      }),
    );
    expect(out.anyOf[0]).toEqual({ type: "object" });
    expect(
      prop(
        obj({ x: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} } }),
      ),
    ).toEqual({
      type: "object",
      additionalProperties: {},
    });
  });

  it("turns a boolean sub-schema into an empty schema", () => {
    expect(prop(obj({ x: true }))).toEqual({});
  });

  it("keeps description text byte-identical when nothing was dropped", () => {
    const schema = obj({
      x: { type: "string", description: "Vault id. May be omitted.", minLength: 1 },
    });
    expect(prop(schema)).toEqual({
      type: "string",
      description: "Vault id. May be omitted.",
      minLength: 1,
    });
  });

  describe("root", () => {
    it("folds a root anyOf of objects into one object (properties unioned, required intersected)", () => {
      const out = lowerSchema(
        {
          $schema: S2020,
          anyOf: [
            {
              type: "object",
              properties: { ok: { type: "boolean", const: true }, data: { type: "string" } },
              required: ["ok", "data"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                ok: { type: "boolean", const: false },
                error: { type: "string", enum: ["a"] },
              },
              required: ["ok", "error"],
              additionalProperties: false,
            },
          ],
        },
        "output",
      ) as any;
      expect(out.type).toBe("object");
      expect(out.anyOf).toBeUndefined();
      expect(Object.keys(out.properties).sort()).toEqual(["data", "error", "ok"]);
      expect(out.properties.ok).toEqual({ type: "boolean" });
      expect(out.required).toEqual(["ok"]);
      expect(out.additionalProperties).toBe(false);
      expect(portabilityViolations(out, "output")).toEqual([]);
    });

    it("gives a typeless root (z.unknown()) type: object", () => {
      expect(lowerSchema({ $schema: S2020 }, "output")).toEqual({ $schema: S2020, type: "object" });
    });

    it("stamps JSON Schema 2020-12 over a draft-07 $schema and adds none when absent", () => {
      const out = lowerSchema(
        { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
        "output",
      ) as any;
      expect(out.$schema).toBe(S2020);
      expect("$schema" in (lowerSchema({ type: "object" }, "output") as object)).toBe(false);
    });
  });

  it("reports which rewrites fired, so the portability gate can prove it saw real constructs", () => {
    const report: LoweringReport = {};
    lowerSchema(
      obj({ a: { type: "string", const: "x" }, b: { type: ["integer", "null"] } }),
      "output",
      report,
    );
    expect(report).toMatchObject({ "const-to-enum": 1, "type-array": 1 });
  });
});
