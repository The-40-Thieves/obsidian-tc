// THE-940 review finding G1 — publish.yml's propagation-wait loop builds the npm version-document
// URL with `enc_id=$(jq -rn --arg n "$identifier" '<filter>')`. An earlier version used jq's
// built-in `@uri`, which percent-encodes EVERY RFC 3986 reserved character, including `@` — so a
// scoped npm identifier (`@the-40-thieves/obsidian-tc-shared`) became
// `%40the-40-thieves%2Fobsidian-tc-shared`, not the `@the-40-thieves%2Fobsidian-tc-shared` shape
// the registry's own npm validator builds (Go's `url.PathEscape` leaves `@` literal — it is a
// valid `pchar` — and escapes only `/`).
//
// This test does NOT reimplement the encoding in JS and check that reimplementation — a JS mirror
// could stay green forever while the actual jq filter embedded in publish.yml silently drifted
// back to something wrong. It extracts the REAL filter text from the workflow file and runs it
// through the REAL `jq` binary (the same one CI's `ubuntu-latest` runner ships), so a regression in
// the embedded expression itself is what this test would catch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW = "publish.yml";
const WORKFLOW_PATH = new URL(`../.github/workflows/${WORKFLOW}`, import.meta.url);

/** Extract the jq filter text from the `enc_id=$(jq -rn --arg n "$identifier" '<filter>')` line.
 *  Throws (never returns undefined) if the line's shape has changed — an extraction that silently
 *  matched nothing would make every test below vacuously inapplicable, not failing. */
function extractIdentifierEncodeFilter() {
  const text = readFileSync(WORKFLOW_PATH, "utf8");
  const m = text.match(/enc_id=\$\(jq -rn --arg n "\$identifier" '([^']*)'\)/);
  if (!m) {
    throw new Error(
      `${WORKFLOW}: could not find the enc_id=$(jq -rn --arg n "$identifier" '...') line — ` +
        "its shape changed, and this test can no longer verify what it actually runs.",
    );
  }
  return m[1];
}

/** Run the extracted filter through the real jq binary, exactly as the workflow step does. */
function encodeViaWorkflowFilter(identifier) {
  const filter = extractIdentifierEncodeFilter();
  return execFileSync("jq", ["-rn", "--arg", "n", identifier, filter], { encoding: "utf8" }).trim();
}

test("the enc_id filter is present and non-empty in publish.yml", () => {
  const filter = extractIdentifierEncodeFilter();
  assert.ok(filter.length > 0);
});

test("an unscoped identifier is unchanged (no slash to encode)", () => {
  assert.equal(encodeViaWorkflowFilter("obsidian-tc"), "obsidian-tc");
});

test("a scoped identifier keeps a literal @ and encodes only the slash — the exact npm registry path shape", () => {
  assert.equal(
    encodeViaWorkflowFilter("@the-40-thieves/obsidian-tc-shared"),
    "@the-40-thieves%2Fobsidian-tc-shared",
  );
});

// THE REGRESSION this test exists to catch: jq's built-in `@uri` also encodes `@` to `%40`.
// Asserting the filter's output does NOT start with "%40" is what would have failed on the
// original bug — a positive assertion on the correct shape (above) could in principle pass by
// coincidence if the filter were rewritten to some other wrong-but-different-shaped transform;
// this pins the specific defect down directly.
test("regression: @ is never percent-encoded (that was the original bug — jq's @uri encodes it to %40)", () => {
  const out = encodeViaWorkflowFilter("@the-40-thieves/obsidian-tc-native");
  assert.ok(!out.includes("%40"), `expected a literal '@', got: ${out}`);
  assert.ok(out.startsWith("@"), `expected the identifier to still start with '@', got: ${out}`);
});

test("a second slash (a plausible future scoped identifier shape) is also encoded", () => {
  // Not a real npm package name (npm allows exactly one '/'), but proves gsub is global (`gsub`,
  // not `sub`) rather than encoding only the first occurrence.
  assert.equal(encodeViaWorkflowFilter("@scope/a/b"), "@scope%2Fa%2Fb");
});
