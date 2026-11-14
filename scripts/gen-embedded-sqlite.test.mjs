// Tests for scripts/gen-embedded-sqlite.mjs. Building the dylib needs a darwin host, so these cover
// what runs anywhere: the configure flags, the FTS5 check on the bytes that get embedded (through
// --dylib), and the release smoke step that reads the compiled binary's startup output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./gen-embedded-sqlite.mjs", import.meta.url));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Runs the script on a stand-in dylib, writing to a temp file instead of the tracked placeholder. */
function embed(dylibBytes) {
  const dir = mkdtempSync(join(tmpdir(), "gen-embedded-sqlite-test-"));
  try {
    const dylib = join(dir, "libsqlite3.dylib");
    const out = join(dir, "sqlite-embedded.ts");
    writeFileSync(dylib, dylibBytes);
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--target", "bun-darwin-arm64", "--dylib", dylib, "--out", out],
      { encoding: "utf8" },
    );
    return {
      code: r.status,
      stderr: r.stderr,
      written: existsSync(out) ? readFileSync(out, "utf8") : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("configure is asked for FTS5, which this SQLite leaves off by default", () => {
  const configure = /\.\/configure[^`]*`/.exec(read("./gen-embedded-sqlite.mjs"))?.[0] ?? "";
  assert.match(configure, /--enable-fts5\b/);
});

test("a dylib built without FTS5 is refused, and nothing is written", () => {
  const r = embed(Buffer.from("MACHO ENABLE_FTS4 ENABLE_RTREE THREADSAFE=1"));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /built without FTS5/);
  assert.equal(r.written, null);
});

test("a dylib that carries the FTS5 compile option is embedded", () => {
  const bytes = Buffer.from("MACHO ENABLE_FTS4 ENABLE_FTS5 THREADSAFE=1");
  const r = embed(bytes);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.written?.includes(`EMBEDDED_SQLITE_BASE64 = "${bytes.toString("base64")}"`));
});

test("the release smoke step fails a binary whose startup output reports notes_fts failed", () => {
  const publish = read("../.github/workflows/publish.yml");
  const start = publish.indexOf("- name: smoke-test the compiled binary");
  const step = publish.slice(start, publish.indexOf("- uses: actions/upload-artifact", start));
  assert.ok(start !== -1 && step.length > 0, "smoke step not found in publish.yml");
  assert.match(
    step,
    /if echo "\$out" \| grep -q "notes_fts failed"; then\n\s+echo "::error::[^\n]+\n\s+exit 1\n/,
  );
});
