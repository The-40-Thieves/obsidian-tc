// Schema-portability gate. Every tool schema obsidian-tc ADVERTISES (tools/list in each facade mode
// and tool profile, plus describe_capability) must sit inside the subset the strictest MCP clients
// accept: OpenAI strict-mode shape, Gemini/Vertex/ADK's OpenAPI 3.0 subset, Copilot Studio, Cursor,
// Claude Desktop, and the 16 KiB per-tool cap. The rules and the incident behind each live in
// schema-portability-rules.ts; the first describe block pins each rule against the verbatim shape
// that broke a real client, so the gate cannot pass on shapes nobody hit.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import { describeCapability } from "../src/mcp/facade";
import type { CallerContext, ToolRegistry } from "../src/mcp/registry";
import type { SchemaRole } from "../src/mcp/schema-lowering";
import { createMcpServer } from "../src/mcp/server";
import { NON_CORE_TOOL_NAMES } from "../src/mcp/tool-profiles";
import { ALLOW_ALL } from "../src/mcp/visibility";
import {
  JSON_SCHEMA_2020_12,
  MAX_SCHEMA_BYTES,
  portabilityViolations,
  UNADVERTISED_OUTPUTS,
} from "./schema-portability-rules";

const OBJ = { type: "object" } as const;
const wrap = (properties: Record<string, unknown>) => ({ ...OBJ, properties });

describe("portability rules: each real client failure is a red case", () => {
  const red: [string, unknown, SchemaRole, RegExp][] = [
    ["Codex/Copilot Studio: $ref", wrap({ a: { $ref: "#/$defs/A" } }), "input", /"\$ref"/],
    ["$defs left behind", { ...OBJ, $defs: { A: { type: "string" } } }, "input", /"\$defs"/],
    [
      "Copilot Studio: type array",
      wrap({ a: { type: ["string", "null"] } }),
      "output",
      /"type" is an array/,
    ],
    [
      "Copilot Studio: integer exclusiveMinimum",
      wrap({ n: { type: "integer", exclusiveMinimum: 0 } }),
      "input",
      /exclusiveMinimum/,
    ],
    [
      "Cursor: outputSchema root not an object",
      { anyOf: [OBJ, OBJ] },
      "output",
      /root: type is undefined/,
    ],
    [
      "Cursor: root without a type",
      { $schema: JSON_SCHEMA_2020_12 },
      "output",
      /root: type is undefined/,
    ],
    ["Anthropic/OpenAI: root anyOf", { ...OBJ, anyOf: [OBJ, OBJ] }, "output", /root: has "anyOf"/],
    ["OpenAI: allOf", wrap({ a: { allOf: [OBJ] } }), "input", /"allOf"/],
    ["Gemini: const", wrap({ a: { type: "string", const: "x" } }), "input", /"const"/],
    ["Gemini: oneOf", wrap({ a: { oneOf: [OBJ, OBJ] } }), "input", /"oneOf"/],
    ["Gemini: array without items", wrap({ a: { type: "array" } }), "input", /without "items"/],
    [
      "adk-python #3401: non-string enum",
      wrap({ a: { type: "number", enum: [1, 2] } }),
      "input",
      /non-string enum/,
    ],
    [
      "adk-go #1659: anyOf with siblings",
      wrap({ a: { anyOf: [{ type: "string" }, OBJ], default: 1 } }),
      "input",
      /sibling keywords \(default\)/,
    ],
    [
      "mcp-atlassian #626: additionalProperties in anyOf",
      wrap({ a: { anyOf: [{ type: "object", additionalProperties: false }, { type: "string" }] } }),
      "input",
      /additionalProperties inside an anyOf/,
    ],
    [
      "OpenAI: lookahead pattern",
      wrap({ a: { type: "string", pattern: "^(?=.*x).+$" } }),
      "input",
      /lookaround/,
    ],
    [
      "OpenAI: format outside the list",
      wrap({ a: { type: "string", format: "uri" } }),
      "input",
      /format "uri"/,
    ],
    [
      "Claude Desktop: draft-07 $schema",
      { ...OBJ, $schema: "http://json-schema.org/draft-07/schema#" },
      "output",
      /not JSON Schema 2020-12/,
    ],
    [
      "claude.ai: schema over 16 KiB",
      wrap({ a: { type: "string", description: "x".repeat(MAX_SCHEMA_BYTES) } }),
      "input",
      /exceeds the 16384-byte cap/,
    ],
    [
      "input advertises a null branch",
      wrap({ a: { anyOf: [{ type: "string" }, { type: "null" }] } }),
      "input",
      /advertised on an input/,
    ],
    ["boolean sub-schema", wrap({ a: true }), "output", /not an object/],
  ];
  for (const [name, schema, role, expected] of red) {
    it(`rejects ${name}`, () => {
      const found = portabilityViolations(schema, role);
      expect(found.join("\n")).toMatch(expected);
    });
  }

  it("accepts a schema inside the subset (the rules are not vacuously red)", () => {
    const ok = {
      $schema: JSON_SCHEMA_2020_12,
      ...OBJ,
      properties: {
        a: { type: "string", enum: ["x", "y"], description: "d" },
        b: { type: "array", items: { type: "integer", minimum: 1 } },
        c: { anyOf: [{ type: "string" }, { type: "number" }] },
        d: { type: "string", format: "date-time", pattern: "^[a-z]+$" },
      },
      required: ["a"],
      additionalProperties: false,
    };
    expect(portabilityViolations(ok, "input")).toEqual([]);
  });

  it("keeps a nullable OUTPUT branch (clients validate structuredContent against it)", () => {
    const out = wrap({ a: { anyOf: [{ type: "string" }, { type: "null" }] } });
    expect(portabilityViolations(out, "output")).toEqual([]);
  });
});

