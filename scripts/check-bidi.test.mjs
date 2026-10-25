// Tests for scripts/check-bidi.mjs. The red cases are built from the exact code points the
// repo really carried (U+200B, U+200E, U+200F, U+202A, U+202C, U+202E, U+2060, U+2066, U+2069,
// U+FEFF), so the test exercises the characters the gate exists for, not invented ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import { floorProblem, MIN_SCANNED_FILES, scanText } from "./check-bidi.mjs";

const cp = (n) => String.fromCodePoint(n);
const BIDI_FOUND = [0x202a, 0x202c, 0x202e, 0x2066, 0x2069];
const ZERO_WIDTH_FOUND = [0x200b, 0x200e, 0x200f, 0x2060, 0xfeff];

for (const n of BIDI_FOUND) {
  test(`literal bidi control U+${n.toString(16).toUpperCase()} is reported in a source file`, () => {
    const hits = scanText("packages/server/src/x.ts", `const a = "x${cp(n)}y";`);
    assert.deepEqual(hits, [
      { line: 1, codepoint: `U+${n.toString(16).toUpperCase()}`, kind: "bidi control" },
    ]);
  });

  test(`literal bidi control U+${n.toString(16).toUpperCase()} is reported in Markdown too`, () => {
    const hits = scanText("docs/page.md", `text${cp(n)}`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "bidi control");
  });
}

for (const n of ZERO_WIDTH_FOUND) {
  test(`literal zero-width U+${n.toString(16).toUpperCase()} is reported in source`, () => {
    const hits = scanText("packages/server/test/x.test.ts", `const z = "a${cp(n)}b";`);
    assert.deepEqual(hits, [
      { line: 1, codepoint: `U+${n.toString(16).toUpperCase()}`, kind: "zero-width" },
    ]);
  });

  test(`literal zero-width U+${n.toString(16).toUpperCase()} is allowed in Markdown prose`, () => {
    assert.deepEqual(scanText("CHANGELOG.md", `i${cp(n)}gnore`), []);
  });
}

test("a bidi control inside a regex class on a later line reports that line", () => {
  const text = `const ok = 1;\nconst re = /[${cp(0x202e)}-${cp(0x202e)}]/;\n`;
  const hits = scanText("packages/server/src/p.ts", text);
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 2],
  );
});

test("the escaped form is clean: a backslash-u spelling is text, not the character", () => {
  assert.deepEqual(scanText("packages/server/src/p.ts", "const re = /[\\u202A-\\u202E]/;"), []);
  assert.deepEqual(scanText("packages/server/src/p.ts", 'const s = "\\u200B\\uFEFF";'), []);
});

test("ordinary text, including astral and CJK characters, is clean", () => {
  assert.deepEqual(scanText("packages/server/src/p.ts", "héllo 世界 😀 — ok"), []);
});

test("the scan floor passes above the minimum and names the count below it", () => {
  assert.equal(floorProblem(MIN_SCANNED_FILES + 1), null);
  const problem = floorProblem(0);
  assert.match(problem, /scanned 0 tracked files/);
  assert.match(problem, /file list is wrong/);
});
