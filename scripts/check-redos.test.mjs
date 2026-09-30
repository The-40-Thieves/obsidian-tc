// Tests for the ReDoS/super-linear-regex recurrence guard (check-redos.mjs).
//
// node:test rather than vitest — same reason check-embedding-transport-vendor-neutral.test.mjs
// gives: scripts/ sits outside every workspace glob and no root vitest config reaches it.
// `node --test scripts/*.test.mjs`.
//
// RED CASE, verbatim: the exact MDLINK/WIKILINK regexes that shipped in vault/links.ts and
// vault/rewrite.ts before this fix. If this test ever fails on `checkPattern`, the gate has
// stopped detecting the incident it exists for.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the allowlist and fixtures hold literal source text that contains `${...}`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST,
  checkPattern,
  classifyResult,
  DYNAMIC_ALLOWLIST,
  extractRegexLiterals,
  REGEX_PRECEDING_KEYWORDS,
  scanSource,
} from "./check-redos.mjs";

const SCRIPT = fileURLToPath(new URL("./check-redos.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  // memory-defense.ts's `new RegExp(`[${body}]`, "gu")` shape — not a literal, so no literal to
  // extract; must not throw (it is reported as a dynamic finding, see scanSource tests below).
  const src = 'const body = "a-z"; const re = new RegExp(`[${body}]`, "gu");\n';
  const found = extractRegexLiterals("fixture.ts", src);
  assert.equal(found.length, 0);
});

// --- Tokenizer: a `/` after a keyword that takes an expression opens a regex ----------------------
//
// INCIDENT, verbatim: packages/server/src/vault/tags.ts had
//   return /^[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(t) && /[A-Za-z_-]/.test(t);
// and the scanner read the `/` after `return` as division (the last char of the keyword looks like an
// identifier), so that regex was never checked.

test("extractRegexLiterals reads the verbatim tags.ts `return /regex/` incident", () => {
  const src =
    "export function isValidTag(t: string): boolean {\n" +
    "  return /^[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(t) && /[A-Za-z_-]/.test(t);\n" +
    "}\n";
  const found = extractRegexLiterals("tags.ts", src);
  assert.deepEqual(
    found.map((f) => f.pattern),
    ["^[A-Za-z0-9_][A-Za-z0-9_/-]*$", "[A-Za-z_-]"],
  );
  assert.equal(found[0].line, 2);
});

const KEYWORD_SOURCES = {
  return: "function f(x) { return /a+/.test(x); }",
  typeof: "const t = typeof /a+/;",
  case: "switch (x) { case /a+/.source: break; }",
  do: "do /a+/.test(x); while (false);",
  else: "if (ok) go(); else /a+/.test(x);",
  in: 'const has = "source" in /a+/;',
  of: "for (const m of /a+/g.exec(s) ?? []) use(m);",
  new: "const o = new /a+/.constructor();",
  delete: "delete /a+/.lastIndex;",
  void: "void /a+/.test(x);",
  throw: "throw /a+/;",
  yield: "function* g() { yield /a+/; }",
  await: "async function f() { await /a+/; }",
  instanceof: "const y = x instanceof /a+/.constructor;",
};

test("KEYWORD_SOURCES covers every keyword the tokenizer treats as regex-preceding", () => {
  assert.deepEqual([...REGEX_PRECEDING_KEYWORDS].sort(), Object.keys(KEYWORD_SOURCES).sort());
});

for (const [keyword, src] of Object.entries(KEYWORD_SOURCES)) {
  test(`extractRegexLiterals reads /regex/ after \`${keyword}\` (not as division)`, () => {
    const found = extractRegexLiterals("fixture.ts", src);
    assert.equal(found.length, 1, `expected one literal in: ${src}`);
    assert.equal(found[0].pattern, "a+");
  });
}

