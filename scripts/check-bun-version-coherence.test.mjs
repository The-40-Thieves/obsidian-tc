// Tests for scripts/check-bun-version-coherence.mjs (THE-947).
//
// `bunVersionProblems` is pure and takes its inputs directly, so these run with no filesystem —
// mirroring check-mcp-name.test.mjs's injected-dependency shape. `findBunVersionOccurrences` and
// `readSetupRepoDefault` are pure text-extraction helpers, tested directly against sample text.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bunVersionProblems,
  findBunVersionOccurrences,
  readMiseBunPin,
  readSetupRepoDefault,
} from "./check-bun-version-coherence.mjs";

const PIN = "1.4.0";
const OK_OCCURRENCES = [
  { file: ".github/workflows/ci-native.yml", line: 49, value: "1.4.0" },
  { file: ".github/workflows/ci-server.yml", line: 195, value: "1.4.0" },
];

test("agreeing pin, packageManager, setup-repo default and occurrences pass with no problems", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.4.0",
    occurrences: OK_OCCURRENCES,
    filesScanned: 20,
  });
  assert.deepEqual(problems, []);
});

test("a drifted workflow literal is reported with its file and line", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.4.0",
    occurrences: [
      ...OK_OCCURRENCES,
      { file: ".github/workflows/perf-baseline.yml", line: 76, value: "1.3.14" },
    ],
    filesScanned: 20,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /perf-baseline\.yml:76: bun-version is "1\.3\.14", expected "1\.4\.0"/);
});

test("multiple drifted literals are each reported", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.4.0",
    occurrences: [
      { file: "a.yml", line: 1, value: "1.3.14" },
      { file: "b.yml", line: 2, value: "1.3.14" },
    ],
    filesScanned: 5,
  });
  assert.equal(problems.length, 2);
});

test("a drifted packageManager is reported", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.3.14",
    setupRepoDefault: "1.4.0",
    occurrences: OK_OCCURRENCES,
    filesScanned: 20,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /packageManager is "bun@1\.3\.14", expected "bun@1\.4\.0"/);
});

test("a missing packageManager is reported, not silently accepted", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: undefined,
    setupRepoDefault: "1.4.0",
    occurrences: OK_OCCURRENCES,
    filesScanned: 20,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /packageManager is "\(missing\)"/);
});

test("a drifted setup-repo default is reported", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.3.14",
    occurrences: OK_OCCURRENCES,
    filesScanned: 20,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /setup-repo\/action\.yml's bun-version default is "1\.3\.14"/);
});

test("existence floor: zero files scanned is reported as a broken scanner, not a clean repo", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.4.0",
    occurrences: [],
    filesScanned: 0,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /scanned zero files.*scanner is broken, not the repo clean/);
});

test("existence floor: files scanned but zero occurrences is reported as a broken scanner", () => {
  const problems = bunVersionProblems({
    pin: PIN,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.4.0",
    occurrences: [],
    filesScanned: 22,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /scanned 22 file\(s\).*zero literal `bun-version:` occurrences/);
});

test("a missing mise pin is reported and short-circuits — no authority to check against", () => {
  const problems = bunVersionProblems({
    pin: null,
    packageManager: "bun@1.4.0",
    setupRepoDefault: "1.4.0",
    occurrences: OK_OCCURRENCES,
    filesScanned: 20,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mise\.toml has no `bun = "\.\.\."` pin/);
});

test("readMiseBunPin parses the pin out of the [tools] table", () => {
  const text = `[tools]\nbun = "1.4.0"\nnode = "26.5.0"\n`;
  assert.equal(readMiseBunPin(text), "1.4.0");
});

test("readMiseBunPin returns null when no bun pin is present", () => {
  assert.equal(readMiseBunPin(`[tools]\nnode = "26.5.0"\n`), null);
});

test("findBunVersionOccurrences finds a quoted literal", () => {
  const text =
    "      - uses: oven-sh/setup-bun@abc\n        with:\n          bun-version: '1.4.0'\n";
  const occ = findBunVersionOccurrences(text, "x.yml");
  assert.deepEqual(occ, [{ file: "x.yml", line: 3, value: "1.4.0" }]);
});

test("findBunVersionOccurrences finds an unquoted literal", () => {
  const text = "          bun-version: 1.4.0\n";
  const occ = findBunVersionOccurrences(text, "x.yml");
  assert.deepEqual(occ, [{ file: "x.yml", line: 1, value: "1.4.0" }]);
});

test("findBunVersionOccurrences skips a bare input-declaration key with no value", () => {
  const text = "inputs:\n  bun-version:\n    description: Bun version to install.\n";
  assert.deepEqual(findBunVersionOccurrences(text, "action.yml"), []);
});

test("findBunVersionOccurrences skips a template expression — not a literal", () => {
  // This fixture deliberately embeds GitHub Actions' `${{ ... }}` expression syntax inside a
  // plain double-quoted JS string — it is the fixture's payload, not a forgotten JS template
  // conversion.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: see comment above.
  const text = "        bun-version: ${{ inputs.bun-version }}\n";
  assert.deepEqual(findBunVersionOccurrences(text, "action.yml"), []);
});

test("readSetupRepoDefault extracts the default from the inputs block", () => {
  const text = [
    "inputs:",
    "  bun-version:",
    "    description: Bun version to install.",
    "    required: false",
    "    default: '1.4.0'",
    "  node-required:",
    "    default: 'false'",
  ].join("\n");
  assert.equal(readSetupRepoDefault(text), "1.4.0");
});

test("readSetupRepoDefault returns null when there is no bun-version input", () => {
  assert.equal(readSetupRepoDefault("inputs:\n  node-required:\n    default: 'false'\n"), null);
});
