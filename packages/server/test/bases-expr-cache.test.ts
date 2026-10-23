// Bounded parse cache for the Bases DSL. Every query_base call with a unique expression used to
// add a permanent entry, so the process heap grew without limit.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import {
  BASES_EXPR_CACHE_MAX_ENTRIES,
  BASES_EXPR_CACHE_MAX_SOURCE_CHARS,
  BASES_EXPR_MAX_CHARS,
  parseBasesExpr,
} from "../src/formats/bases-expr";

describe("bases-expr parse cache bounds", () => {
  it("exports the documented limits", () => {
    expect(BASES_EXPR_MAX_CHARS).toBe(16_384);
    expect(BASES_EXPR_CACHE_MAX_ENTRIES).toBe(128);
    expect(BASES_EXPR_CACHE_MAX_SOURCE_CHARS).toBe(262_144);
  });

  it("evicts the oldest entry once more than 128 distinct expressions are parsed", () => {
    const oldest = parseBasesExpr("999 + 999");
    for (let i = 1; i <= 128; i++) parseBasesExpr(`${i} * 2`);
    expect(parseBasesExpr("999 + 999")).not.toBe(oldest);
  });

  it("a cache hit refreshes recency, so the entry that was not touched is evicted first", () => {
    const kept = parseBasesExpr("500 + 1");
    const victim = parseBasesExpr("500 + 2");
    for (let i = 3; i <= 128; i++) parseBasesExpr(`500 + ${i}`);
    expect(parseBasesExpr("500 + 1")).toBe(kept);
    parseBasesExpr("500 + 999");
    expect(parseBasesExpr("500 + 1")).toBe(kept);
    expect(parseBasesExpr("500 + 2")).not.toBe(victim);
  });

  it("evicts the oldest entries when total cached source exceeds the character budget", () => {
    // Each literal is 16,002 chars (under the per-expression cap); 17 of them total 272,034.
    const expr = (i: number): string => `"${String(i).padEnd(16_000, "a")}"`;
    const oldest = parseBasesExpr(expr(0));
    let newest = oldest;
    for (let i = 1; i <= 16; i++) newest = parseBasesExpr(expr(i));
    expect(parseBasesExpr(expr(16))).toBe(newest);
    expect(parseBasesExpr(expr(0))).not.toBe(oldest);
  });

  it("returns the same AST object for a cache hit", () => {
    const first = parseBasesExpr('"hot" + "x"');
    expect(parseBasesExpr('"hot" + "x"')).toBe(first);
  });

  it("accepts an expression of exactly 16384 characters", () => {
    const src = `1${" ".repeat(BASES_EXPR_MAX_CHARS - 1)}`;
    expect(src.length).toBe(16_384);
    expect(() => parseBasesExpr(src)).not.toThrow();
  });

  it("refuses an expression of 16385 characters with unsupported_base_filter, without echoing it", () => {
    const src = `PAYLOAD${" ".repeat(BASES_EXPR_MAX_CHARS + 1 - "PAYLOAD".length)}`;
    expect(src.length).toBe(16_385);
    let caught: unknown;
    try {
      parseBasesExpr(src);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObsidianTcError);
    const e = caught as ObsidianTcError;
    expect(e.code).toBe("unsupported_base_filter");
    expect(e.message).not.toContain("PAYLOAD");
    expect(JSON.stringify(e)).not.toContain("PAYLOAD");
  });
});
