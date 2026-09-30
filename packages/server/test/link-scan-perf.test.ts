// Regression for the quadratic-time link scanning DoS class. The old MDLINK
// (`/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g`) and WIKILINK (`/(!?)\[\[([^\]\n]+?)\]\]/g`)
// regexes re-scanned to end-of-line from every failed start, so a crafted 80 KB
// line of unclosed brackets measured 11+ seconds under Bun; the inline-code
// marking (a `ranges.some` per link/tag) was a second, independent O(n^2).
//
// Two kinds of assertion per shape: an absolute bound (generous, so CI load does not
// flake it while still sitting far below the multi-second blowup) and a SCALING
// check — the best-of-5 time of a 4x larger input over the best-of-5 time of the base
// input must stay well under the 16x a quadratic path costs (a linear path costs
// ~4x; the cap is 6 to absorb timer/GC noise).
import { describe, expect, it } from "vitest";
import { scanLinks } from "../src/vault/link-scan";
import { extractLinks } from "../src/vault/links";
import { rewriteLinks } from "../src/vault/rewrite";
import { extractInlineTags } from "../src/vault/tags";

const BASE = 80 * 1024;
const LARGE = 4 * BASE;
const BOUND_MS = 200;
const LARGE_BOUND_MS = 4 * BOUND_MS;
const MAX_SCALING_RATIO = 6;

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// Best of `runs`, not the median: scheduler and GC noise on a shared CI box only ever ADDS time,
// so the minimum is the least-noisy estimate of the true cost (a median over a loaded box measured
// 3x spread across identical runs, the minimum did not).
function bestMs(fn: () => void, runs = 5): number {
  return Math.min(...Array.from({ length: runs }, () => timeMs(fn)));
}

/** Build a `bytes`-sized input from a repeated unit. */
function repeatTo(unit: string, bytes: number): string {
  return unit.repeat(Math.ceil(bytes / unit.length));
}

/** Time `run` over a BASE and a 4x LARGE input of `unit`; assert both absolute bounds and scaling. */
function expectLinear(unit: string, run: (input: string) => void): void {
  const base = repeatTo(unit, BASE);
  const large = repeatTo(unit, LARGE);
  run(base); // warm-up: keep JIT compilation out of the timed samples
  const tBase = bestMs(() => run(base));
  const tLarge = bestMs(() => run(large));
  expect(tBase).toBeLessThan(BOUND_MS);
  expect(tLarge).toBeLessThan(LARGE_BOUND_MS);
  // Floor the denominator at 10 ms: a linear pass over 80 KB costs a few ms, where timer and GC
  // noise dominate the ratio. A quadratic path is already >100 ms at BASE, far above the floor.
  expect(tLarge / Math.max(tBase, 10)).toBeLessThan(MAX_SCALING_RATIO);
}

describe("link scanning stays linear under crafted adversarial input", () => {
  it("MDLINK: many unclosed '[a](' via extractLinks", () => {
    expectLinear("[a](", (s) => extractLinks(s));
  });

  it("WIKILINK: many unclosed '[[a' via extractLinks", () => {
    expectLinear("[[a", (s) => extractLinks(s));
  });

  it("MDLINK via rewriteLinks: many unclosed '[a]('", () => {
    expectLinear("[a](", (s) => rewriteLinks(s, () => null));
  });

  it("WIKILINK via rewriteLinks: many unclosed '[[a'", () => {
    expectLinear("[[a", (s) => rewriteLinks(s, () => null));
  });

  it("rewriteLinks over many CLOSED links that the resolver rewrites", () => {
    expectLinear("[[a|b]] [c](d) ", (s) => rewriteLinks(s, () => "x"));
  });

  it("scanLinks (prune's single alternation): unclosed and closed shapes", () => {
    expectLinear("[a](", (s) => scanLinks(s));
    expectLinear("[[a", (s) => scanLinks(s));
    expectLinear("[[a]] [b](c) ", (s) => scanLinks(s));
  });

  it("unclosed backtick runs stay linear (already true; guard against a future regression)", () => {
    expectLinear("`x", (s) => extractLinks(s));
  });

  it("inline-code spans interleaved with links: extractLinks marks code in O(n log n)", () => {
    // 10 bytes per unit: one code span and one link. A `ranges.some` per link made this
    // quadratic (23 s at 640 KB).
    expectLinear("`a`[b](c) ", (s) => extractLinks(s));
    expectLinear("`a`[[b]] ", (s) => extractLinks(s));
  });

  it("inline-code spans interleaved with hashtags: extractInlineTags marks code in O(n log n)", () => {
    // 7 bytes per unit: one code span and one tag (measured 21.8 s at 448 KB before the fix).
    expectLinear("`a` #t ", (s) => extractInlineTags(s));
  });
});
