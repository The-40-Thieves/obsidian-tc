// Source-scan guard: every raw memory-entity lookup AND raw relation read reachable from a tool
// handler is accounted for. `getEntityById` / `findEntity` / `findEntitiesByName` return a row and
// `relationsForEntity` returns the edges (with the far end's id, name and type) no matter who is
// asking, so a tool that reports from one directly is an existence oracle for entities the caller's
// read ACL hides. Tools must go through `getReadableEntity` / `memoryReadable` / `readableRelations`
// (tools/m5/memory-projection.ts). This scan only pins WHERE raw reads live and why each is safe;
// the behaviour is pinned by m5-memory-read-acl.test.ts and m5-memory-read-acl-leaks.test.ts, which
// run the tools against a hidden entity.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aliasEscapeRules,
  countByRuleAndFile,
  type SourceHit,
  scanSource,
} from "./ast-source-scan";
import { makeTempDir, rmTemp } from "./tmp";

// The scan is structural (ast-grep, ast-source-scan.ts), not a line regex: a regex over `name(`
// cannot see an import alias (`findEntity as rawFind`), a namespace call or a re-export, which the
// cross-vendor review of #1085 flagged on the sibling capture guard. A direct call by its imported
// name is counted per file below; every other way of reaching the raw reads must not exist at all.
const SRC = join(import.meta.dirname, "..", "src");
const LOOKUP_NAMES = "getEntityById|findEntity|findEntitiesByName";
const RELATION_NAMES = "relationsForEntity|bfsGraph";
const ALL_NAMES = `${LOOKUP_NAMES}|${RELATION_NAMES}`;

const callRule = (id: string, names: string) => `id: ${id}
language: ts
rule:
  kind: call_expression
  has:
    field: function
    kind: identifier
    regex: '^(${names})$'
`;
const RULES = [
  callRule("lookup-call", LOOKUP_NAMES),
  callRule("relation-call", RELATION_NAMES),
  String.raw`id: memory-sql
language: ts
rule:
  kind: string_fragment
  regex: '\b(memory_entities|memory_relations)\b'
`,
  aliasEscapeRules("escape", ALL_NAMES, "memory/entities"),
].join("---\n");

// The module defining the raw reads.
const EXCLUDED = ["memory/entities.ts"];
const scan = (dir: string) => countByRuleAndFile(scanSource(dir, RULES), EXCLUDED);

// file -> [expected raw-call count, why none of them can leak].
const LOOKUPS: Record<string, [number, string]> = {
  "tools/m5/memory-projection.ts": [
    4,
    "getReadableEntity (the gate itself); planNeighbors/rematerializeNeighbors (act on neighbours of an already-gated entity, a hidden one only quietly and never reported); scrubOwnerDisclosure (only ever removes an id from an error)",
  ],
  "tools/m5/memory-read-tools.ts": [
    2,
    "findEntity (type+name) and findEntitiesByName: each result is filtered by memoryReadable before anything is counted or returned",
  ],
  "tools/m5/memory-tools.ts": [
    2,
    "create_entity's collision check (runs only AFTER assertMemoryPathReadable on the same path, so a collision is reported only for an entity the caller could read) and add_observation's re-read of an entity ALREADY gated by getReadableEntity",
  ],
  "tools/m5/memory-lifecycle-tools.ts": [
    1,
    "rename_entity's name-collision check (runs only AFTER assertMemoryPathReadable on the destination path)",
  ],
};

// file -> [expected count, why it cannot leak]. Raw edge lists carry the far end's id/name/type.
const RELATIONS: Record<string, [number, string]> = {
  "tools/m5/memory-projection.ts": [
    2,
    "outgoingLinks renders the entity's own note (the accepted, documented residual: link targets are named in the note, like any wiki-link) and readableRelations splits visible from hidden",
  ],
  "tools/m5/memory-read-tools.ts": [
    2,
    "get_entity filters each edge by getReadableEntity; query_entity_graph walks bfsGraph with skip: !memoryReadable",
  ],
  "tools/m5/memory-lifecycle-tools.ts": [
    1,
    "rename_entity hands the incoming edges to planNeighbors, which never reports a hidden neighbour",
  ],
};

