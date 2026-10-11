// lint_wiki and the scheduled wiki lint were made cooperative (their scans yield the event loop
// between notes). This pins that the answers did not move: EXPECTED was captured from the
// synchronous implementation on the commit before the change, and every call below must still
// return it byte for byte. Regenerate only on an intentional output change:
// UPDATE_LINT_EXPECTED=1 vitest run <this file>.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { registerWikiLintSweep } from "../src/runtime/wiki-lint-sweep";
import { NO_EXCLUSION } from "../src/search/index-exclusion";
import type { LintReport } from "../src/tools/m7/knowledge/wiki-lint";
import { scanFixtureFiles } from "./fixtures/scan-yield-vault";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const EXPECTED = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "wiki-lint-yield-before.json",
);

const LINT_CALLS: Array<Record<string, unknown>> = [
  {},
  { limit_per_check: 3 },
  { folder: "bulk/f1" },
  { folder: "ring", checks: ["orphans", "unresolved_links", "missing_sources"] },
  { checks: ["contradictions", "near_duplicates"], response_format: "concise" },
  { checks: ["generated_pages", "orphans"], limit_per_check: 1 },
];

let h: WikiHarness | undefined;
afterEach(() => h?.v.cleanup());

function fixture(): WikiHarness {
  h = makeWikiHarness({ files: scanFixtureFiles(), wikiFolder: "wiki" });
  // A near-duplicate pair and open contradictions, so those checks have something to report.
  h.seed("bulk/f0/b0.md", [0, 1, 0, 0.02]);
  h.seed("bulk/f1/b1.md", [0, 1, 0.02, 0]);
  h.seed("bulk/f2/b2.md", [1, 0, 0, 0]);
  const ins = h.v.db.prepare(
    `INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path,
       source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at)
     VALUES (?, 'test', 'sc', ?, 'cc', ?, ?, ?, ?, 'they disagree', ?, 0)`,
  );
  ins.run("k1", "bulk/f0/b0.md", "bulk/f1/b1.md", "s1", "x1", "contradiction", "open");
  ins.run("k2", "bulk/f2/b2.md", "hub.md", "s2", "x2", "tension", "open");
  ins.run("k3", "bulk/f2/b2.md", "ring/r0.md", "s3", "x3", "tension", "resolved");
  return h;
}

describe("lint_wiki and the wiki lint sweep: cooperative output equals the synchronous output", () => {
  it("returns the pre-change bytes for every call", { timeout: 60_000 }, async () => {
    const hh = fixture();
    const got: Record<string, string> = {};
    for (const input of LINT_CALLS) {
      const r = await hh.call("lint_wiki", input);
      expect(r.ok, JSON.stringify(input)).toBe(true);
      got[`lint_wiki ${JSON.stringify(input)}`] = JSON.stringify(r.ok ? r.data : r);
    }
    // The scheduled sweep runs the same engine without an ACL.
    const reports: LintReport[] = [];
    let task: { run: (s: AbortSignal) => unknown } | undefined;
    registerWikiLintSweep({ register: (t: never) => (task = t) } as never, {
      cacheDb: hh.v.db,
      vaults: [{ id: "test", root: hh.v.root, wikiFolder: "wiki" }],
      exclusionFor: () => NO_EXCLUSION,
      embeddingModel: "stub:4",
      intervalMs: 1000,
      maxNotes: 100,
      sealKey: () => "wiki-generated-test-key-at-least-thirty-two-bytes",
      onReport: (r) => reports.push(r),
    });
    await task?.run(new AbortController().signal);
    expect(reports).toHaveLength(1);
    got.sweep = JSON.stringify(reports[0]);

    if (process.env.UPDATE_LINT_EXPECTED === "1")
      writeFileSync(EXPECTED, `${JSON.stringify(got, null, 1)}\n`);
    const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<string, string>;
    expect(Object.keys(expected).length).toBe(LINT_CALLS.length + 1);
    expect(got).toEqual(expected);

    // The fixture really exercises the branches.
    const full = JSON.parse(got[`lint_wiki ${JSON.stringify({})}`] as string);
    for (const kind of ["orphan", "unresolved_link", "missing_sources", "contradiction"])
      expect(full.summary.by_kind[kind], kind).toBeGreaterThan(0);
    expect(full.warnings?.length ?? 0).toBeGreaterThan(0);
  });
});
