// Review round 2 (Important): the mutation sweep in task-7-report.md found that deleting
// `rerankerConfigured: config.reranker?.provider,` from doctor.ts's `retrieval: {` object leaves
// all of doctor-generic-provider.test.ts and doctor-checks.test.ts green — those tests only
// exercise retrievalHeadsCheck() directly, never run_doctor()'s config-to-view wiring. A deleted
// line there would silently revert doctor to the old wrong "gateway-only" message for every
// reranker-configured setup, with nothing failing.
//
// A full CLI integration test (config file + capability profile + bridge probing) is
// disproportionate for pinning one object property. Following the source-scan idiom already
// established on this branch in provider-revision-site-parity.test.ts: read the source, anchor on
// the `retrieval: {` object literal doctor.ts builds for assembleDoctorReport, and assert the
// literal expression appears within a bounded window past that anchor — not merely somewhere in
// the file — with a length/count floor so the test cannot go vacuous if the anchor stops matching.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSrc(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

const SITE = {
  file: "src/cli/commands/doctor.ts",
  anchor: "retrieval: {",
  expr: "rerankerConfigured: config.reranker?.provider,",
};

describe("doctor CLI wiring: rerankerConfigured passthrough", () => {
  it("run_doctor's retrieval object folds config.reranker?.provider into rerankerConfigured", () => {
    expect(SITE.expr.length).toBeGreaterThan(0); // floor: never vacuous
    const src = readSrc(SITE.file);
    const anchorAt = src.indexOf(SITE.anchor);
    expect(anchorAt, `${SITE.file} builds a \`${SITE.anchor}\` object`).toBeGreaterThanOrEqual(0);
    // A generous window past the anchor — the retrieval object literal itself, not the whole
    // file — so a match elsewhere (e.g. a stray comment or another object literal) does not pass.
    const window = src.slice(anchorAt, anchorAt + 700);
    expect(
      window,
      `${SITE.file}'s retrieval object must fold \`${SITE.expr}\` so a generic provider's configured reranker reaches retrievalHeadsCheck instead of being silently dropped`,
    ).toContain(SITE.expr);
  });
});
