// Source-scan guard: every raw memory-entity lookup AND raw relation read reachable from a tool
// handler is accounted for. `getEntityById` / `findEntity` / `findEntitiesByName` return a row and
// `relationsForEntity` returns the edges (with the far end's id, name and type) no matter who is
// asking, so a tool that reports from one directly is an existence oracle for entities the caller's
// read ACL hides. Tools must go through `getReadableEntity` / `memoryReadable` / `readableRelations`
// (tools/m5/memory-projection.ts). This scan only pins WHERE raw reads live and why each is safe;
// the behaviour is pinned by m5-memory-read-acl.test.ts and m5-memory-read-acl-leaks.test.ts, which
// run the tools against a hidden entity.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const RAW_LOOKUP = /\b(getEntityById|findEntity|findEntitiesByName)\(/g;
const RAW_RELATIONS = /\b(relationsForEntity|bfsGraph)\(/g;
const RAW_SQL = /\b(memory_entities|memory_relations)\b/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

/** Call counts of `re` per file under src/, comments and import lines excluded. */
function scan(re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of sourceFiles(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    if (rel === "memory/entities.ts") continue; // the definitions themselves
    const code = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const n = [...code.matchAll(re)].length;
    if (n > 0) out.set(rel, n);
  }
  return out;
}

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
  const lookups = scan(RAW_LOOKUP);
  const relations = scan(RAW_RELATIONS);

  it("floor: the scans see the known call sites (they are not scanning nothing)", () => {
    expect(lookups.size).toBeGreaterThanOrEqual(Object.keys(LOOKUPS).length);
    expect([...lookups.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9);
    expect(relations.size).toBeGreaterThanOrEqual(Object.keys(RELATIONS).length);
    expect([...relations.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
  });

  it("no file under src/ calls a raw lookup or relation read without a written reason, counts exact", () => {
    expect(Object.fromEntries(lookups)).toEqual(expectedOf(LOOKUPS));
    expect(Object.fromEntries(relations)).toEqual(expectedOf(RELATIONS));
  });

  it("no tool handler queries the memory tables directly", () => {
    const direct = [...scan(RAW_SQL).keys()].filter((f) => f.startsWith("tools/"));
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