const context = (): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "t",
  db: {} as never,
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
});

interface Advertised {
  surface: string;
  tool: string;
  role: SchemaRole;
  schema: unknown;
  annotations: unknown;
}

async function advertise(
  registry: ToolRegistry,
  facadeMode: "triad" | "domain" | "flat",
): Promise<Advertised[]> {
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "portability-gate", version: "0" });
  await client.connect(ct);
  const rows: Advertised[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      rows.push({
        surface: facadeMode,
        tool: t.name,
        role: "input",
        schema: t.inputSchema,
        annotations: t.annotations,
      });
      if (t.outputSchema)
        rows.push({
          surface: facadeMode,
          tool: t.name,
          role: "output",
          schema: t.outputSchema,
          annotations: t.annotations,
        });
    }
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  return rows;
}

describe("every advertised schema is portable", () => {
  const profiles: [string, string[]][] = [
    ["full", []],
    ["core", NON_CORE_TOOL_NAMES as string[]],
  ];
  for (const [profile, disabledByProfile] of profiles) {
    for (const mode of ["flat", "triad", "domain"] as const) {
      it(`tools/list: profile=${profile} mode=${mode}`, async () => {
        const registry = buildFullRegistry({ toolVisibility: { ...ALLOW_ALL, disabledByProfile } });
        const rows = await advertise(registry, mode);
        // Existence floors: a gate that scans nothing reports success.
        const inputs = rows.filter((r) => r.role === "input").length;
        const outputs = rows.filter((r) => r.role === "output").length;
        if (mode === "flat") {
          expect(inputs).toBeGreaterThan(profile === "core" ? 100 : 150);
          expect(outputs).toBeGreaterThan(profile === "core" ? 80 : 120);
        }
        if (mode === "triad") expect(inputs).toBe(5); // find, describe, call + search, fetch
        if (mode === "domain") expect(inputs).toBeGreaterThanOrEqual(profile === "core" ? 6 : 10);

        if (mode === "flat") {
          // Every advertised outputSchema root is a plain object (never coerced from something wider),
          // and the tools listed WITHOUT one are exactly the unconstrained z.unknown() proxies.
          const roots = rows.filter((r) => r.role === "output");
          expect(roots.filter((r) => (r.schema as { type?: unknown }).type !== "object")).toEqual(
            [],
          );
          const withOutput = registry.list().filter((d) => d.outputSchema);
          const advertisedOutputs = new Set(roots.map((r) => r.tool));
          const omitted = withOutput
            .filter((d) => !advertisedOutputs.has(d.name))
            .map((d) => d.name)
            .sort();
          const visible = new Set(rows.map((r) => r.tool));
          expect(omitted.filter((n) => visible.has(n))).toEqual(
            UNADVERTISED_OUTPUTS.filter((n) => visible.has(n)),
          );
        }

        const bad = rows.flatMap((r) =>
          portabilityViolations(r.schema, r.role).map(
            (v) => `${r.surface}/${r.tool}/${r.role} ${v}`,
          ),
        );
        expect(bad, `${bad.length} violations:\n${bad.slice(0, 40).join("\n")}`).toEqual([]);
        // Claude: a tool must never advertise `annotations: null`.
        expect(rows.filter((r) => r.annotations === null)).toEqual([]);
      });
    }
  }

  it("describe_capability's input_schema/output_schema are portable for every registered tool", () => {
    const defs = buildFullRegistry().list();
    expect(defs.length).toBeGreaterThan(150);
    const bad: string[] = [];
    for (const def of defs) {
      const d = describeCapability(def);
      for (const v of portabilityViolations(d.input_schema, "input"))
        bad.push(`${def.name}/input ${v}`);
      if (d.output_schema === undefined && def.outputSchema)
        expect(UNADVERTISED_OUTPUTS, def.name).toContain(def.name);
      if (d.output_schema)
        for (const v of portabilityViolations(d.output_schema, "output"))
          bad.push(`${def.name}/output ${v}`);
    }
    expect(bad, `${bad.length} violations:\n${bad.slice(0, 40).join("\n")}`).toEqual([]);
  });
});
