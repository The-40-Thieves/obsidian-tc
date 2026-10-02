// retrieval.useSearchModePreference OFF must be byte-identical to the build before the reader
// existed, across every search entry point — and ON must change search_vault's omitted-mode path
// only. Three layers:
//   1. the set of search tools that choose a retrieval MODE is pinned (today: search_vault alone),
//      so a new mode-taking tool cannot ship without this gate being revisited;
//   2. flag OFF (no `searchModePreference` dependency at all) never adds a field or changes a
//      result, even when a strong profile sits in the experiential store;
//   3. the advertised schema for search_vault's input is unchanged; its output gains one optional
//      field, `mode_source`, and nothing else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { applyPreferenceDeltas } from "../src/experiential/reflect";
import { JSON_SCHEMA_OPTS } from "../src/mcp/facade";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

function strongProfileStore(): Database {
  const edb = openMemoryDb();
  runMigrations(edb, CHAIN);
  for (let i = 0; i < 8; i++)
    applyPreferenceDeltas(
      edb,
      "test",
      [{ key: "preferred.search_mode", op: "add", value: "search_text", scopeCaller: "test" }],
      1_800_000_000_000 + i,
    );
  return edb;
}

const files = {
  "fox.md": "# Fox\n\nthe quick brown fox jumps",
  "dog.md": "# Dog\n\nthe lazy dog sleeps",
  "task.md": "---\nstatus: active\n---\n\n# Task\n\nship the release",
};

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["search_text", { vault: "test", query: "fox" }],
  ["search_regex", { vault: "test", pattern: "la\\w+" }],
  ["search_semantic", { vault: "test", query: "lazy dog", k: 2 }],
  ["search_jsonlogic", { vault: "test", logic: { "==": [{ var: "status" }, "active"] } }],
  ["search_dql", { vault: "test", dql: "TABLE file.name" }],
  ["search_vault", { vault: "test", query: "fox" }],
  ["search_vault", { vault: "test", query: "zzzqqq" }],
  ["search_vault", { vault: "test", query: "fox", explain: true, verbosity: "terse" }],
  ["search_vault", { vault: "test", query: { "==": [{ var: "status" }, "active"] } }],
  ["search_vault", { vault: "test", query: "fox", mode: "auto" }],
  ["search_vault", { vault: "test", query: "fox", mode: "text" }],
  ["search_vault", { vault: "test", query: "fox", mode: "semantic" }],
  ["search_vault", { vault: "test", query: "la\\w+", mode: "regex" }],
];

async function run(opts: Parameters<typeof makeM2Vault>[0]): Promise<string[]> {
  const v = makeM2Vault({ files, ...opts });
  await v.call("index_vault", { vault: "test" });
  const out: string[] = [];
  // `meta.duration_ms` is wall-clock and differs between any two runs; everything else is compared.
  const scrub = (r: unknown) => JSON.stringify(r, (k, val) => (k === "meta" ? undefined : val));
  for (const [name, input] of CALLS) out.push(scrub(await v.call(name, input)));
  v.cleanup();
  return out;
}

describe("which search tools choose a retrieval mode", () => {
  it("only search_vault does; search_and_read's `mode` is output granularity, not a search mode", () => {
    const defs = buildFullRegistry().list();
    expect(defs.length).toBeGreaterThan(100);
    const withMode = defs
      .filter((d) => d.domain === "search" || /search/.test(d.name))
      .filter((d) => {
        const s = z.toJSONSchema(d.inputSchema, { ...JSON_SCHEMA_OPTS, io: "input" }) as {
          properties?: Record<string, unknown>;
        };
        return "mode" in (s.properties ?? {});
      })
      .map((d) => d.name)
      .sort();
    expect(withMode).toEqual(["search_and_read", "search_vault"]);
    const sar = z.toJSONSchema(
      defs.find((d) => d.name === "search_and_read")?.inputSchema as z.ZodType,
      {
        ...JSON_SCHEMA_OPTS,
        io: "input",
      },
    ) as unknown as { properties: { mode: { enum: string[] } } };
    expect(sar.properties.mode.enum).toEqual(["note", "section"]);
  });
});

