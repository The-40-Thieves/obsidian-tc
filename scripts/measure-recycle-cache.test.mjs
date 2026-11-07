import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  resolve(import.meta.dirname, "../packages/server/scripts/measure-recycle.ts"),
  "utf8",
);
const bootstrap = source.match(/const cacheDir = [\s\S]*?(?=const init =)/)?.[0];
assert.ok(bootstrap, "the real benchmark cache bootstrap must be exercised");

// Run the actual bootstrap without loading the native embedder or downloading a model.
function cacheFor(env = {}) {
  return runInNewContext(`${bootstrap}\ncacheDir;`, {
    process: { env },
    mkdtempSync,
    tmpdir,
    join,
  });
}

test("measure cache defaults to a unique existing directory under the OS temp directory", () => {
  const first = cacheFor();
  const second = cacheFor();
  try {
    assert.notEqual(first, second, "separate runs must not share a predictable cache");
    assert.equal(dirname(first), tmpdir());
    assert.equal(dirname(second), tmpdir());
    assert.ok(statSync(first).isDirectory());
    assert.ok(statSync(second).isDirectory());
    if (process.platform !== "win32") {
      assert.equal(statSync(first).mode & 0o777, 0o700);
    }
  } finally {
    for (const path of new Set([first, second])) {
      if (dirname(path) === tmpdir() && path.startsWith(join(tmpdir(), "obtc-measure-cache-"))) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
});

test("measure cache preserves an explicit operator cache and its contents", () => {
  const configured = mkdtempSync(join(tmpdir(), "obtc-configured-cache-"));
  try {
    const model = join(configured, "model.bin");
    writeFileSync(model, "cached model");
    assert.equal(cacheFor({ MEASURE_CACHE: configured }), configured);
    assert.equal(readFileSync(model, "utf8"), "cached model");
  } finally {
    rmSync(configured, { recursive: true, force: true });
  }
});
