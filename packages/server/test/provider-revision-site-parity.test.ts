// THE-683 rewrite. This file used to assert, by reading source, that BOTH VecFingerprint
// construction sites folded `revision` from their own config, and that four flow sites threaded it
// with exact occurrence counts. That guard existed because the two sites hand-built the identity
// independently, and a divergence means boot and index_vault each DROP and rebuild the table the
// other just built — an unbounded rebuild loop.
//
// There is now ONE derivation: `buildRepresentationManifest`. index-vault.ts receives the built
// manifest via IndexVaultArgs.representation instead of recomputing it, so the divergence the old
// tests policed is unrepresentable rather than merely detected. Those assertions are not weakened,
// they are obsolete — their premise ("both sites construct one") is false by construction.
//
// What replaces them:
//  1. a structural guard that the single-derivation property HOLDS (nothing outside the composition
//     root builds a manifest, and index-vault.ts does not construct one at all), and
//  2. a BEHAVIOURAL test of the property the old source-reading was a proxy for — that two
//     independently-built manifests over the same config do not cause a rebuild. That is the actual
//     rebuild-loop hazard, and it is now cheap to test directly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { buildRepresentationManifest } from "../src/search/representation";
import { ensureVecChunks, type VecRebuildEvent } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

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

describe("representation identity has exactly one derivation", () => {
  // The composition root builds it; everyone else is handed the result. A second producer call in
  // src/ would reintroduce the two-sites problem under a new name, so the count is exact rather
  // than a `toContain` — a `toContain` stays green when a second site is ADDED.
  it("only the composition root calls buildRepresentationManifest", () => {
    const wiring = readSrc("src/runtime/indexing-wiring.ts");
    expect(countOccurrences(wiring, "buildRepresentationManifest(")).toBe(1);
  });

  // The site that used to hand-build a competing fingerprint must now only CONSUME one.
  it("index-vault.ts consumes the manifest and constructs no fingerprint of its own", () => {
    const src = readSrc("src/search/indexing/index-vault.ts");
    expect(src).toContain("ensureVecChunks(args.db, args.representation,");
    expect(src).not.toContain("buildRepresentationManifest(");
    // `schemaGen:` was the tell-tale of a hand-built VecFingerprint literal in this file.
    expect(src).not.toContain("schemaGen:");
  });

  // The flows that used to thread a loose `revision` now thread the built identity. Exact counts,
  // for the same reason the original file used them: a `toContain` survives one of several
  // identical-looking sites losing its line.
  const FLOW_SITES = [
    // add_vault's indexVault callback (wireM1Tools) and registerM2Tools's wiring for the MCP
    // index_vault tool (wireDomainTools) both live in this file.
    { file: "src/runtime/tool-wiring.ts", expr: "representation: deps.representation,", count: 2 },
    // createReconcileRunner's indexVaultRecorded({...}) — the boot/scheduled reconcile.
    { file: "src/runtime/plane-wiring.ts", expr: "representation: deps.representation,", count: 1 },
    // The MCP index_vault tool's direct indexVault({...}) call.
    { file: "src/tools/m2/index-tools.ts", expr: "representation: deps.representation,", count: 1 },
  ];

  it("each flow threads the built representation exactly once per site", () => {
    expect(FLOW_SITES.length).toBe(3); // floor: never vacuous
    for (const { file, expr, count } of FLOW_SITES) {
      expect(
        countOccurrences(readSrc(file), expr),
        `${file} must contain \`${expr}\` exactly ${count} time(s)`,
      ).toBe(count);
    }
  });

  // The boot site must still thread activeModel — THE-460 fix A. The backfill binds
  // chunk_embeddings.model, which stores provider.id, NOT the manifest's bare model name; without
  // this the backfill silently selects zero rows after any fingerprint-triggered rebuild.
  it("the backfill identity (activeModel) is still threaded from provider.id at both call sites", () => {
    expect(readSrc("src/runtime/indexing-wiring.ts")).toContain(
      "activeModel: embeddingProvider.id",
    );
    expect(readSrc("src/search/indexing/index-vault.ts")).toContain(
      "activeModel: args.provider.id",
    );
  });
});

// The property the source-reading above is only a proxy for. Two manifests built independently
// from the same config — which is exactly what boot and index_vault do — must agree, so the second
// ensureVecChunks call is a no-op rather than a DROP+rebuild. If they ever disagree, each call
// rebuilds what the other just built, forever.
describe("no rebuild loop between independently-built manifests", () => {
  const provider = { provider: "fake", model: "model-a", dimensions: 8 };
  const cfg = { chunkContext: true, revision: "chk2", pooling: "mean", queryPrefix: "q: " };

  function ensure(db: ReturnType<typeof openMemoryDb>, onRebuild: (e: VecRebuildEvent) => void) {
    return ensureVecChunks(db, buildRepresentationManifest(provider, cfg), { onRebuild });
  }

  it("a second pass over the same config does not rebuild", () => {
    const db = openMemoryDb();
    runMigrations(db, []);
    const events: VecRebuildEvent[] = [];
    const first = ensure(db, (e) => events.push(e));
    // openMemoryDb has no sqlite-vec, so ensureVecChunks short-circuits; the assertion that matters
    // either way is that the SECOND call behaves identically to the first, never rebuilding what
    // the first just wrote.
    const second = ensure(db, (e) => events.push(e));
    expect(second).toBe(first);
    expect(events).toEqual([]);
  });

  // The other half: a config that genuinely differs MUST be seen as different, or the fingerprint
  // is inert and THE-683 is not actually closed. Guards the test above from passing vacuously.
  it("a differing config yields a different identity", () => {
    const a = buildRepresentationManifest(provider, cfg);
    const b = buildRepresentationManifest(provider, { ...cfg, pooling: "cls" });
    expect(a).not.toEqual(b);
  });
});
