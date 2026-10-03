import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE_ROOT = join(ROOT, "packages", "x");
const FIXTURE_DIST = join(FIXTURE_ROOT, "dist");
const SHARED_DIST = join(ROOT, "packages", "shared", "dist");

const GATES = [
  ["check:boundaries", "scripts/check-boundaries.mjs", []],
  ["map:check", "scripts/gen-tree-map.mjs", ["--check"]],
];

function runGate(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("untracked build output does not change boundary or map gates", (t) => {
  if (existsSync(SHARED_DIST)) {
    return t.skip(
      "packages/shared/dist already exists; refusing to overwrite or delete real build output",
    );
  }
  if (existsSync(FIXTURE_ROOT)) {
    return t.skip("packages/x already exists; refusing to overwrite or delete a real package");
  }

  const clean = new Map(GATES.map(([name, script, args]) => [name, runGate(script, args)]));

  try {
    mkdirSync(FIXTURE_DIST, { recursive: true });
    writeFileSync(join(FIXTURE_DIST, "foo.js"), "export const built = true;\n");
    mkdirSync(SHARED_DIST, { recursive: true });
    writeFileSync(join(SHARED_DIST, "index.js"), "export const built = true;\n");
    writeFileSync(join(SHARED_DIST, "index.d.ts"), "export declare const built: true;\n");

    for (const [name, script, args] of GATES) {
      assert.deepEqual(runGate(script, args), clean.get(name), `${name} changed with dist present`);
    }
  } finally {
    rmSync(SHARED_DIST, { recursive: true, force: true });
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }
});
