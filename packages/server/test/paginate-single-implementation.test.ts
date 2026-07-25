// THE-516: `paginate` and its `Page<T>` shape existed TWICE, byte-identical, in
// tools/m2/search-tools.ts and tools/m4/tasks-tools.ts. Two copies of one wire contract — the same
// cursor encoding, the same default page size, the same next_cursor semantics — each free to drift
// from the other, and nothing to notice if one did.
//
// Consolidated into util/paginate.ts. This gate is a source scan rather than a behavioural test
// because the failure it guards is structural: a THIRD copy would work perfectly and pass every
// behavioural test in the suite while quietly re-forking the contract. Only counting definitions
// catches that. Same reasoning as THE-577's facade domain-map gate.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, paginate } from "../src/util/paginate";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const CANONICAL = join(SRC, "util", "paginate.ts");

/** src-relative path with POSIX separators. The suite runs on Windows too (build-test
 *  windows-latest), where join() yields backslashes and a bare slice() would compare
 *  "util\\paginate.ts" against "util/paginate.ts". */
function relPosix(abs: string): string {
  return abs
    .slice(SRC.length + 1)
    .split(sep)
    .join("/");
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("THE-516 pagination has one implementation", () => {
  it("defines paginate() exactly once under src/, in util/paginate.ts", () => {
    const files = tsFiles(SRC);
    // Sanity floor: if the walk found nothing, the assertions below would pass vacuously.
    expect(files.length).toBeGreaterThan(100);

    const definers = files.filter((f) =>
      /^\s*(export\s+)?function paginate\s*</m.test(readFileSync(f, "utf8")),
    );
    expect(
      definers.map(relPosix),
      "paginate() must be defined only in util/paginate.ts — import it instead of re-declaring it",
    ).toEqual(["util/paginate.ts"]);
    expect(definers[0]).toBe(CANONICAL);
  });

  it("declares the Page<T> response shape only alongside it", () => {
    const definers = tsFiles(SRC).filter((f) =>
      /^\s*(export\s+)?interface Page<T>/m.test(readFileSync(f, "utf8")),
    );
    expect(
      definers.map(relPosix),
      "Page<T> is the paginated wire shape — declare it once, next to paginate()",
    ).toEqual(["util/paginate.ts"]);
  });

  // Behaviour pinned so the consolidation is provably a no-op: these are the exact semantics both
  // copies had, including the quirks.
  it("preserves the semantics both copies had", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);

    // Default page size, and total is the FULL length, not the page's.
    expect(paginate(Array.from({ length: 120 }, (_, i) => i))).toMatchObject({
      total: 120,
      next_cursor: String(DEFAULT_PAGE_SIZE),
    });

    // Walks to the end and then omits next_cursor entirely (absent, not null/undefined-valued).
    const p1 = paginate(items, 3);
    expect(p1).toEqual({ items: [0, 1, 2], total: 7, next_cursor: "3" });
    const p2 = paginate(items, 3, p1.next_cursor);
    expect(p2).toEqual({ items: [3, 4, 5], total: 7, next_cursor: "6" });
    const p3 = paginate(items, 3, p2.next_cursor);
    expect(p3).toEqual({ items: [6], total: 7 });
    expect(Object.hasOwn(p3, "next_cursor")).toBe(false);

    // A garbage or negative cursor clamps to 0 rather than throwing — a client that mangles an
    // opaque token degrades to "start over" instead of failing the call.
    expect(paginate(items, 2, "not-a-number").items).toEqual([0, 1]);
    expect(paginate(items, 2, "-5").items).toEqual([0, 1]);

    // A cursor past the end yields an empty last page, not an error.
    expect(paginate(items, 3, "99")).toEqual({ items: [], total: 7 });
  });
});
