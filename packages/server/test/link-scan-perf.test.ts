// Regression for the quadratic-time link scanning DoS class. The old MDLINK
// (`/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g`) and WIKILINK (`/(!?)\[\[([^\]\n]+?)\]\]/g`)
// regexes re-scanned to end-of-line from every failed start, so a crafted 80 KB
// line of unclosed brackets measured 11+ seconds under Bun; the inline-code
// marking (a `ranges.some` per link/tag) was a second, independent O(n^2).
//
// Every assertion is on COUNTED work (expectLinearWork in test/scaling.ts), not time: the log-log
// slope of the steps the scanners report over 1x/2x/4x/8x inputs. A clock flaked here
// (windows-latest, node 24: 7.7 ms, 15.1 ms, 45.8 ms, 442.6 ms over 256 KB..2 MB, slope 1.92 on
// linear code), because one GC pause at the largest size moves a four-point fit. The scanners
// report their steps through the work probe in src/vault/link-scan.ts, and `countStringOps` adds
// the String.prototype searches and copies they make; the same input does the same work on every
// runner. The `minWorkPerByte` floor fails a counter that went silent instead of passing vacuously.
import { describe, expect, it } from "vitest";
import {
  inCodeRange,
  inlineCodeRanges,
  scanLinks,
  scanMdLinks,
  setLinkScanWorkProbe,
} from "../src/vault/link-scan";
import { extractLinks } from "../src/vault/links";
import { rewriteLinks } from "../src/vault/rewrite";
import { extractInlineTags } from "../src/vault/tags";
import { expectLinearWork } from "./scaling";

// Counted work is exact, so the inputs only have to be big enough to show the shape.
const BASE_BYTES = 16 * 1024;
// The quadratic controls below are real scans (indexOf walks): keep their 8x pass cheap.
// Work per input byte, measured at every size (slope 1.00 to 1.06) and bracketed ~2x each way: the
// floor is the existence check for the counter, the ceiling refuses a return of a large linear
// constant (the old regexes did thousands of steps per byte on these shapes).
const FLOORS = {
  extractUnclosed: { minWorkPerByte: 3, maxWorkPerByte: 12 }, // measured 6.0
  rewriteUnclosed: { minWorkPerByte: 2, maxWorkPerByte: 10 }, // 4.0 to 5.0
  rewriteClosed: { minWorkPerByte: 4, maxWorkPerByte: 18 }, // 8.9
  scanUnclosed: { minWorkPerByte: 1.5, maxWorkPerByte: 6 }, // 3.0
  scanClosed: { minWorkPerByte: 2, maxWorkPerByte: 8 }, // 3.8
  extractBacktick: { minWorkPerByte: 3, maxWorkPerByte: 12 }, // 6.3
  codeRangesAlone: { minWorkPerByte: 0.6, maxWorkPerByte: 3 }, // 1.25
  codeAndLink: { minWorkPerByte: 4, maxWorkPerByte: 16 }, // 8.1 to 8.3
  codeAndTag: { minWorkPerByte: 1.7, maxWorkPerByte: 7 }, // 3.5
};
const CONTROL_BYTES = 2 * 1024;

/** Run `fn` with the link-scan work probe feeding `tick`; always uninstalls it. */
function probed(fn: (s: string) => unknown): (s: string, tick: (n: number) => void) => void {
  return (s, tick) => {
    setLinkScanWorkProbe(tick);
    try {
      fn(s);
    } finally {
      setLinkScanWorkProbe(null);
    }
  };
}

/** Linear subject: counted work grows with the input and sits between the floor and ceiling. */
function expectLinearScan(
  unit: string,
  fn: (s: string) => unknown,
  { minWorkPerByte, maxWorkPerByte }: { minWorkPerByte: number; maxWorkPerByte: number },
): void {
  expectLinearWork(unit, probed(fn), {
    baseBytes: BASE_BYTES,
    countStringOps: true,
    minWorkPerByte,
    maxWorkPerByte,
  });
}

