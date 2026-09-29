// RED regression for the quadratic-time link regex (DoS class). MDLINK
// (`/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g`) and WIKILINK
// (`/(!?)\[\[([^\]\n]+?)\]\]/g`) each backtrack across every failed start
// position when a line is full of unclosed brackets — a crafted 80 KB line
// measured at 11+ seconds under Bun before the linear scanner replaced them.
// Bound is generous (200ms for 80KB, on a box that does real work in low
// single-digit ms) so it stays robust to CI load while sitting nowhere near
// the multi-second quadratic blowup it guards against.
import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/vault/links";
import { rewriteLinks } from "../src/vault/rewrite";

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// Two independently-scaling knobs so a quadratic implementation shows up as a
// >4x time increase for a 4x input increase, not just "slow".
const SMALL = 20 * 1024;
const LARGE = 80 * 1024;
const BOUND_MS = 200;

describe("link scanning stays linear under crafted adversarial input", () => {
  it("MDLINK: many unclosed '[a](' does not blow up quadratically", () => {
    const small = "[a](".repeat(SMALL / 4);
    const large = "[a](".repeat(LARGE / 4);
    const tSmall = timeMs(() => extractLinks(small));
    const tLarge = timeMs(() => extractLinks(large));
    expect(tLarge).toBeLessThan(BOUND_MS);
    expect(tSmall).toBeLessThan(BOUND_MS);
  });

  it("WIKILINK: many unclosed '[[a' does not blow up quadratically", () => {
    const small = "[[a".repeat(SMALL / 3);
    const large = "[[a".repeat(LARGE / 3);
    const tSmall = timeMs(() => extractLinks(small));
    const tLarge = timeMs(() => extractLinks(large));
    expect(tLarge).toBeLessThan(BOUND_MS);
    expect(tSmall).toBeLessThan(BOUND_MS);
  });

  it("MDLINK via rewriteLinks: many unclosed '[a](' does not blow up quadratically", () => {
    const large = "[a](".repeat(LARGE / 4);
    const t = timeMs(() => rewriteLinks(large, () => null));
    expect(t).toBeLessThan(BOUND_MS);
  });

  it("WIKILINK via rewriteLinks: many unclosed '[[a' does not blow up quadratically", () => {
    const large = "[[a".repeat(LARGE / 3);
    const t = timeMs(() => rewriteLinks(large, () => null));
    expect(t).toBeLessThan(BOUND_MS);
  });

  it("unclosed backtick runs stay linear (already true; guard against a future regression)", () => {
    const large = "`x".repeat(LARGE / 2);
    const t = timeMs(() => extractLinks(large));
    expect(t).toBeLessThan(BOUND_MS);
  });
});
