// build-binary.ts replaces packages/server/src/embeddings/embedded-embedder.ts with a generated
// module: one for targets that bundle the local embedder, one for targets that cannot. Each must
// export every name the source module exports, or every import of a missing name fails the bundle
// ("No matching export ... for import"), which broke every binary build once.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("packages/server/src/embeddings/embedded-embedder.ts", "utf8");
const build = readFileSync("scripts/build-binary.ts", "utf8");

const exportsOf = (text) => [...text.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort();

test("both generated embedded-embedder modules export exactly the source module's names", () => {
  const want = exportsOf(source);
  assert.ok(want.length >= 2, `expected at least 2 exports in the source, got ${want}`);
  // The bundling target's module is the template literal assigned to `generated`; the absent
  // target's is the `contents:` string literal.
  const generated = build.match(/const generated = `([\s\S]*?)`;/);
  const absent = build.match(/contents:\s*"([^"]*)"/);
  assert.ok(generated, "no `generated` module template in build-binary.ts");
  assert.ok(absent, "no absent-embedder `contents:` string in build-binary.ts");
  assert.deepEqual(exportsOf(generated[1]), want, "bundling-target module exports");
  assert.deepEqual(
    exportsOf(absent[1].replaceAll("\\n", "\n")),
    want,
    "absent-target module exports",
  );
});
