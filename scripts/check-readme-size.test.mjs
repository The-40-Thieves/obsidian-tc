// Tests for scripts/check-readme-size.mjs. Exercises the pure checkReadmeSize function against
// fabricated byte lengths rather than the real README.md, so the test's pass/fail is independent
// of the file's actual current size.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAP_BYTES, checkReadmeSize } from "./check-readme-size.mjs";

test("checkReadmeSize: ok when under the cap", () => {
  const result = checkReadmeSize(100, 200);
  assert.equal(result.ok, true);
});

test("checkReadmeSize: ok when exactly at the cap (boundary is inclusive)", () => {
  const result = checkReadmeSize(200, 200);
  assert.equal(result.ok, true);
});

test("checkReadmeSize: not ok when over the cap, and reports exactly how far over", () => {
  const result = checkReadmeSize(250, 200);
  assert.equal(result.ok, false);
  assert.equal(result.overBy, 50);
});

test("checkReadmeSize: uses the real CAP_BYTES (12288) by default", () => {
  assert.equal(checkReadmeSize(12288).ok, true);
  assert.equal(checkReadmeSize(12289).ok, false);
  assert.equal(CAP_BYTES, 12288);
});
