// Tests for scripts/db-page-report.mjs.
//
// The pure halves are what matter: `attribute` must not silently divide by zero on an empty
// database (that would print NaN% and read as a broken tool rather than an empty file), and
// `hasFlag` must handle the OMIT_* inversion, because OMIT_LOAD_EXTENSION being ABSENT is what
// means extensions ARE available — getting that backwards would report sqlite-vec as unloadable
// on a build that loads it fine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, hasFlag } from "./db-page-report.mjs";

test("attribute: sorts largest first and computes shares", () => {
  const r = attribute([
    { name: "small", bytes: 100 },
    { name: "big", bytes: 900 },
  ]);
  assert.equal(r.total, 1000);
  assert.deepEqual(
    r.rows.map((x) => x.name),
    ["big", "small"],
  );
  assert.equal(r.rows[0].share, 0.9);
});

test("attribute: an empty database yields 0 shares, never NaN", () => {
  const r = attribute([]);
  assert.equal(r.total, 0);
  assert.deepEqual(r.rows, []);
  // and a zero-byte object does not produce NaN either
  const z = attribute([{ name: "empty", bytes: 0 }]);
  assert.equal(z.rows[0].share, 0);
  assert.ok(!Number.isNaN(z.rows[0].share));
});

test("hasFlag: plain flags are presence", () => {
  const opts = ["ENABLE_FTS5", "ENABLE_MATH_FUNCTIONS", "THREADSAFE=1"];
  assert.equal(hasFlag(opts, "ENABLE_FTS5"), true);
  assert.equal(hasFlag(opts, "ENABLE_STAT4"), false);
});

test("hasFlag: OMIT_* is INVERTED — absent means the capability is present", () => {
  // This is the one that would silently lie if written the obvious way.
  assert.equal(hasFlag(["ENABLE_FTS5"], "OMIT_LOAD_EXTENSION", true), true);
  assert.equal(hasFlag(["OMIT_LOAD_EXTENSION"], "OMIT_LOAD_EXTENSION", true), false);
});

test("attribute does not mutate its input", () => {
  const input = [
    { name: "a", bytes: 1 },
    { name: "b", bytes: 2 },
  ];
  attribute(input);
  assert.deepEqual(
    input.map((x) => x.name),
    ["a", "b"],
  );
});
