// Both VecFingerprint construction sites must fold the SAME config value. Standing up boot wiring
// and the index_vault path to compare one string is far more setup than the property needs, so this
// reads the source and asserts each site reads revision from its own config object.
//
// Review round 1, two Minor fixes:
//  - The `toContain` checks below used to be file-wide, so `expr` matching anywhere in the file
//    (a stray comment, a different function entirely) would pass. Anchored to a window starting at
//    the site's own `ensureVecChunks(` call so the match must be IN that call, not merely present
//    somewhere in the file.
//  - A second case used to compare `vecFingerprint(shared)` to itself, which cannot fail for its
//    stated reason (a pure function is trivially equal to itself; nothing about "site" is modeled).
//    Removed rather than kept as theater — provider-revision-fingerprint.test.ts already covers
//    vecFingerprint's determinism and revision-sensitivity directly.
//
// Also extends the flow-level gap flagged in review round 1 (Important): the two construction
// sites above were pinned, but nothing failed if `revision:` were dropped at any of the THREE
// config-bearing flows (add_vault, boot/scheduled reconcile, index_vault) or their one-hop-removed
// config origins. FLOW_SITES asserts exact occurrence COUNTS (not `toContain`) so a deleted line
// changes a count rather than merely losing one of several matches.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSrc(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

/** Number of times `needle` occurs in `haystack`, non-overlapping. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count += 1;
    idx += needle.length;
  }
}

const CONSTRUCTION_SITES = [
  {
    file: "src/runtime/indexing-wiring.ts",
    anchor: "ensureVecChunks(",
    fpExpr: "revision: deps.embeddings.revision",
    activeModelExpr: "activeModel: embeddingProvider.id",
  },
  {
    file: "src/search/indexing/index-vault.ts",
    anchor: "ensureVecChunks(",
    fpExpr: "revision: args.revision",
    activeModelExpr: "activeModel: args.provider.id",
  },
];

describe("vec fingerprint construction sites", () => {
  it("both sites fold a revision (fingerprint) AND an activeModel (backfill identity) from their own config, inside the ensureVecChunks( call itself", () => {
    expect(CONSTRUCTION_SITES.length).toBe(2); // floor: never vacuous
    for (const { file, anchor, fpExpr, activeModelExpr } of CONSTRUCTION_SITES) {
      const src = readSrc(file);
      const anchorAt = src.indexOf(anchor);
      expect(anchorAt, `${file} calls ${anchor}`).toBeGreaterThanOrEqual(0);
      // A generous window past the anchor — the fingerprint object literal AND the opts object
      // that follows it (activeModel lives there, ~700-730 chars past the anchor as written), not
      // the whole file — so an expr matching elsewhere (e.g. a stray comment) does not pass this
      // check.
      const window = src.slice(anchorAt, anchorAt + 1000);
      expect(window, `${file}'s ensureVecChunks( call constructs a VecFingerprint`).toContain(
        "schemaGen:",
      );
      expect(
        window,
        `${file}'s ensureVecChunks( call must fold revision as \`${fpExpr}\``,
      ).toContain(fpExpr);
      // THE-460 fix A (review round 1): the backfill's activeModel opt must ALSO be threaded from
      // this same site's provider identity, or the backfill silently falls back to bare fp.model
      // (which never matches the production-shaped chunk_embeddings.model column) — the exact
      // Critical the reviewer measured.
      expect(
        window,
        `${file}'s ensureVecChunks( call must pass \`${activeModelExpr}\` (fix A)`,
      ).toContain(activeModelExpr);
    }
  });
});

// THE-460 review round 1 (Important, previously disclosed as an open gap): the three
// config-bearing flows (add_vault, boot/scheduled reconcile, index_vault) each thread `revision`
// through one extra hop beyond the two construction sites above. Exact counts, not `toContain` —
// a `toContain` check stays green if one of several identical-looking call sites in the same file
// loses its `revision:` line while another survives.
const FLOW_SITES = [
  // add_vault's indexVault callback (wireM1Tools) AND registerM2Tools's wiring for the MCP
  // index_vault tool (wireDomainTools) both live in this file.
  { file: "src/runtime/tool-wiring.ts", expr: "revision: config.embeddings.revision,", count: 2 },
  // The boot/scheduled reconcile's ReconcileRunnerDeps is populated here, from config, at its one
  // construction site.
  {
    file: "src/runtime/server-runtime.ts",
    expr: "revision: config.embeddings.revision,",
    count: 1,
  },
  // createReconcileRunner's indexVaultRecorded({...}) call reads deps.revision (itself populated
  // by server-runtime.ts above) — the boot/scheduled reconcile's actual IndexVaultArgs-building
  // site.
  { file: "src/runtime/plane-wiring.ts", expr: "revision: deps.revision,", count: 1 },
  // The MCP index_vault tool's direct indexVault({...}) call reads deps.revision (itself populated
  // by tool-wiring.ts's registerM2Tools call above).
  { file: "src/tools/m2/index-tools.ts", expr: "revision: deps.revision,", count: 1 },
];

describe("vec fingerprint flow-level threading (add_vault, reconcile, index_vault)", () => {
  it("each flow site folds revision exactly the expected number of times", () => {
    expect(FLOW_SITES.length).toBe(4); // floor: never vacuous
    for (const { file, expr, count } of FLOW_SITES) {
      const src = readSrc(file);
      expect(
        countOccurrences(src, expr),
        `${file} must contain \`${expr}\` exactly ${count} time(s)`,
      ).toBe(count);
    }
  });
});