describe("flag off", () => {
  it("adds no mode_source and equals an explicit mode:auto call, with or without a stored profile", async () => {
    const off = await run({});
    for (const r of off) expect(r).not.toContain("mode_source");
    const plain = JSON.parse(off[5] as string);
    const explicitAuto = JSON.parse(off[9] as string);
    expect(plain).toEqual(explicitAuto);
  });

  it("every search entry point is unchanged by a flag-ON reader when the profile is empty or absent", async () => {
    const off = await run({});
    const empty = openMemoryDb();
    runMigrations(empty, CHAIN);
    const onEmpty = await run({ searchModePreference: { edb: empty } });
    // Everything except search_vault's `mode_source` annotation is byte-identical.
    const strip = (s: string) => s.replace(/,"mode_source":"(explicit|preference|default)"/g, "");
    expect(onEmpty.map(strip)).toEqual(off);
  });

  it("flag ON with a strong profile changes ONLY search_vault calls that omitted mode on a string query", async () => {
    const off = await run({});
    const on = await run({ searchModePreference: { edb: strongProfileStore() } });
    const strip = (s: string) => s.replace(/,"mode_source":"(explicit|preference|default)"/g, "");
    const changed = on.map((r, i) => (strip(r) === off[i] ? null : i)).filter((i) => i !== null);
    // 6 loses auto's semantic fallback ("zzzqqq" has no text hit); 7 is the same call with
    // `explain`, whose reason now names the preference. 5 coincides with auto's first leg.
    expect(changed).toEqual([6, 7]);
    for (const i of [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12])
      expect(strip(on[i] as string)).toBe(off[i]);
  });
});

describe("advertised schema", () => {
  const def = () =>
    buildFullRegistry()
      .list()
      .find((d) => d.name === "search_vault");

  // Re-recorded for GH #1027: response_format was added and verbosity lost its schema default. The
  // reader itself still adds no key, which is what this pins.
  it("search_vault input JSON schema is byte-identical to the pre-reader one (mode still defaults to auto)", () => {
    const schema = z.toJSONSchema(def()?.inputSchema as z.ZodType, {
      ...JSON_SCHEMA_OPTS,
      io: "input",
    });
    expect(JSON.stringify(schema)).toBe(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"vault":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[a-z0-9_-]+$"},"query":{"anyOf":[{"type":"string","minLength":1},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}]},"mode":{"default":"auto","type":"string","enum":["auto","text","regex","dql","jsonlogic","semantic"]},"root":{"type":"string","minLength":1,"maxLength":1024},"explain":{"default":false,"type":"boolean"},"limit":{"type":"integer","exclusiveMinimum":0,"maximum":1000},"cursor":{"type":"string"},"response_format":{"description":"concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server\'s tools.defaults.responseFormat applies.","type":"string","enum":["concise","detailed"]},"verbosity":{"description":"Legacy alias for response_format: terse = concise, full = detailed.","type":"string","enum":["full","terse"]}},"required":["vault","query"],"additionalProperties":false}',
    );
  });

  it("search_vault output schema gains the optional fields mode_source, warnings and warnings_omitted", () => {
    const schema = z.toJSONSchema(def()?.outputSchema as z.ZodType, JSON_SCHEMA_OPTS) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      "warnings",
      "warnings_omitted",
      "vault",
      "mode_used",
      "headers",
      "rows",
      "note_paths",
      "items",
      "total",
      "next_cursor",
      "_explain",
      "mode_source",
    ]);
    expect(schema.required).toEqual(["vault", "mode_used"]);
    expect(schema.properties.mode_source).toMatchObject({
      enum: ["explicit", "preference", "default"],
    });
  });
});
