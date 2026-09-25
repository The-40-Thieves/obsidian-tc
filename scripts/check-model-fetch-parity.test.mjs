// Tests for scripts/check-model-fetch-parity.mjs. Exercises the pure functions directly
// (extractSymbol, normalizeBody, compareModelFetchFiles) against fabricated source strings rather
// than the real embedder-local/reranker-local files — none of the covered behaviour touches the
// filesystem, and a fabricated fixture lets each test assert one specific failure mode in
// isolation. See check-facade-parity.test.mjs for the same pattern applied to a different gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareModelFetchFiles,
  DOCUMENTED_DELTAS,
  extractSymbol,
  normalizeBody,
  PARITY_SYMBOLS,
} from "./check-model-fetch-parity.mjs";

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
