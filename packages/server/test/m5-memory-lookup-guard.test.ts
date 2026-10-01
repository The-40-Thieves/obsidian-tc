// Source-scan guard: every raw memory-entity lookup reachable from a tool handler is accounted for.
// `getEntityById` / `findEntity` / `findEntitiesByName` return a row no matter who is asking, so a
// tool that calls one directly and reports "not found" / "already exists" / a result is an
// existence oracle for entities the caller's read ACL hides. A tool's lookup must go through
// `getReadableEntity` / `memoryReadable` (tools/m5/memory-projection.ts) — this test fails when a
// raw call appears anywhere under src/ that is not listed below WITH the reason it cannot leak.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const RAW_LOOKUP = /\b(getEntityById|findEntity|findEntitiesByName)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

/** Raw-lookup call counts per file under src/, comments and import lines excluded. */
function rawLookups(): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of sourceFiles(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    if (rel === "memory/entities.ts") continue; // the definitions themselves
    const code = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const n = [...code.matchAll(RAW_LOOKUP)].length;
    if (n > 0) out.set(rel, n);
  }
  return out;
}

// file -> [expected raw-call count, why none of them can leak].
const ACCOUNTED: Record<string, [number, string]> = {
  "tools/m5/memory-projection.ts": [
    1,
    "getReadableEntity itself: the single gate every id lookup goes through",
  ],
  "tools/m5/memory-read-tools.ts": [
    2,
    "findEntity (type+name) and findEntitiesByName: each result is filtered by memoryReadable before anything is counted or returned",
  ],
  "tools/m5/memory-tools.ts": [
    2,
    "create_entity's collision check (echoes only the name the caller supplied; UNIQUE(vault,type,name) makes it unavoidable, and the caller needs write access) and add_observation's re-read of an entity ALREADY gated by getReadableEntity",
  ],
  "tools/m5/memory-lifecycle-tools.ts": [
    5,
    "rename_entity's name-collision check (same reason as create_entity) and four neighbor re-materialization reads (rename/delete) that act on entities related to an already-gated entity and return nothing about them",
  ],
};

describe("raw memory-entity lookups are accounted for", () => {
  const found = rawLookups();

  it("floor: the scan sees the known call sites (it is not scanning nothing)", () => {
    expect(found.size).toBeGreaterThanOrEqual(Object.keys(ACCOUNTED).length);
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10);
  });

  it("no file under src/ calls a raw lookup without a written reason, and counts match exactly", () => {
    const actual = Object.fromEntries(found);
    const expected = Object.fromEntries(Object.entries(ACCOUNTED).map(([f, [n]]) => [f, n]));
    expect(actual).toEqual(expected);
  });

  it("get_entity / query_entity_graph gate with the read ACL (not just filter retired)", () => {
    const src = readFileSync(join(SRC, "tools/m5/memory-read-tools.ts"), "utf8");
    expect(src).toMatch(/skip:\s*\(n\)\s*=>\s*!memoryReadable\(/);
    expect(src).toMatch(/getReadableEntity\(deps, ctx, v\.id, input\.seed_entity_id\)/);
    expect(src).toMatch(/getReadableEntity\(deps, ctx, v\.id, input\.entity_id\)/);
  });
});