const expectedOf = (m: Record<string, [number, string]>) =>
  Object.fromEntries(Object.entries(m).map(([f, [n]]) => [f, n]));

describe("raw memory-entity lookups and relation reads are accounted for", () => {
  const found = scan(SRC);
  const lookups = found["lookup-call"] ?? {};
  const relations = found["relation-call"] ?? {};

  it("floor: the scans see the known call sites (they are not scanning nothing)", () => {
    expect(Object.keys(lookups).length).toBeGreaterThanOrEqual(Object.keys(LOOKUPS).length);
    expect(Object.values(lookups).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9);
    expect(Object.keys(relations).length).toBeGreaterThanOrEqual(Object.keys(RELATIONS).length);
    expect(Object.values(relations).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
  });

  it("no file under src/ calls a raw lookup or relation read without a written reason, counts exact", () => {
    expect(lookups).toEqual(expectedOf(LOOKUPS));
    expect(relations).toEqual(expectedOf(RELATIONS));
  });

  it("nothing reaches them by alias, namespace, re-export, member call or dynamic load", () => {
    for (const rule of [
      "escape-alias",
      "escape-namespace",
      "escape-star-export",
      "escape-member-call",
      "escape-dynamic-load",
    ])
      expect(found[rule], rule).toBeUndefined();
  });

  it("no tool handler queries the memory tables directly", () => {
    const direct = Object.keys(found["memory-sql"] ?? {}).filter((f) => f.startsWith("tools/"));
    expect(direct).toEqual([]);
  });

  it("delete_entity's confirmation fingerprint and refusal use the readable relations only", () => {
    const src = readFileSync(join(SRC, "tools/m5/memory-lifecycle-tools.ts"), "utf8");
    expect(src).toMatch(/relations:\s*readableRelations\(deps, ctx, e\)\.visible/);
    expect(src).toMatch(/const \{ visible, hidden \} = readableRelations\(deps, ctx, e\)/);
  });

  it("get_entity / query_entity_graph gate with the read ACL (not just filter retired)", () => {
    const src = readFileSync(join(SRC, "tools/m5/memory-read-tools.ts"), "utf8");
    expect(src).toMatch(/skip:\s*\(n\)\s*=>\s*!memoryReadable\(/);
    expect(src).toMatch(/getReadableEntity\(deps, ctx, v\.id, input\.seed_entity_id\)/);
    expect(src).toMatch(/getReadableEntity\(deps, ctx, v\.id, input\.entity_id\)/);
  });
});

describe("the guard catches the shapes a line regex missed (RED fixtures)", () => {
  let dir: string;
  let hits: SourceHit[];
  beforeAll(() => {
    dir = makeTempDir("memory-guard-");
    mkdirSync(join(dir, "tools"), { recursive: true });
    const w = (name: string, body: string) => writeFileSync(join(dir, "tools", name), body);
    w(
      "alias.ts",
      'import { findEntity as rawFind } from "../memory/entities";\nrawFind(db, "v", "t", "n");\n',
    );
    w("ns.ts", 'import * as m from "../memory/entities";\nm.getEntityById(db, "id");\n');
    w("star.ts", 'export * from "../memory/entities";\n');
    w("dyn.ts", 'const m = await import("../memory/entities");\n');
    w("sql.ts", "db.prepare(`SELECT * FROM memory_entities`).get();\n");
    hits = scanSource(dir, RULES);
  });
  afterAll(() => rmTemp(dir));

  const filesFor = (rule: string) => hits.filter((h) => h.rule === rule).map((h) => h.file);

  it("an aliased import", () => {
    expect(filesFor("escape-alias")).toContain("tools/alias.ts");
  });
  it("a namespace import and its member call", () => {
    expect(filesFor("escape-namespace")).toContain("tools/ns.ts");
    expect(filesFor("escape-member-call")).toContain("tools/ns.ts");
  });
  it("an export-star and a dynamic load", () => {
    expect(filesFor("escape-star-export")).toContain("tools/star.ts");
    expect(filesFor("escape-dynamic-load")).toContain("tools/dyn.ts");
  });
  it("memory-table SQL in a template string", () => {
    expect(filesFor("memory-sql")).toContain("tools/sql.ts");
  });
});
