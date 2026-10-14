import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const WORKFLOW = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/publish.yml"),
  "utf8",
);
const match = WORKFLOW.match(
  /^ {2}publish-embedder-local:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/m,
);
assert.ok(match, "publish-embedder-local job not found");
const job = match[1];

test("publish-embedder-local runs the generated package assembler without a version override", () => {
  assert.match(
    job,
    /bun scripts\/pack-embedder-local\.ts --out dist\/embedder-local-npm(?:\n|$)/,
    "publish-embedder-local does not run scripts/pack-embedder-local.ts",
  );
  assert.doesNotMatch(job, /pack-embedder-local\.ts[^\n]*--version/);
});

test("the preflight classifies none, all, and partial base-plus-runtime publish states", () => {
  assert.match(job, /for d in dist\/embedder-local-npm\/(?:\*\/|\{[^\n]+\})/);
  assert.match(job, /published=0/);
  assert.match(job, /missing=0/);
  assert.match(job, /if \[ "\$published" -gt 0 \] && \[ "\$missing" -gt 0 \]/);
  assert.match(
    job,
    /::error::PARTIAL publish state — \$published of \$\(\(published \+ missing\)\) target versions exist on npm\./,
  );
  assert.match(job, /already_published=true/);
  assert.match(job, /already_published=false/);
});

test("all six runtime directories publish before base with token auth and provenance", () => {
  const runtimePublish = job.indexOf("dist/embedder-local-npm/$key");
  const basePublish = job.indexOf("dist/embedder-local-npm/base");
  assert.ok(runtimePublish >= 0, "runtime package publish loop missing");
  assert.ok(basePublish > runtimePublish, "base package must publish after runtime packages");
  assert.match(job, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(job, /npm publish --provenance --access public --tag "\$tag"/);
  for (const key of [
    "linux-x64",
    "linux-arm64",
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
  ]) {
    assert.match(job, new RegExp(key));
  }
});
