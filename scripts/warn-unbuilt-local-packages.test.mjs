// Tests for scripts/warn-unbuilt-local-packages.mjs (#1231). The checkout layout is fabricated in a
// temp root, so each result depends only on the fixture, never on what this machine has built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findUnbuiltLocalPackages, formatUnbuiltWarning } from "./warn-unbuilt-local-packages.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMBEDDER_BUILD = "cd packages/embedder-local && bun install && bun run build";
const RERANKER_BUILD = "cd packages/reranker-local && bun install && bun run build";

function fakeCheckout(t) {
  const root = mkdtempSync(join(tmpdir(), "warn-local-packages-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "embedder-local"), { recursive: true });
  mkdirSync(join(root, "packages", "reranker-local"), { recursive: true });
  return root;
}

function markBuilt(root, dir) {
  mkdirSync(join(root, dir, "dist"), { recursive: true });
  writeFileSync(join(root, dir, "dist", "index.js"), "export {};\n");
}

const notInstalled = () => false;

test("warns for both unbuilt packages and names the exact build commands", (t) => {
  const root = fakeCheckout(t);
  const unbuilt = findUnbuiltLocalPackages({ root, resolvesFromServer: notInstalled });
  assert.equal(unbuilt.length, 2);
  const message = formatUnbuiltWarning(unbuilt);
  assert.match(message, /warning/i);
  assert.ok(message.includes(EMBEDDER_BUILD), message);
  assert.ok(message.includes(RERANKER_BUILD), message);
});

test("says the packages are needed for the default local providers", (t) => {
  const root = fakeCheckout(t);
  const message = formatUnbuiltWarning(
    findUnbuiltLocalPackages({ root, resolvesFromServer: notInstalled }),
  );
  assert.match(message, /embeddings\.provider "local"/);
  assert.match(message, /reranker/);
});

test("silent when both packages are built", (t) => {
  const root = fakeCheckout(t);
  markBuilt(root, "packages/embedder-local");
  markBuilt(root, "packages/reranker-local");
  assert.deepEqual(findUnbuiltLocalPackages({ root, resolvesFromServer: notInstalled }), []);
  assert.equal(formatUnbuiltWarning([]), "");
});

test("a package installed where the server resolves it counts as ready without a source build", (t) => {
  const root = fakeCheckout(t);
  markBuilt(root, "packages/reranker-local");
  const installed = (name) => name === "@the-40-thieves/obsidian-tc-embedder-local";
  assert.deepEqual(findUnbuiltLocalPackages({ root, resolvesFromServer: installed }), []);
});

test("exits 0 whether or not the packages are built, so the warning never fails the build", () => {
  const run = spawnSync(
    process.execPath,
    [join(REPO, "scripts", "warn-unbuilt-local-packages.mjs")],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
});

test("root build runs the warning step after the workspace build", () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const build = scripts.build;
  const workspaceAt = build.indexOf("bun run --filter='*' build");
  const warnAt = build.indexOf("scripts/warn-unbuilt-local-packages.mjs");
  assert.ok(workspaceAt === 0, `workspace build must still run first: ${build}`);
  assert.ok(warnAt > workspaceAt, `warning step missing from root build: ${build}`);
});
