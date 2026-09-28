// THE-1122 review round 2 (Medium 5): `derivedTables`'s `multiVector` predicate used to read
// `config.embeddings.provider` BEFORE `embeddingsStickyResolution` was computed and applied — an
// unconfigured install that sticky-resolved to "bge-m3" (a multiVector provider) from its own
// stored index reported chunk_sparse/chunk_colbert as DISABLED (schema-defaulted "local", not
// multiVector) in `derivedTables`, while `retrieval.multiVector` a few dozen lines later read the
// SAME config object AFTER the mutation and reported them enabled — a self-contradicting report
// from one `doctor` run.
//
// Same source-scan idiom doctor-cli-reranker-wiring.test.ts already established on this branch
// for exactly this class of bug (a shared value that must be computed/applied ONCE, in the right
// order, or two readers of the same config object can silently disagree): a full run_doctor()
// integration test needs a real cache.db, a full capability-profile probe, and stdout/process.exit
// interception to pin one statement-ordering property that a source position assertion pins
// directly and far more cheaply.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSrc(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("doctor CLI wiring: sticky embeddings resolution runs BEFORE derivedTables (THE-1122 round 2)", () => {
  it("applies embeddingsStickyResolution's mutation earlier in run_doctor than the probeDerivedTables(...) call that reads config.embeddings.provider for multiVector", () => {
    const src = readSrc("src/cli/commands/doctor.ts");

    const mutationMarker = 'embeddingsStickyResolution?.source === "kept-from-index"';
    const mutationAt = src.indexOf(mutationMarker);
    expect(
      mutationAt,
      "run_doctor must apply the sticky resolution's mutation",
    ).toBeGreaterThanOrEqual(0);
    // Never a SECOND occurrence — a duplicated resolve-and-mutate block is exactly the kind of
    // drift this test exists to catch (two readers of config.embeddings could then each see a
    // DIFFERENT one of the two mutations, depending on which ran last).
    expect(src.indexOf(mutationMarker, mutationAt + 1)).toBe(-1);

    const derivedTablesMarker = "await probeDerivedTables(config.cacheDir, busyTimeoutMs, {";
    const derivedTablesAt = src.indexOf(derivedTablesMarker);
    expect(
      derivedTablesAt,
      "run_doctor must call probeDerivedTables with the multiVector predicate",
    ).toBeGreaterThanOrEqual(0);

    expect(
      mutationAt,
      "the sticky-embeddings mutation must run BEFORE probeDerivedTables reads " +
        "config.embeddings.provider for its multiVector predicate — otherwise derivedTables and " +
        "retrieval.multiVector (which DOES read config.embeddings.provider after the mutation) can " +
        "classify chunk_sparse/chunk_colbert differently within the SAME doctor report",
    ).toBeLessThan(derivedTablesAt);

    // And the multiVector predicate itself, within the probeDerivedTables call, must still read
    // config.embeddings.provider (not some frozen pre-mutation copy) — the whole point is that it
    // observes the ALREADY-mutated value.
    const window = src.slice(derivedTablesAt, derivedTablesAt + 400);
    expect(window).toContain('config.embeddings.provider === "bge-m3"');
  });
});
