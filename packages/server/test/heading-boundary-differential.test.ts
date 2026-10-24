// matchHeadingBoundary was rewritten from a regex into a linear scan (the regex backtracked
// super-linearly on long space runs). It decides heading anchors for patch_note and the duplicate
// heading drop, so the rewrite must accept exactly what the regex accepted. This differential runs
// the old regex (kept here as the reference) and the new scan over every short line built from the
// characters that matter, plus random longer ones, and requires identical results.
import { describe, expect, it } from "vitest";
import { matchHeadingBoundary, stripAsciiIndent } from "../src/tools/m1/notes/heading-syntax";

/** The pre-rewrite implementation, verbatim apart from the name. */
function referenceMatch(line: string): { level: number; title: string } | null {
  const { col, rest } = stripAsciiIndent(line);
  if (col > 3) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(rest);
  if (!m) return null;
  const rest2 = m[2] ?? "";
  const title = /^#+[ \t]*$/.test(rest2) ? "" : rest2.replace(/[ \t]+#+[ \t]*$/, "");
  return { level: (m[1] ?? "").length, title: title.trim() };
}

const ALPHABET = ["#", " ", "\t", "a", " ", "\\"];

function* allLines(maxLen: number): Generator<string> {
  yield "";
  let frontier = [""];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const prefix of frontier) for (const ch of ALPHABET) next.push(prefix + ch);
    yield* next;
    frontier = next;
  }
}

/** Deterministic PRNG so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("matchHeadingBoundary agrees with the regex it replaced", () => {
  it("on every line of up to 7 characters over # space tab a NBSP backslash", () => {
    let checked = 0;
    for (const line of allLines(7)) {
      expect(matchHeadingBoundary(line), JSON.stringify(line)).toEqual(referenceMatch(line));
      checked++;
    }
    expect(checked).toBeGreaterThan(300_000);
  });

  it("on 20 000 random lines of up to 40 characters", () => {
    const rnd = lcg(1334);
    const pool = [...ALPHABET, "b", "#", " ", "x y", "##", "  #"];
    for (let i = 0; i < 20_000; i++) {
      let line = "";
      const len = Math.floor(rnd() * 40);
      while (line.length < len) line += pool[Math.floor(rnd() * pool.length)];
      expect(matchHeadingBoundary(line), JSON.stringify(line)).toEqual(referenceMatch(line));
    }
  });
});
