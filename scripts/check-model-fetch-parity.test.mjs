// Tests for scripts/check-model-fetch-parity.mjs. Exercises the pure functions directly
// (extractSymbol, normalizeBody, compareModelFetchFiles) against fabricated source strings rather
// than the real embedder-local/reranker-local files — none of the covered behaviour touches the
// filesystem, and a fabricated fixture lets each test assert one specific failure mode in
// isolation. See check-facade-parity.test.mjs for the same pattern applied to a different gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  compareModelFetchFiles,
  DOCUMENTED_DELTAS,
  extractSymbol,
  FILE_PAIRS,
  normalizeBody,
  PARITY_SYMBOLS,
} from "./check-model-fetch-parity.mjs";

function compareOne(source, replacement, name) {
  return compareModelFetchFiles({
    embedderSource: source,
    rerankerSource: replacement,
    symbols: [name],
    deltas: new Map(),
  })[0].status;
}

test("parity catches body drift after object defaults and object return types", () => {
  for (const source of [
    'export function f(opts: object = {}) { return "safe"; }',
    'async function f(): Promise<{ rel: string }[]> { return [{ rel: "safe" }]; }',
    'function f({ value }: { value: string }) { return "safe"; }',
  ]) {
    assert.equal(compareOne(source, source.replace('"safe"', '"unsafe"'), "f"), "drift");
  }
});

test("parity preserves URL, regex, template and string contents", () => {
  for (const [source, replacement] of [
    ['const f = "https://safe.example";', 'const f = "https://unsafe.example";'],
    ['const f = "a  b";', 'const f = "a b";'],
    ['const f = "/* safe */";', 'const f = "/* unsafe */";'],
    ["const f = /[}]/;", "const f = /[}]+/;"],
    ["const f = `a  b`;", "const f = `a b`;"],
    ["const f = String.raw`\\n`;", "const f = String.raw`\\u000a`;"],
  ]) {
    assert.equal(compareOne(source, replacement, "f"), "drift");
  }
});

test("extraction respects braces in strings and comments and ignores nested declarations", () => {
  const source = 'function f() { const text = "}"; /* } */ return "safe"; }';
  assert.equal(extractSymbol(source, "f"), source);
  assert.equal(extractSymbol("function outer() { function f() {} }", "f"), undefined);
  assert.equal(compareOne(source, source.replace('"safe"', '"unsafe"'), "f"), "drift");
});

test("extraction uses source offsets after Unicode and isolates sibling constants", () => {
  const source = '// 🔒 café\nexport const first: string = "same", second = "two";';
  assert.equal(extractSymbol(source, "first"), 'export const first: string = "same";');
  assert.equal(compareOne(source, source.replace('"two"', '"three"'), "first"), "match");
  assert.equal(compareOne(source, source.replace('"two"', '"three"'), "second"), "drift");
});

test("ambiguous declarations and missing documented symbols cannot pass", () => {
  assert.throws(() => extractSymbol("function f() {} function f() {}", "f"), /duplicate/);
  const result = compareModelFetchFiles({
    embedderSource: "function sha256File() {}",
    rerankerSource: "",
    symbols: ["sha256File"],
  });
  assert.equal(result[0].status, "missing");
});

test("malformed source fails closed even for documented deltas", () => {
  assert.throws(
    () =>
      compareModelFetchFiles({
        embedderSource: "function sha256File() {",
        rerankerSource: "function sha256File() {}",
      }),
    /parse/i,
  );
});

test("normalization ignores formatting but preserves automatic semicolon semantics", () => {
  assert.equal(
    normalizeBody("function f(){return 1;}"),
    normalizeBody("function f() { return 1; }"),
  );
  assert.notEqual(
    normalizeBody("function f(){return 1;}"),
    normalizeBody("function f(){return\n1;}"),
  );
});

test("real mirror mutations behind object signatures fail the gate", () => {
  for (const [file, name, before, after] of [
    [
      "../packages/embedder-local/src/onnx-wasm-fallback.ts",
      "ensureOnnxBackend",
      "opts.platform ?? process.platform",
      'opts.platform ?? "linux"',
    ],
    [
      "../packages/embedder-local/src/model-fetch.ts",
      "listRelativeEntries",
      "const out:",
      'throw new Error("mutation"); const out:',
    ],
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes(before), `mutation anchor missing: ${name}`);
    assert.equal(compareOne(source, source.replace(before, after), name), "drift");
  }
});

test("extractSymbol: pulls a function declaration's full body", () => {
  const src = `
function hostnameOf(urlString) {
  return new URL(urlString).hostname;
}
function unrelated() {}
`;
  const body = extractSymbol(src, "hostnameOf");
  assert.match(body, /return new URL\(urlString\)\.hostname;/);
  assert.doesNotMatch(body, /unrelated/);
});

test("extractSymbol: pulls a const array/object declaration's full body", () => {
  const src = `const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ["huggingface.co", "hf.co"];\n`;
  const body = extractSymbol(src, "ALLOWED_DOWNLOAD_HOST_SUFFIXES");
  assert.equal(body, `const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ["huggingface.co", "hf.co"];`);
});

test("extractSymbol: returns undefined for a name not declared in the source", () => {
  assert.equal(extractSymbol("const other = 1;", "sha256File"), undefined);
});

