// build-binary.ts replaces packages/server/src/embeddings/embedded-embedder.ts with a generated
// module: one for targets that bundle the local embedder, one for targets that cannot. Each must
// export every name the source module exports, or every import of a missing name fails the bundle
// ("No matching export ... for import"), which broke every binary build once.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  generateEmbeddedEmbedderModule,
  prepareEmbeddedRuntimeFiles,
} from "./lib/embedded-embedder-module.mjs";

const source = readFileSync("packages/server/src/embeddings/embedded-embedder.ts", "utf8");
const build = readFileSync("scripts/build-binary.ts", "utf8");

const exportsOf = (text) => [...text.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort();

test("both generated embedded-embedder modules export exactly the source module's names", () => {
  const want = exportsOf(source);
  assert.ok(want.length >= 2, `expected at least 2 exports in the source, got ${want}`);
  const generated = generateEmbeddedEmbedderModule(
    [{ name: "runtime", gz: "/runtime.gz", sha256: "abc" }],
    "@the-40-thieves/obsidian-tc-embedder-local",
  );
  // The absent target's module remains the `contents:` string literal in build-binary.ts.
  const absent = build.match(/contents:\s*"([^"]*)"/);
  assert.ok(absent, "no absent-embedder `contents:` string in build-binary.ts");
  assert.deepEqual(exportsOf(generated), want, "bundling-target module exports");
  assert.deepEqual(
    exportsOf(absent[1].replaceAll("\\n", "\n")),
    want,
    "absent-target module exports",
  );
});

test("binary builds select all runtime assets through the target map, including darwin-x64 WASM", () => {
  assert.match(build, /ortRuntimeFiles\(ortNodeDir, ortWebDir, ortPlatform\)/);
});

test("the darwin-x64 generated module embeds both WASM files for verified extraction", () => {
  const work = mkdtempSync(join(tmpdir(), "obtc-generated-embedder-"));
  try {
    const runtimeFiles = [
      { name: "ort-wasm-simd-threaded.mjs", path: join(work, "source.mjs") },
      { name: "ort-wasm-simd-threaded.wasm", path: join(work, "source.wasm") },
    ];
    writeFileSync(runtimeFiles[0].path, "export default async () => ({})");
    writeFileSync(runtimeFiles[1].path, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));

    const files = prepareEmbeddedRuntimeFiles(runtimeFiles, work);
    assert.deepEqual(
      files.map((file) => file.name),
      ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"],
    );
    for (let i = 0; i < files.length; i++) {
      assert.deepEqual(gunzipSync(readFileSync(files[i].gz)), readFileSync(runtimeFiles[i].path));
      assert.match(files[i].sha256, /^[0-9a-f]{64}$/);
    }

    const generated = generateEmbeddedEmbedderModule(
      files,
      "@the-40-thieves/obsidian-tc-embedder-local",
    );
    assert.deepEqual(exportsOf(generated), ["embeddedEmbedder", "localEmbedderAbsentFromBinary"]);
    for (const file of files) {
      assert.match(generated, new RegExp(JSON.stringify(file.name)));
      assert.match(generated, new RegExp(file.sha256));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