test("extractRegexLiterals reads `return` followed by a newline and then a regex (ASI)", () => {
  const found = extractRegexLiterals(
    "fixture.ts",
    "function f(x) {\n  return\n  /a+/.test(x);\n}\n",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test("extractRegexLiterals still reads division as division", () => {
  const divisions = [
    "const r = a / b / c;",
    "const r = x.return / 2 / 3;", // member named like a keyword
    "const r = returned / 2 / 3;", // identifier that merely starts with a keyword
    "const r = f(x) / 2 / 3;",
    "const r = arr[0] / 2 / 3;",
    "const r = i++ / 2 / 3;",
    "const r = i-- / 2 / 3;",
    "const r = 10 / 2 / 5;",
  ];
  for (const src of divisions) {
    assert.equal(extractRegexLiterals("fixture.ts", src).length, 0, `division misread in: ${src}`);
  }
});

// --- Dynamic regexes are findings, never silently skipped -----------------------------------------

test("scanSource reports runtime-built new RegExp / RegExp() calls as dynamic findings", () => {
  const src = [
    'const a = new RegExp("a+", "g");',
    "const b = RegExp(pattern);",
    "const c = new RegExp(`^${esc}$`);",
  ].join("\n");
  const { literals, dynamic } = scanSource(src);
  assert.equal(literals.length, 0);
  assert.deepEqual(
    dynamic.map((d) => [d.kind, d.line]),
    [
      ["new-regexp", 1],
      ["new-regexp", 2],
      ["new-regexp", 3],
    ],
  );
  assert.equal(dynamic[0].text, 'new RegExp("a+", "g")');
  assert.equal(dynamic[2].text, "new RegExp(`^${esc}$`)");
});

test("scanSource does not flag mentions of RegExp that build nothing", () => {
  const src = [
    "const ok = x instanceof RegExp;",
    "function f(re: RegExp): RegExp { return re; }",
    'const s = "new RegExp(x)"; // new RegExp(y)',
    "const t: ReadonlyArray<RegExp> = [];",
  ].join("\n");
  assert.deepEqual(scanSource(src).dynamic, []);
});

test("scanSource reports a regex literal written inside a template `${...}` expression", () => {
  const src = "const m = `ok ${/(a+)+$/.test(x)} and ${y}`;\nconst z = 1;\n";
  const { literals, dynamic } = scanSource(src);
  assert.equal(literals.length, 0, "must not be a plain literal: it is inside a template");
  assert.deepEqual(
    dynamic.map((d) => [d.kind, d.line, d.text]),
    [["template-regex", 1, "/(a+)+$/"]],
  );
});

test("scanSource walks nested templates and resumes normal scanning after a template", () => {
  const src = "const m = `a ${`b ${/x+/.test(1)} c`} d`;\nconst r = /after+/;\n";
  const { literals, dynamic } = scanSource(src);
  assert.deepEqual(
    literals.map((l) => [l.pattern, l.line]),
    [["after+", 2]],
  );
  assert.deepEqual(
    dynamic.map((d) => d.text),
    ["/x+/"],
  );
});

test("scanSource keeps line numbers across multi-line templates", () => {
  const src = "const m = `l1\nl2 ${x}\nl3`;\nconst r = /q+/;\n";
  assert.equal(scanSource(src).literals[0].line, 4);
});

// --- Fail closed ------------------------------------------------------------------------------

test("classifyResult passes only `safe`", () => {
  assert.equal(classifyResult({ status: "safe" }).ok, true);
  const bad = [
    { status: "vulnerable", complexity: { summary: "polynomial" } },
    { status: "unknown", error: { kind: "timeout" } },
    { status: "unknown", error: { kind: "unsupported", message: "lookbehind" } },
    { status: "unknown", error: { kind: "invalid", message: "parsing failure" } },
    { status: "unknown" },
    {},
  ];
  for (const r of bad) assert.equal(classifyResult(r).ok, false, JSON.stringify(r));
  assert.match(classifyResult(bad[1]).detail, /timeout/);
});

test("checkPattern yields a non-safe verdict when the checker times out (real recheck)", async () => {
  const result = await checkPattern("^(?:[a-z]+\\s?)*[0-9]{1,5000}(x|xy|xyz)*$", "", 1);
  assert.equal(classifyResult(result).ok, false);
});

// --- The gate, end to end, against synthetic fixture trees -----------------------------------------

function fixtureDir(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `check-redos-${name}-`));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

function runGateCli(dir, extra = []) {
  const r = spawnSync("node", [SCRIPT, "--scan-dir", dir, ...extra], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function withFixture(name, files, fn) {
  const dir = fixtureDir(name, files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gate is GREEN on a fixture whose only regex is provably linear (existence floor)", () => {
  withFixture("clean", { "a.ts": "export const X = /^[a-z]+$/;\n" }, (dir) => {
    const r = runGateCli(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 regex literal\(s\)/);
  });
});

test("gate is RED when the checker times out on a pattern (fail closed, not skipped)", () => {
  withFixture(
    "timeout",
    { "a.ts": "export const X = /^(?:[a-z]+\\s?)*[0-9]{1,5000}(x|xy|xyz)*$/;\n" },
    (dir) => {
      const r = runGateCli(dir, ["--timeout-ms", "1"]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /timeout/);
      assert.match(r.out, /a\.ts:1/);
    },
  );
});

test("gate is RED on an unallowlisted new RegExp(...)", () => {
  withFixture("dyn", { "a.ts": 'export const X = new RegExp(userInput, "g");\n' }, (dir) => {
    const r = runGateCli(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /dynamic new-regexp/);
    assert.match(r.out, /a\.ts:1/);
  });
});

test("gate is RED on a regex literal hidden inside a template `${...}`", () => {
  withFixture("tpl", { "a.ts": "export const X = `v=${/^[a-z]+$/.test(s)}`;\n" }, (dir) => {
    const r = runGateCli(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /dynamic template-regex/);
  });
});

test("gate is RED on a vulnerable `return /regex/` (the tokenizer hole, end to end)", () => {
  withFixture(
    "ret",
    { "a.ts": "export function f(s: string) {\n  return /^(a+)+$/.test(s);\n}\n" },
    (dir) => {
      const r = runGateCli(dir);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /a\.ts:2/);
      assert.match(r.out, /vulnerable/);
    },
  );
});

test("gate is RED on an empty scan tree (no floor)", () => {
  withFixture("empty", { "readme.txt": "nothing\n" }, (dir) => {
    assert.equal(runGateCli(dir).status, 1);
  });
});

// --- Allowlist hygiene ------------------------------------------------------------------------

test("every allowlist entry names a real file and records a reason and a measurement", () => {
  for (const entry of [...ALLOWLIST, ...DYNAMIC_ALLOWLIST]) {
    assert.ok(existsSync(join(REPO_ROOT, entry.file)), `${entry.file} does not exist`);
    assert.ok(entry.reason?.trim().length > 10, `${entry.file}: missing reason`);
    assert.ok(entry.measured?.trim().length > 5, `${entry.file}: missing measurement`);
  }
});
