// Tests for scripts/check-comment-style.mjs — the CONTRIBUTING.md "Inline commentary" (#850)
// enforcement gate. node:test rather than vitest, for the reason check-boundaries.test.mjs
// documents: scripts/ sits outside every workspace glob and no root vitest config reaches it.
// `node --test scripts/*.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  commentLineCount,
  evaluateRatchet,
  extractComments,
  findViolations,
  isGeneratedFile,
  loadBaseline,
  scopeFiles,
  stripQuotedProse,
} from "./check-comment-style.mjs";

// ---- extractComments -------------------------------------------------------------------------

test("extractComments finds a line comment and reports its real 1-based line", () => {
  const source = "const a = 1;\nconst b = 2;\n// a note here\nconst c = 3;";
  const comments = extractComments(source);
  assert.deepEqual(
    comments.map((c) => [c.type, c.text, c.startLine]),
    [["line", " a note here", 3]],
  );
});

test("extractComments finds a block comment and reports its start AND end line", () => {
  const source = ["const a = 1;", "/**", " * line one", " * line two", " */", "const b = 2;"].join(
    "\n",
  );
  const comments = extractComments(source);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].type, "block");
  assert.equal(comments[0].startLine, 2);
  assert.equal(comments[0].endLine, 5);
});

test("extractComments: a string literal containing '// CORRECTED 2026' is not read as a comment", () => {
  const source = 'const msg = "// CORRECTED 2026-01-01: not a real banner";\n// real comment';
  const comments = extractComments(source);
  assert.deepEqual(
    comments.map((c) => c.text.trim()),
    ["real comment"],
  );
});

test("extractComments: a template literal spanning multiple lines does not fool line tracking", () => {
  const source = ["const t = `line one", "line two", "line three`;", "// after"].join("\n");
  const comments = extractComments(source);
  assert.equal(comments.length, 1);
  // The template consumed lines 1-3; the trailing line comment must report line 4, not line 2.
  assert.equal(comments[0].startLine, 4);
});

test("extractComments: a template literal containing a banner-shaped string is inert", () => {
  const source = "const t = `we measured this at 40ms, VERIFIED 2026-01-01`;\nconst x = 1;";
  const comments = extractComments(source);
  assert.deepEqual(comments, []);
});

test("extractComments handles an escaped quote inside a string without ending it early", () => {
  const source = 'const s = "a \\"quoted\\" word // not a comment";\n// real';
  const comments = extractComments(source);
  assert.deepEqual(
    comments.map((c) => c.text.trim()),
    ["real"],
  );
});

test("extractComments: an unterminated block comment runs to EOF without throwing", () => {
  const source = "/** never closed";
  const comments = extractComments(source);
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /never closed/);
});

// ---- commentLineCount -------------------------------------------------------------------------

test("commentLineCount sums line comments (1 each) and block comments (full span)", () => {
  const source = ["// one", "// two", "/**", " * a", " * b", " * c", " */"].join("\n");
  const comments = extractComments(source);
  // 2 line comments + a 5-line block (lines 3-7 inclusive) = 2 + 5 = 7.
  assert.equal(commentLineCount(comments), 7);
});

// ---- stripQuotedProse -------------------------------------------------------------------------

test("stripQuotedProse blanks a same-line quoted span but keeps its length/newlines", () => {
  const text = 'before ("I found nothing") after';
  const stripped = stripQuotedProse(text);
  assert.ok(!stripped.includes("I found"));
  assert.equal(stripped.length, text.length);
  assert.ok(stripped.startsWith("before ("));
  assert.ok(stripped.endsWith(") after"));
});

test("stripQuotedProse blanks a quote that wraps onto a second line", () => {
  // Mirrors the real false positive this rule was tuned against: llm-edges.ts's parenthetical gloss
  // ("I found only weak links, and you told\n *  me to ignore those") wraps mid-quote.
  const text = '("I found only weak links, and you told\n *  me to ignore those")';
  const stripped = stripQuotedProse(text);
  assert.ok(!stripped.includes("I found"));
  // The newline is preserved so line-number attribution downstream is unaffected.
  assert.equal(stripped.split("\n").length, 2);
});

// ---- findViolations: banner class --------------------------------------------------------------

test("findViolations flags a real dated banner (the exact shape #851 removed)", () => {
  const source = ["// THE-629, CORRECTED 2026-08-04: these were classified none"].join("\n");
  const violations = findViolations(extractComments(source));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "banner");
  assert.equal(violations[0].line, 1);
});

test("findViolations does NOT flag 'VERIFIED 2026-era' (real false positive from types.ts)", () => {
  const source = [
    "/** a transport-VERIFIED 2026-era HITL confirmation (HMAC+TTL already checked); the",
    " *  gate still binds it to this call. */",
  ].join("\n");
  const violations = findViolations(extractComments(source));
  assert.deepEqual(violations, []);
});

test("findViolations does not flag lowercase or title-case 'measured' prose", () => {
  const source = "// measured at 60.8s across 470 models; Measured on windows-latest, twice";
  const violations = findViolations(extractComments(source));
  assert.deepEqual(violations, []);
});

test("findViolations: a string literal containing 'CORRECTED 2026' never reaches the comment scan", () => {
  const source = 'const label = "CORRECTED 2026-01-01: still not a banner";';
  const violations = findViolations(extractComments(source));
  assert.deepEqual(violations, []);
});

