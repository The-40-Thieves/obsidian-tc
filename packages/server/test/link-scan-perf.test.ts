// Regression for the quadratic-time link scanning DoS class. The old MDLINK
// (`/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g`) and WIKILINK (`/(!?)\[\[([^\]\n]+?)\]\]/g`)
// regexes re-scanned to end-of-line from every failed start, so a crafted 80 KB
// line of unclosed brackets measured 11+ seconds under Bun; the inline-code
// marking (a `ranges.some` per link/tag) was a second, independent O(n^2).
//
// Two kinds of assertion per shape (see test/scaling.ts): an absolute bound (generous, so CI load
// does not flake it while still sitting far below the multi-second blowup) and a SCALING check, the
// log-log slope of CPU time over 1x/2x/4x/8x inputs.
import { describe, expect, it } from "vitest";
import { inlineCodeRanges, scanLinks } from "../src/vault/link-scan";
import { extractLinks } from "../src/vault/links";
import { rewriteLinks } from "../src/vault/rewrite";
import { extractInlineTags } from "../src/vault/tags";
import { expectLinear, expectLinearWork } from "./scaling";

// Each case runs several 8x passes; keep it clear of vitest's 5 s default under CI load.
const CASE_TIMEOUT_MS = 60_000;

describe("link scanning stays linear under crafted adversarial input", {
  timeout: CASE_TIMEOUT_MS,
}, () => {
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

  it("inlineCodeRanges alone stays linear over the backtick shape (no per-span objects)", () => {
    // "`x" repeated is one span per 4 bytes. A matchAll scan (a match array plus a tuple per span)
    // took a GC-promotion step at 2 MB: macOS CI measured 5.5 ms, 11.1 ms, 42.9 ms, 102.7 ms
    // (slope 1.46) in 5 of 20 runs (slopes 1.46 to 1.58), and two CI failures at 1.64 against the
    // 1.6 cap. This runs the scan alone, at the same sizes.
    expectLinear("`x", (s) => inlineCodeRanges(s));
  });

  it("the backtick check can fail: a scan that re-copies its span list per match is refused", () => {
    // Control for the case above: same shape, quadratic scan (concat copies every span so far).
    // Counted, not timed (expectLinearWork): a refusal measured on a clock can pass by luck on a
    // fast or coarse-clocked runner, which is what made the sibling control in
    // trace-args-capture.test.ts flake. `tick` charges the copy the concat makes.
    const quadratic = (line: string, tick: (n: number) => void): void => {
      let spans: number[] = [];
      let open = line.indexOf("`");
      while (open >= 0) {
        const close = line.indexOf("`", open + 1);
        if (close < 0) break;
        spans = spans.concat([open, close + 1]);
        tick(spans.length);
        open = line.indexOf("`", close + 1);
      }
    };
    expect(() => expectLinearWork("`x", quadratic, { baseBytes: 2 * 1024 })).toThrow(
      /log-log slope/,
    );
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
