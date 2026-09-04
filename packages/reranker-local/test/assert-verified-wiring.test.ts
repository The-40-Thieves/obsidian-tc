// THE-944 review round 3 (G2): a source-scan pin, in the SAME style round 1's
// reranker-auto-select-gate.test.ts used for the shared auto-select rule — the round-2 re-review's
// own reproduction: deleting `await assertVerified(modelDir);` from src/index.ts's `loadSession`
// left the package suite at 42/42 passed (verified WITH the real weights present, so
// test/integration.test.ts genuinely ran rather than skipping). `assertVerified` closes the TOCTOU
// window between `fetchAndVerifyModel`'s own verification and the `from_pretrained` calls — a
// correct function whose only production call site could be deleted silently is not wired in, it
// just exists. This pins BOTH that the call is present AND that it runs BEFORE the
// @huggingface/transformers import (the whole point: refuse before ever touching the runtime).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSrc(): string {
  return readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
}

describe("src/index.ts wires assertVerified into loadSession (THE-944 review round 3, G2)", () => {
  it("imports assertVerified from ./model-fetch.js", () => {
    const src = readSrc();
    expect(src).toMatch(
      /import\s*\{[^}]*\bassertVerified\b[^}]*\}\s*from\s*"\.\/model-fetch\.js";/,
    );
  });

  it("calls assertVerified(modelDir) inside loadSession (not just imports it)", () => {
    const src = readSrc();
    expect(src).toContain("await assertVerified(modelDir);");
  });

  it("calls assertVerified BEFORE the @huggingface/transformers dynamic import — refuse before ever touching the runtime", () => {
    const src = readSrc();
    const assertVerifiedAt = src.indexOf("await assertVerified(modelDir);");
    // "await import(" is a stable, reformat-resilient anchor — this file has exactly ONE dynamic
    // import (the whole point of the module's own header comment: @huggingface/transformers is
    // never a static import), so this cannot accidentally match the wrong call site.
    const transformersImportAt = src.indexOf("await import(");
    expect(assertVerifiedAt, "assertVerified call site must exist").toBeGreaterThan(-1);
    expect(
      transformersImportAt,
      "transformers dynamic import call site must exist",
    ).toBeGreaterThan(-1);
    expect((src.match(/await import\(/g) ?? []).length, "exactly one dynamic import expected").toBe(
      1,
    );
    expect(assertVerifiedAt).toBeLessThan(transformersImportAt);
  });

  it("both calls happen inside loadSession, after fetchAndVerifyModel and before the tokenizer/model load", () => {
    // A coarser, reformat-resilient companion to the two precise pins above: the whole
    // fetchAndVerifyModel -> assertVerified -> transformers-import -> from_pretrained sequence,
    // in order, within one bounded window (loadSession's own IIFE body is not large).
    const src = readSrc();
    const loadSessionAt = src.indexOf("async function loadSession(");
    expect(loadSessionAt).toBeGreaterThan(-1);
    const window = src.slice(loadSessionAt, loadSessionAt + 4000);
    const fetchAt = window.indexOf("await fetchAndVerifyModel(");
    const assertAt = window.indexOf("await assertVerified(");
    const fromPretrainedAt = window.indexOf("from_pretrained(");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(fetchAt);
    expect(fromPretrainedAt).toBeGreaterThan(assertAt);
  });
});
