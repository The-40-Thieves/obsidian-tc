// Tests for the ReDoS/super-linear-regex recurrence guard (check-redos.mjs).
//
// node:test rather than vitest — same reason check-embedding-transport-vendor-neutral.test.mjs
// gives: scripts/ sits outside every workspace glob and no root vitest config reaches it.
// `node --test scripts/*.test.mjs`.
//
// RED CASE, verbatim: the exact MDLINK/WIKILINK regexes that shipped in vault/links.ts and
// vault/rewrite.ts before this fix. If this test ever fails on `checkPattern`, the gate has
// stopped detecting the incident it exists for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPattern, extractRegexLiterals } from "./check-redos.mjs";

test("checkPattern flags the pre-fix MDLINK regex as vulnerable (RED case)", async () => {
  const result = await checkPattern("(!?)\\[([^\\]\\n]*)\\]\\(([^)\\n]+)\\)", "g");
  assert.equal(result.status, "vulnerable");
});

test("checkPattern flags the pre-fix WIKILINK regex as vulnerable (RED case)", async () => {
  const result = await checkPattern("(!?)\\[\\[([^\\]\\n]+?)\\]\\]", "g");
  assert.equal(result.status, "vulnerable");
});

test("checkPattern reports the already-linear INLINE_CODE regex as safe (no false positive)", async () => {
  const result = await checkPattern("`[^`]*`", "g");
  assert.equal(result.status, "safe");
});

test("checkPattern reports the already-linear tag regex as safe (no false positive)", async () => {
  const result = await checkPattern("(^|\\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)", "g");
  assert.equal(result.status, "safe");
});

test("extractRegexLiterals pulls a regex literal out of source, with its line", () => {
  const src = "const FENCE = /^\\s*(```|~~~)/;\nconst X = 1;\n";
  const found = extractRegexLiterals("fixture.ts", src);
  assert.equal(found.length, 1);
  assert.equal(found[0].pattern, "^\\s*(```|~~~)");
  assert.equal(found[0].line, 1);
});

test("extractRegexLiterals ignores a regex written inside a // comment", () => {
  // Mirrors redact.ts's documented-but-deliberately-unshipped unbounded PRIVATE KEY example: a
  // regex source sitting in prose must never reach recheck, or a commented-out example could fail
  // the build for code that isn't running.
  const src = "// example: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END/g\nconst y = 1;\n";
  const found = extractRegexLiterals("fixture.ts", src);
  assert.equal(found.length, 0);
});

test("extractRegexLiterals ignores a regex written inside a /* */ comment", () => {
  const src = "/* /(a+)+/ */\nconst y = 1;\n";
  const found = extractRegexLiterals("fixture.ts", src);
  assert.equal(found.length, 0);
});

test("extractRegexLiterals does not choke on new RegExp(...) with a computed pattern", () => {
  // memory-defense.ts's `new RegExp(`[${body}]`, "gu")` shape — not a literal, so nothing to
  // extract; must not throw.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal fixture source text under test.
  const src = 'const body = "a-z"; const re = new RegExp(`[${body}]`, "gu");\n';
  const found = extractRegexLiterals("fixture.ts", src);
  assert.equal(found.length, 0);
});
