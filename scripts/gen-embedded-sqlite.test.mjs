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

/** A universal2 (fat) Mach-O holding the given slices, laid out as lipo writes it. */
function fat(slices) {
  const CPU = { x86_64: 0x01000007, arm64: 0x0100000c };
  const header = Buffer.alloc(8 + 20 * slices.length);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = header.length;
  const bodies = slices.map(([arch, text], i) => {
    const body = Buffer.from(text);
    header.writeUInt32BE(CPU[arch], 8 + 20 * i);
    header.writeUInt32BE(offset, 8 + 20 * i + 8);
    header.writeUInt32BE(body.length, 8 + 20 * i + 12);
    offset += body.length;
    return body;
  });
  return Buffer.concat([header, ...bodies]);
}

test("a universal2 dylib is refused when only one architecture has FTS5", () => {
  const r = embed(
    fat([
      ["arm64", "MACHO ENABLE_FTS5 THREADSAFE=1"],
      ["x86_64", "MACHO ENABLE_FTS4 THREADSAFE=1"],
    ]),
  );
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /x86_64 slice of --dylib .* was built without FTS5/);
  assert.equal(r.written, null);
});

test("a universal2 dylib with FTS5 in both architectures is embedded", () => {
  const r = embed(
    fat([
      ["arm64", "MACHO ENABLE_FTS5 THREADSAFE=1"],
      ["x86_64", "MACHO ENABLE_FTS5 THREADSAFE=1"],
    ]),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.written?.includes("EMBEDDED_SQLITE_BASE64"));
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