describe("link scanning stays linear under crafted adversarial input", () => {
  it("MDLINK: many unclosed '[a](' via extractLinks", () => {
    expectLinearScan("[a](", (s) => extractLinks(s), FLOORS.extractUnclosed);
  });

  it("WIKILINK: many unclosed '[[a' via extractLinks", () => {
    expectLinearScan("[[a", (s) => extractLinks(s), FLOORS.extractUnclosed);
  });

  it("MDLINK via rewriteLinks: many unclosed '[a]('", () => {
    expectLinearScan("[a](", (s) => rewriteLinks(s, () => null), FLOORS.rewriteUnclosed);
  });

  it("WIKILINK via rewriteLinks: many unclosed '[[a'", () => {
    expectLinearScan("[[a", (s) => rewriteLinks(s, () => null), FLOORS.rewriteUnclosed);
  });

  it("rewriteLinks over many CLOSED links that the resolver rewrites", () => {
    expectLinearScan("[[a|b]] [c](d) ", (s) => rewriteLinks(s, () => "x"), FLOORS.rewriteClosed);
  });

  it("scanLinks (prune's single alternation): unclosed and closed shapes", () => {
    expectLinearScan("[a](", (s) => scanLinks(s), FLOORS.scanUnclosed);
    expectLinearScan("[[a", (s) => scanLinks(s), FLOORS.scanUnclosed);
    expectLinearScan("[[a]] [b](c) ", (s) => scanLinks(s), FLOORS.scanClosed);
  });

  it("unclosed backtick runs stay linear (already true; guard against a future regression)", () => {
    expectLinearScan("`x", (s) => extractLinks(s), FLOORS.extractBacktick);
  });

  it("inlineCodeRanges alone stays linear over the backtick shape (no per-span objects)", () => {
    // "`x" repeated is one span per 4 bytes. A matchAll scan (a match array plus a tuple per span)
    // took a GC-promotion step at 2 MB and failed the clock-based slope cap on macOS CI. That is
    // an allocation cost, which a step count cannot see; the no-per-span-object property lives in
    // the flat-list return type, and this case guards the scan's own step growth.
    expectLinearScan("`x", (s) => inlineCodeRanges(s), FLOORS.codeRangesAlone);
  });

  it("inline-code spans interleaved with links: extractLinks marks code in O(n log n)", () => {
    // 10 bytes per unit: one code span and one link. A `ranges.some` per link made this
    // quadratic (23 s at 640 KB). The binary search costs log(spans) steps per link, so the
    // per-byte ceiling is wider than for the flat scans, but its growth stays far under linear.
    expectLinearScan("`a`[b](c) ", (s) => extractLinks(s), FLOORS.codeAndLink);
    expectLinearScan("`a`[[b]] ", (s) => extractLinks(s), FLOORS.codeAndLink);
  });

  it("inline-code spans interleaved with hashtags: extractInlineTags marks code in O(n log n)", () => {
    // 7 bytes per unit: one code span and one tag (measured 21.8 s at 448 KB before the fix).
    expectLinearScan("`a` #t ", (s) => extractInlineTags(s), FLOORS.codeAndTag);
  });
});

describe("the work-based scaling check can fail (RED controls)", () => {
  // Each control is a deliberately quadratic variant of one scanner, run through the same counter
  // and the same slope cap; refusing it is what makes the passing cases above mean something.
  const refused = /log-log slope/;

  it("a scanner that re-searches to end-of-line from every failed '[' (the old regex shape) is refused", () => {
    // The shape the original MDLINK regex had, in plain string operations: every "[" looks for its
    // "]" with an indexOf that walks to the end of the line when none exists. Uninstrumented, so
    // the work is what `countStringOps` charges for those walks.
    const rescan = (line: string): void => {
      for (let i = line.indexOf("["); i >= 0; i = line.indexOf("[", i + 1)) {
        const close = line.indexOf("]", i + 1);
        if (close >= 0 && line[close + 1] === "(") line.indexOf(")", close + 2);
      }
    };
    expect(() =>
      expectLinearWork("[a](", (s) => rescan(s), {
        baseBytes: CONTROL_BYTES,
        countStringOps: true,
      }),
    ).toThrow(refused);
    expect(() =>
      expectLinearWork("[[a", (s) => rescan(s), { baseBytes: CONTROL_BYTES, countStringOps: true }),
    ).toThrow(refused);
  });

  it("a code-range lookup that scans every span per link (`ranges.some`) is refused", () => {
    // Real scanMdLinks and inlineCodeRanges, then the per-link linear membership test that made
    // "`a`[b](c) " quadratic; `tick` charges the spans each lookup walks.
    const someLookup = (line: string, tick: (n: number) => void): void => {
      const ranges = inlineCodeRanges(line);
      for (const m of scanMdLinks(line)) {
        let inside = false;
        for (let k = 0; k < ranges.length && !inside; k += 2) {
          tick(1);
          inside = m.start >= (ranges[k] as number) && m.start < (ranges[k + 1] as number);
        }
      }
    };
    expect(() => expectLinearWork("`a`[b](c) ", someLookup, { baseBytes: CONTROL_BYTES })).toThrow(
      refused,
    );
    // Same lookup through the real binary search passes the same check: the control differs only
    // in the algorithm.
    const binaryLookup = (line: string, tick: (n: number) => void): void => {
      setLinkScanWorkProbe(tick);
      try {
        const ranges = inlineCodeRanges(line);
        for (const m of scanMdLinks(line)) inCodeRange(ranges, m.start);
      } finally {
        setLinkScanWorkProbe(null);
      }
    };
    expect(() =>
      expectLinearWork("`a`[b](c) ", binaryLookup, { baseBytes: CONTROL_BYTES }),
    ).not.toThrow();
  });

  it("a backtick scan that re-copies its span list per match is refused", () => {
    // Same shape as the inlineCodeRanges case, quadratic scan (concat copies every span so far).
    // `tick` charges the copy the concat makes.
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
    expect(() => expectLinearWork("`x", quadratic, { baseBytes: 2 * 1024 })).toThrow(refused);
  });

  it("a silent counter is refused: the work floor fails when the subject reports nothing", () => {
    expect(() =>
      expectLinearWork("[a](", () => {}, { baseBytes: CONTROL_BYTES, minWorkPerByte: 0.5 }),
    ).toThrow(/work per byte/);
  });
});
