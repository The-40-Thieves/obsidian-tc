import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  BUN_TARGET_LIBSQL_PACKAGE,
  fetchLibsqlNative,
  patchLibsqlSource,
} from "./lib/libsql-bundle.mjs";

const NATIVE_REQUIRE = `return require(\`@libsql/\${target}\`);`;
const SERVER = join(import.meta.dirname, "..", "packages", "server");

test("patchLibsqlSource swaps the one native require for the embedded addon path", () => {
  const src = `function requireNative() {\n  ${NATIVE_REQUIRE}\n}\n`;
  const out = patchLibsqlSource(src, "/x/index.node");
  assert.match(out, /return require\("\/x\/index\.node"\);/);
  assert.doesNotMatch(out, /@libsql/);
});

test("patchLibsqlSource refuses a source that drifted (zero or two matches)", () => {
  assert.throws(() => patchLibsqlSource("nothing here", "/x"), /changed shape/);
  const twice = `${NATIVE_REQUIRE}\n${NATIVE_REQUIRE}`;
  assert.throws(() => patchLibsqlSource(twice, "/x"), /changed shape/);
});

test("the pinned libsql still contains exactly the expression the patch rewrites", (t) => {
  let indexJs;
  try {
    indexJs = createRequire(join(SERVER, "package.json")).resolve("libsql");
  } catch {
    return t.skip("libsql is not installed (optional dependency)");
  }
  assert.doesNotThrow(() => patchLibsqlSource(readFileSync(indexJs, "utf8"), "/x/index.node"));
});

test("every bun --compile target has a libsql addon package; an unknown one is refused", async () => {
  assert.deepEqual(Object.keys(BUN_TARGET_LIBSQL_PACKAGE).sort(), [
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-linux-arm64",
    "bun-linux-x64",
    "bun-windows-x64",
  ]);
  await assert.rejects(fetchLibsqlNative("bun-linux-riscv64", "0.0.0"), /no libsql native addon/);
});
