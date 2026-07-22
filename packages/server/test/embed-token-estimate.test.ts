// THE-487: the embed-batch token budget used chars/4, which undercounts link-dense Markdown by
// ~2-2.5x (acknowledged in-code). Batches then overflowed the provider's n_ctx, got rejected
// (400/413), and embedSubBatch bisected + retried — roughly doubling embed latency on affected
// batches on local Ollama.
//
// Fix: a punctuation-density-aware divisor. Prose (few specials) keeps chars/4 — so batch throughput
// on prose-heavy vaults does NOT regress. Link-dense text (many [[...]], |, /, brackets) tightens to
// chars/3, a conservative estimate that keeps a dense batch under n_ctx. Zero-dependency; a real
// tokenizer is the follow-up only if measurement shows residual retries.
import { describe, expect, it } from "vitest";
import { estimateEmbedTokens } from "../src/search/indexer";

describe("THE-487 embed token estimate", () => {
  it("keeps chars/4 for prose (no throughput regression)", () => {
    // Plain prose: special-char density is low, so the divisor stays 4.
    const prose = "the quick brown fox jumps over the lazy dog and then runs away quickly";
    expect(estimateEmbedTokens(prose)).toBe(Math.ceil(prose.length / 4));
  });

  it("estimates more conservatively for link-dense markdown than the old chars/4", () => {
    // A wikilink/table-dense line: brackets, pipes, slashes fragment tokenization.
    const dense = "[[02-projects/foo-bar|Foo]] | [[09-ref/baz-qux|Baz]] | see https://ex.com/a/b/c";
    const old = Math.ceil(dense.length / 4);
    expect(estimateEmbedTokens(dense)).toBeGreaterThan(old);
  });

  it("uses the chars/3 conservative divisor on high special-char density", () => {
    const dense = `${"|".repeat(30)}abc`; // ~91% special chars
    expect(estimateEmbedTokens(dense)).toBe(Math.ceil(dense.length / 3));
  });

  it("is 0 for empty text and monotonic in length", () => {
    expect(estimateEmbedTokens("")).toBe(0);
    expect(estimateEmbedTokens("aaaa")).toBeLessThan(estimateEmbedTokens("aaaaaaaa"));
  });
});