for (const word of [
  "CORRECTED",
  "VERIFIED",
  "MEASURED",
  "DECIDED",
  "RE-CHECKED",
  "RETARGETED",
  "SUPERSEDED",
  "UNPARKED",
]) {
  test(`findViolations flags a bare-year banner for ${word}`, () => {
    const violations = findViolations(
      extractComments(`// ${word} 2026: still a banner without a full date`),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "banner");
  });
}

// ---- findViolations: first-person class --------------------------------------------------------

test("findViolations flags real first-person narrative", () => {
  const source = "// we measured this at 40ms and I assumed it would hold";
  const violations = findViolations(extractComments(source));
  assert.ok(violations.some((v) => v.rule === "first-person"));
});

test("findViolations does NOT flag quoted reported speech (real false positive from llm-edges.ts)", () => {
  const source = [
    '/**  a literal `[]` ("I looked and found nothing"), and a fully valid edge array',
    ' *  whose every edge falls below the configured confidenceFloor ("I found only weak links, and you told',
    ' *  me to ignore those"). Treating a POLICY filter as damage would freeze the layer. */',
  ].join("\n");
  const violations = findViolations(extractComments(source));
  assert.deepEqual(violations, []);
});

test("findViolations is case-insensitive for the first-person rule but still requires the verb", () => {
  const violations = findViolations(extractComments("// We Verified this holds on every platform"));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "first-person");
});

test("findViolations does not flag 'I' or 'we' without one of the narrative verbs", () => {
  const source = "// we should keep this invariant; I recommend not touching it without a test";
  const violations = findViolations(extractComments(source));
  assert.deepEqual(violations, []);
});

// ---- block-comment handling ---------------------------------------------------------------------

test("findViolations attributes a violation on line N of a multi-line block comment to the real source line", () => {
  const source = [
    "/**",
    " * first line, nothing wrong here",
    " * second line: we measured this at 40ms",
    " * third line, also fine",
    " */",
  ].join("\n");
  const violations = findViolations(extractComments(source));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 3);
});

test("findViolations: a banner-shaped line comment mid-file reports the correct absolute line", () => {
  const source = ["const a = 1;", "const b = 2;", "", "// DECIDED 2026-03-01: use approach B"].join(
    "\n",
  );
  const violations = findViolations(extractComments(source));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 4);
});

// ---- isGeneratedFile ------------------------------------------------------------------------

test("isGeneratedFile matches this repo's real header convention", () => {
  const header = "// GENERATED by scripts/gen-embedded-migrations.mjs — DO NOT EDIT.\n";
  assert.ok(isGeneratedFile(`${header}const x = 1;`));
});

test("isGeneratedFile is false for an ordinary file, even one that mentions 'generated' far down", () => {
  const source =
    Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n") +
    "\n// generated later, not a header";
  assert.ok(!isGeneratedFile(source));
});

// ---- ratchet: baseline file + threshold semantics -----------------------------------------------

test("loadBaseline reads the checked-in scripts/comment-style-baseline.json", () => {
  const baseline = loadBaseline();
  assert.equal(typeof baseline.threshold, "number");
  assert.equal(typeof baseline.maxFiles, "number");
  assert.ok(baseline.threshold > 0);
});

test("evaluateRatchet: AT baseline passes", () => {
  const result = evaluateRatchet(33, { threshold: 120, maxFiles: 33 });
  assert.equal(result.status, "at");
  assert.equal(result.failed, false);
});

test("evaluateRatchet: OVER baseline fails", () => {
  const result = evaluateRatchet(34, { threshold: 120, maxFiles: 33 });
  assert.equal(result.status, "over");
  assert.equal(result.failed, true);
});

test("evaluateRatchet: UNDER baseline passes (an available ratchet-down, not a failure)", () => {
  const result = evaluateRatchet(32, { threshold: 120, maxFiles: 33 });
  assert.equal(result.status, "under");
  assert.equal(result.failed, false);
});

test("the checked-in baseline's threshold boundary is inclusive (>=), matching main()'s comparison", () => {
  const { threshold } = loadBaseline();
  const atThreshold = ["/**", ...Array.from({ length: threshold - 2 }, () => " * x"), " */"].join(
    "\n",
  );
  const comments = extractComments(atThreshold);
  assert.equal(commentLineCount(comments), threshold);
});

// ---- scope glob -----------------------------------------------------------------------------

test("scopeFiles: the two-pattern union matches what a recursive filesystem walk finds (no src/*.ts dropped)", () => {
  const files = scopeFiles();
  assert.ok(files.length > 300, `expected > 300 files, got ${files.length}`);
  // A file directly under a package's src/ (no intervening directory) must be present — this is
  // exactly what the single-pattern `packages/*/src/**/*.ts` glob silently drops (see the docblock
  // in check-comment-style.mjs: it lost index.ts, cli.ts and 17 others on the real tree).
  assert.ok(
    files.some((f) => /^packages\/[^/]+\/src\/[^/]+\.ts$/.test(f)),
    "expected at least one file directly under a package's src/ with no subdirectory",
  );
});

// ---- real-tree smoke ---------------------------------------------------------------------------

test("smoke: running the gate against this repo's actual HEAD exits 0", () => {
  const result = execFileSync(process.execPath, ["scripts/check-comment-style.mjs"], {
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
  assert.match(result, /0 banned-pattern violation\(s\)/);
});
