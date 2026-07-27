// THE-566 — the narrative fact assert gate. Tests the PURE scanFacts (no filesystem, no registry
// build) so the contract is verifiable without a build, the same discipline that makes the gate
// trustworthy. The CLI half (currentFactRules / file walk) is a thin wrapper and is exercised by
// running `bun scripts/docgen/facts-check.ts` against the repo.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { factRules, type ScanStats, scanFacts } from "../scripts/docgen/facts-check";

// The REAL production patterns, bound to test values — so these cases validate the shipped regexes.
const RULES = factRules(146, 250, 31);

describe("scanFacts (THE-566 narrative fact gate)", () => {
  it("passes when narrative matches the current facts", () => {
    const text = [
      "The surface is 146 governed capabilities across 31 domains.",
      "Every ranking change is gated against a 250-query golden set.",
      "It exposes 146 tools across 31 domains.",
    ].join("\n");
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("flags a stale tool count with the line number", () => {
    const text = "One\nThe surface is 143 governed capabilities.\nThree";
    const v = scanFacts(text, RULES);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ fact: "toolCount", line: 2, found: 143, expected: 146 });
  });

  it("flags a stale golden-set size (n=136) on a golden line", () => {
    const v = scanFacts("gated against an n=136 golden set with a ship rule", RULES);
    expect(v).toEqual([
      expect.objectContaining({ fact: "goldenSetSize", found: 136, expected: 250 }),
    ]);
  });

  it("does NOT flag the 3-tool facade (a real, different fact)", () => {
    const text = [
      "**obsidian-tc** | 146 (3-tool facade)",
      "advertised by default through a three-tool facade",
      "the facade fronts the surface with 3 tools",
    ].join("\n");
    // "3-tool facade" / "3 tools" are not surface phrasings, so no false positive; the 146 passes.
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("does NOT flag an unrelated n= outside a golden line", () => {
    expect(scanFacts("with n=30 samples per bucket in the perf harness", RULES)).toEqual([]);
  });

  it("does NOT flag numbers embedded in tokens (G2.1, THE-135, r2, V1)", () => {
    // Every one of these was a false positive in the first dry run against the repo.
    const text = [
      "The complete G2.1 tool surface — 146 tools across 31 domains — is shipped.",
      "It inherits the G2.1 r2 tool surface from G1.",
      "the THE-135 query-time virtual-hop hit an 80% ceiling on the golden-set A/B",
    ].join("\n");
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  // THE-598: ARCHITECTURE.md:692's "the 128-tool G2.1 set plus post-1.0 additive tools" was one
  // noun away from the "-tool surface" pattern above and slipped through both this gate AND
  // check-version-coherence.mjs (anchored on the DIFFERENT phrase "(\d+)-tool G2.1 surface")
  // simultaneously. This used to be in the "does NOT flag" test above, demonstrating the exact gap;
  // the widened pattern now catches it.
  it("flags a widened '<N>-tool <noun> surface/set' phrasing (THE-598)", () => {
    const v = scanFacts("the 128-tool G2.1 set plus post-1.0 additive tools", RULES);
    expect(v).toEqual([expect.objectContaining({ fact: "toolCount", found: 128, expected: 146 })]);
  });

  it("still does NOT flag the real G2.1 surface phrasing at the current count", () => {
    expect(scanFacts("the 146-tool G2.1 surface plus post-1.0 additive tools", RULES)).toEqual([]);
  });

  it("does NOT flag a milestone sub-count (anchored to 'across 31 domains')", () => {
    // M4's real contribution, not the surface total.
    expect(scanFacts("Plugin bridges — 20 tools across 9 domains — merged", RULES)).toEqual([]);
  });

  it("flags 'N tool impls' (the phrasing a canonical-only sweep would miss)", () => {
    const v = scanFacts("never scattered across the 141 tool impls — so adding", RULES);
    expect(v).toEqual([expect.objectContaining({ fact: "toolCount", found: 141, expected: 146 })]);
  });

  it("skips a line marked facts-check:ignore (intentional historical value)", () => {
    const text =
      "the golden set expanded 136 to 250 in July <!-- facts-check:ignore -->\nnext line 143 tools across 31 domains";
    const v = scanFacts(text, RULES);
    // line 1 ignored; line 2's stale 143 still caught
    expect(v).toEqual([expect.objectContaining({ fact: "toolCount", line: 2, found: 143 })]);
  });

  it("skips an entire file marked facts-check:ignore-file", () => {
    const text = "<!-- facts-check:ignore-file -->\n143 tools across 31 domains\nn=136 golden set";
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("ignores numbers inside a GENERATED marker region (owned by injectGenerated)", () => {
    const text = [
      "<!-- BEGIN GENERATED: tools-summary -->",
      "143 governed capabilities", // a generated block is byte-owned elsewhere; not narrative
      "<!-- END GENERATED: tools-summary -->",
      "narrative says 143 tools across 31 domains", // this one IS narrative -> caught
    ].join("\n");
    const v = scanFacts(text, RULES);
    expect(v).toEqual([expect.objectContaining({ fact: "toolCount", line: 4, found: 143 })]);
  });

  it("reports every mismatch on a line, not just the first", () => {
    const text = "143 typed tools and a 200-query golden set";
    const v = scanFacts(text, RULES);
    expect(v.map((x) => x.fact).sort()).toEqual(["goldenSetSize", "toolCount"]);
  });

  // THE-470 hole 3: domainCount was previously only an ANCHOR baked into the toolCount pattern —
  // nothing ever asserted the "31" itself, so it could drift silently. These prove the new rule
  // actually fires, per "a rule you have not watched fail is not a gate".
  it("flags a stale domain count with the line number", () => {
    const v = scanFacts("The surface is 146 tools across 32 domains.", RULES);
    expect(v).toEqual([expect.objectContaining({ fact: "domainCount", found: 32, expected: 31 })]);
  });

  it("does NOT flag a milestone sub-count's domain number (anchored to the canonical tool count)", () => {
    // "20 tools across 9 domains" pairs a DIFFERENT tool count with its own domain sub-count; the
    // domainCount rule only fires when the canonical 146 anchors the phrase.
    expect(scanFacts("Plugin bridges — 20 tools across 9 domains — merged", RULES)).toEqual([]);
  });

  it("passes when the domain count matches, even alongside a stale golden-set number", () => {
    const v = scanFacts("146 tools across 31 domains, gated against an n=136 golden set", RULES);
    expect(v).toEqual([
      expect.objectContaining({ fact: "goldenSetSize", found: 136, expected: 250 }),
    ]);
  });
});

// THE-601: the gate could pass VACUOUSLY. It reports success by finding nothing, so "found no
// drift" and "read no files" printed the same line — and every read in the script is wrapped in
// `try { … } catch { continue }`, so a mis-resolved repoRoot does not throw, it silently scans zero
// files and prints OK. `repoRoot` is a four-level relative climb from `import.meta.url`, and
// `bun --compile` bakes that at build time — the mechanism behind two already-shipped broken
// releases.
//
// Its siblings already refused this: render.ts throws on a zero-marker scan ("the scan is broken,
// not the docs. Refusing to report success"), and gen-tree-map.mjs refuses an empty file list.
describe("ScanStats — evidence the scan actually ran (THE-601)", () => {
  const fresh = (): ScanStats => ({ linesScanned: 0, patternMatches: 0 });

  it("counts narrative lines examined", () => {
    const stats = fresh();
    scanFacts("line one\nline two\nline three", RULES, stats);
    expect(stats.linesScanned).toBe(3);
  });

  it("counts a CORRECT match, not just a violation — else the floor is unsatisfiable when clean", () => {
    // The subtle part. In a healthy tree every match is a correct one, so counting only violations
    // would make the floor impossible to meet exactly when the docs are right. A match is evidence
    // the rule CAN fire, which is the property the floor is really asserting.
    const stats = fresh();
    const v = scanFacts("the 146-tool surface is governed", RULES, stats);
    expect(v).toEqual([]); // 146 is the correct value for these RULES
    expect(stats.patternMatches).toBe(1);
  });

  it("counts a violating match too", () => {
    const stats = fresh();
    expect(scanFacts("the 999-tool surface", RULES, stats)).toHaveLength(1);
    expect(stats.patternMatches).toBe(1);
  });

  it("does NOT count lines inside generated regions or ignore-marked lines", () => {
    // These are excluded from scanning, so counting them would let a corpus that is entirely
    // generated satisfy a floor while no narrative was checked at all.
    const stats = fresh();
    scanFacts(
      ["narrative", "<!-- BEGIN GENERATED: x -->", "generated", "<!-- END GENERATED: x -->"].join(
        "\n",
      ),
      RULES,
      stats,
    );
    expect(stats.linesScanned).toBe(1);
  });

  it("is optional — omitting it leaves every existing caller unchanged", () => {
    expect(() => scanFacts("the 146-tool surface", RULES)).not.toThrow();
  });
});

describe("facts-check CLI floor (THE-601)", () => {
  const SCRIPT = fileURLToPath(new URL("../scripts/docgen/facts-check.ts", import.meta.url));
  const CWD = fileURLToPath(new URL("..", import.meta.url));

  it("passes on the real repo AND reports what it scanned", () => {
    // The floor is only meaningful if the real run clears it with margin. This also pins the
    // reporting: a bare "OK" is what made the vacuous pass invisible in the first place.
    const r = spawnSync("bun", [SCRIPT], { cwd: CWD, encoding: "utf8" });
    expect(r.status).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/OK — no narrative drift/);
    expect(out).toMatch(/\d+ files, \d+ lines, \d+ pattern matches/);
    const files = Number(/(\d+) files/.exec(out)?.[1] ?? 0);
    expect(files).toBeGreaterThan(20); // the floor itself — real runs must clear it, not sit on it
  });

  it("FAILS when the scan reads nothing, instead of reporting OK", () => {
    // Watching it fail is the whole point (reference-source-scan-gates rule 3). A gate that has
    // never been observed rejecting something proves nothing. Forcing an empty scan the way a baked
    // import.meta.url would: run it against a root with no docs tree.
    const r = spawnSync("bun", [SCRIPT], {
      cwd: CWD,
      encoding: "utf8",
      env: { ...process.env, DOCGEN_FACTS_ROOT_OVERRIDE: "/nonexistent-the601-probe" },
    });
    expect(r.status).toBe(1);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/scanned too little to report success/);
    expect(out).toMatch(/read 0 narrative files/);
    // The message must blame the GATE, not the docs — otherwise the next person edits a doc.
    expect(out).toMatch(/This is the GATE being broken, not the docs/);
  });
});
