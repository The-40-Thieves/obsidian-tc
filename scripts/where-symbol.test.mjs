// Tests for scripts/where-symbol.mjs — the classifier that separates code from prose about code.
//
// The load-bearing case is PROSE-ONLY. It is the whole reason the script exists, and it is the one
// that a naive implementation gets wrong by treating ripgrep's line set as "occurrences". These
// cases use the real MAX_JUDGED numbers measured on `citation.ts` (THE-747): ripgrep matches 4
// lines, the parser matches 2, and the 2-line difference is a comment explaining that an
// identically-named constant in ANOTHER file was deleted — prose that reads as evidence for the
// very thing it documents the absence of.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "./where-symbol.mjs";

const DECL = [{ kind: "const", at: "citation.ts:34" }];
const STRUCTURAL = ["citation.ts:34", "citation.ts:434"];
const TEXTUAL = ["citation.ts:34", "citation.ts:262", "citation.ts:265", "citation.ts:434"];

test("separates the declaration from a genuine use", () => {
  const r = classify(DECL, STRUCTURAL, TEXTUAL);
  assert.deepEqual(
    r.declared.map((d) => d.at),
    ["citation.ts:34"],
  );
  assert.deepEqual(r.used, ["citation.ts:434"]); // the declaration line is NOT double-counted
});

test("THE LOAD-BEARING ONE: comment lines land in proseOnly, never in used", () => {
  const r = classify(DECL, STRUCTURAL, TEXTUAL);
  assert.deepEqual(r.proseOnly, ["citation.ts:262", "citation.ts:265"]);
  // The failure this guards: folding prose into `used` would report 3 references where 1 exists.
  assert.equal(r.used.length + r.declared.length, 2);
  assert.equal(TEXTUAL.length, 4);
});

test("a symbol with no binding yields an explicit, checkable zero", () => {
  const r = classify([], [], []);
  assert.equal(r.declared.length, 0);
  assert.deepEqual(r.used, []);
  assert.deepEqual(r.proseOnly, []);
});

test("a symbol that is ONLY prose reports zero code presence, not absence of matches", () => {
  // The shape of a removed symbol whose explanatory comment outlived it — exactly THE-747's
  // reflect.ts MAX_JUDGED, which citation.ts still described after deletion.
  const r = classify([], [], ["citation.ts:262", "args.ts:415"]);
  assert.equal(r.declared.length, 0);
  assert.deepEqual(r.used, []);
  assert.deepEqual(r.proseOnly, ["args.ts:415", "citation.ts:262"]);
});

test("deduplicates repeated hits on one line and sorts deterministically", () => {
  const r = classify([], ["b.ts:2", "b.ts:2", "a.ts:9"], ["b.ts:2", "a.ts:9", "c.ts:1", "c.ts:1"]);
  assert.deepEqual(r.used, ["a.ts:9", "b.ts:2"]);
  assert.deepEqual(r.proseOnly, ["c.ts:1"]);
});

test("importing the module runs no CLI and exits nothing", () => {
  // The isMain guard: a test importing this file must not trigger a process.exit.
  assert.equal(typeof classify, "function");
});