test("normalizeBody: comment-only differences normalize equal", () => {
  const a = `function f() {\n  // does the thing\n  return 1;\n}`;
  const b = `function f() {\n  /* does the thing differently worded */\n  return 1;\n}`;
  assert.equal(normalizeBody(a), normalizeBody(b));
});

test("normalizeBody: a logic difference does NOT normalize equal", () => {
  const a = `function f() { return 1; }`;
  const b = `function f() { return 2; }`;
  assert.notEqual(normalizeBody(a), normalizeBody(b));
});

test("compareModelFetchFiles: reports 'match' when a symbol is identical modulo comments", () => {
  const embedderSource = `export function sleep(ms) {\n  // wait\n  return new Promise((r) => setTimeout(r, ms));\n}`;
  const rerankerSource = `export function sleep(ms) {\n  return new Promise((r) => setTimeout(r, ms));\n}`;
  const results = compareModelFetchFiles({ embedderSource, rerankerSource }).filter(
    (r) => r.name === "sleep",
  );
  assert.equal(results[0].status, "match");
});

test("compareModelFetchFiles: reports 'drift' when a security-relevant constant silently diverges", () => {
  const embedderSource = `const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ["huggingface.co", "hf.co"];`;
  // A WIDENED allowlist in only one file — exactly the class of silent drift this gate exists to catch.
  const rerankerSource = `const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ["huggingface.co", "hf.co", "evil.example"];`;
  const results = compareModelFetchFiles({ embedderSource, rerankerSource }).filter(
    (r) => r.name === "ALLOWED_DOWNLOAD_HOST_SUFFIXES",
  );
  assert.equal(results[0].status, "drift");
});

test("compareModelFetchFiles: reports 'missing' (not silently skipped) when a symbol is absent from one file", () => {
  const embedderSource = `function sleep(ms) { return ms; }`;
  const rerankerSource = ``;
  const results = compareModelFetchFiles({ embedderSource, rerankerSource }).filter(
    (r) => r.name === "sleep",
  );
  assert.equal(results[0].status, "missing");
  assert.deepEqual(results[0].missingIn, ["packages/reranker-local/src/model-fetch.ts"]);
});

test("compareModelFetchFiles: a name in DOCUMENTED_DELTAS is reported, not diffed, even when its bodies differ", () => {
  // Exercises the escape hatch itself using a symbol guaranteed present in both fixtures, without
  // mutating the module's real (currently empty) DOCUMENTED_DELTAS map.
  const embedderSource = `const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;`;
  const rerankerSource = `const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;`;
  DOCUMENTED_DELTAS.set("DEFAULT_LOCK_STALE_MS", "test-only delta");
  try {
    const results = compareModelFetchFiles({ embedderSource, rerankerSource }).filter(
      (r) => r.name === "DEFAULT_LOCK_STALE_MS",
    );
    assert.equal(results[0].status, "documented-delta");
    assert.equal(results[0].reason, "test-only delta");
  } finally {
    DOCUMENTED_DELTAS.delete("DEFAULT_LOCK_STALE_MS");
  }
});

test("FILE_PAIRS: covers the ort-session-options.ts mirror in addition to model-fetch.ts (THE-1122 gap closed by PR #996)", () => {
  const pair = FILE_PAIRS.find((p) => p.embedderFile.endsWith("ort-session-options.ts"));
  assert.ok(pair, "expected a FILE_PAIRS entry for ort-session-options.ts");
  assert.equal(pair.rerankerFile, "packages/reranker-local/src/ort-session-options.ts");
  assert.ok(pair.symbols.includes("ortSessionOptions"));
});

test("FILE_PAIRS: RED case — a diverged ortSessionOptions body between the two copies is reported as drift, not silently passed", () => {
  const embedderSource = `export function ortSessionOptions(threads, cpuCount) {\n  return { disable_prepacking: "1" };\n}`;
  // A regressed copy that silently drops the prepacking fix in ONE file only — exactly the class
  // of split-brain this generalized gate exists to catch (mirrors the existing
  // ALLOWED_DOWNLOAD_HOST_SUFFIXES drift case above, applied to the new pair).
  const rerankerSource = `export function ortSessionOptions(threads, cpuCount) {\n  return {};\n}`;
  const pair = FILE_PAIRS.find((p) => p.embedderFile.endsWith("ort-session-options.ts"));
  const results = compareModelFetchFiles({ embedderSource, rerankerSource, ...pair }).filter(
    (r) => r.name === "ortSessionOptions",
  );
  assert.equal(results[0].status, "drift");
});

test("compareModelFetchFiles: every real DOCUMENTED_DELTAS entry carries a non-empty reason", () => {
  assert.ok(DOCUMENTED_DELTAS.size > 0, "expected at least the sha256File streaming delta");
  for (const [name, reason] of DOCUMENTED_DELTAS) {
    assert.ok(
      PARITY_SYMBOLS.includes(name),
      `${name} is in DOCUMENTED_DELTAS but not PARITY_SYMBOLS`,
    );
    assert.ok(
      typeof reason === "string" && reason.length > 20,
      `${name}'s reason is too short to be real`,
    );
  }
});
