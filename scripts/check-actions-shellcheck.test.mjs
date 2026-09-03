// Tests for scripts/check-actions-shellcheck.mjs (THE-940 review finding N2).
//
// `extractRunBlocks` is pure and filesystem-free, so these run with no git/shellcheck calls —
// mirroring check-workflow-injection.mjs's own block-scalar-by-indentation logic, which this
// function was deliberately written to match (plus its own dedent fix — see the function's
// docstring for why the dedent amount is the block's own content indent, not the `run:` key's).
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRunBlocks } from "./check-actions-shellcheck.mjs";

test("extracts a single block-scalar run: body, dedented to column 0", () => {
  const yaml = [
    "runs:",
    "  using: composite",
    "  steps:",
    "    - id: install",
    "      shell: bash",
    "      run: |",
    "        set -euo pipefail",
    '        echo "hi"',
    "name: after",
  ].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].script, 'set -euo pipefail\necho "hi"\n');
});

test("a blank line inside the block scalar does not end it, and is not falsely used to set the dedent", () => {
  const yaml = ["    run: |", "", "      echo one", "      echo two", "steps:"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 1);
  // The leading blank line carries no indentation of its own; the dedent amount comes from the
  // first NON-blank line ("      echo one"), not from the blank line's (zero) indent.
  assert.equal(blocks[0].script, "\necho one\necho two\n");
});

test("multiple steps each contribute their own block", () => {
  const yaml = ["steps:", "  - run: |", "      echo first", "  - run: |", "      echo second"].join(
    "\n",
  );
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].script, "echo first\n");
  assert.equal(blocks[1].script, "echo second\n");
});

test("an inline `run: cmd` is extracted as its own one-line block (G5 fix), alongside a block scalar", () => {
  const yaml = ["steps:", "  - run: echo inline", "  - run: |", "      echo block"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].script, "echo inline\n");
  assert.equal(blocks[1].script, "echo block\n");
});

test("an inline run:'s startLine points at the run: line itself (no separate body line exists)", () => {
  const yaml = ["name: x", "steps:", "  - run: echo hi"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 3);
});

test("multiple inline run: steps each contribute their own block", () => {
  const yaml = ["steps:", "  - run: echo one", "  - run: echo two"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].script, "echo one\n");
  assert.equal(blocks[1].script, "echo two\n");
});

test("a bare run: with nothing after it and no following indented lines is not treated as inline", () => {
  const yaml = ["steps:", "  - run:", "  - name: next step"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.deepEqual(blocks, []);
});

test("a run: block scalar immediately followed by a shallower line extracts an empty script, not a crash", () => {
  const yaml = ["  - run: |", "steps:"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].script, "");
});

test("no run: keys at all yields zero blocks", () => {
  assert.deepEqual(extractRunBlocks("name: x\ndescription: y\n"), []);
});

test("startLine points at the first line of the script body", () => {
  const yaml = ["name: x", "steps:", "  - run: |", "      echo here"].join("\n");
  const blocks = extractRunBlocks(yaml);
  // Line 3 is `- run: |` (0-indexed 2); the body starts on line 4.
  assert.equal(blocks[0].startLine, 4);
});

test("a block open at end-of-file is still closed and returned (no trailing terminator needed)", () => {
  const yaml = ["steps:", "  - run: |", "      echo last"].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].script, "echo last\n");
});
