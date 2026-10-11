// Embedding the libSQL native addon into a `bun build --compile` binary (opt-in: the experimental
// libsql adapter, packages/server/src/db/libsql.ts).
//
// The `libsql` npm package picks its native addon with a template-literal
// `require(`@libsql/${target}`)`, which a bundler cannot follow and a compiled binary has nothing to
// resolve against ("Cannot find native binding"). Measured on bun 1.4.2, a RUNTIME `Bun.plugin`
// `onResolve` is never consulted inside a compiled executable (neither for `require` nor `import`),
// so the rewrite has to happen at BUILD time: the Bun plugin below swaps that one expression for a
// `require()` of the target's `index.node` by absolute path, which bun embeds in the executable and
// extracts at first use. Same shape as scripts/lib/embedder-bundle.mjs.
//
// Per-target and opt-in on purpose: the addon is ~8 MB, so only a build that asks for it
// (`scripts/build-binary.ts --with-libsql`) carries it, and the default binary keeps `libsql`
// external and does not grow.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchVerifiedNpmPackage } from "./npm-tarball.mjs";

/** bun --compile target -> the `@libsql/*` package holding that platform's addon (glibc on linux). */
export const BUN_TARGET_LIBSQL_PACKAGE = {
  "bun-linux-x64": "@libsql/linux-x64-gnu",
  "bun-linux-arm64": "@libsql/linux-arm64-gnu",
  "bun-darwin-x64": "@libsql/darwin-x64",
  "bun-darwin-arm64": "@libsql/darwin-arm64",
  "bun-windows-x64": "@libsql/win32-x64-msvc",
};

const NATIVE_REQUIRE = `return require(\`@libsql/\${target}\`);`;
const LIBSQL_INDEX_FILE = /[\\/]libsql[\\/]index\.js$/;

/** libsql/index.js with its native-addon require pointed at `nodeFile`; throws if the source drifted. */
export function patchLibsqlSource(src, nodeFile) {
  const first = src.indexOf(NATIVE_REQUIRE);
  if (first === -1 || src.indexOf(NATIVE_REQUIRE, first + 1) !== -1) {
    throw new Error(
      `libsql-bundle: expected exactly one ${JSON.stringify(NATIVE_REQUIRE)} in libsql/index.js; ` +
        "the pinned libsql changed shape. Update scripts/lib/libsql-bundle.mjs.",
    );
  }
  return (
    src.slice(0, first) +
    `return require(${JSON.stringify(nodeFile)});` +
    src.slice(first + NATIVE_REQUIRE.length)
  );
}

/** The Bun.build plugin embedding `nodeFile` (an absolute path to a libsql `index.node`). */
export function libsqlBundlePlugin(nodeFile) {
  return {
    name: "obsidian-tc-libsql-bundle",
    setup(build) {
      build.onLoad({ filter: LIBSQL_INDEX_FILE }, ({ path }) => ({
        contents: patchLibsqlSource(readFileSync(path, "utf8"), nodeFile),
        loader: "js",
      }));
    },
  };
}

/**
 * Fetch (integrity-verified, any host) the addon for `target`. Resolves `{ nodeFile, cleanupDir }`:
 * the caller removes `cleanupDir` after the build. `libsqlVersion` is the installed `libsql`
 * version; every `@libsql/*` package is published at the same version.
 */
export async function fetchLibsqlNative(target, libsqlVersion, log = () => {}) {
  const pkg = BUN_TARGET_LIBSQL_PACKAGE[target];
  if (!pkg) {
    throw new Error(
      `libsql-bundle: no libsql native addon for ${target}. Supported: ${Object.keys(BUN_TARGET_LIBSQL_PACKAGE).join(", ")}`,
    );
  }
  const dir = await fetchVerifiedNpmPackage(pkg, libsqlVersion, log);
  return { nodeFile: join(dir, "index.node"), cleanupDir: join(dir, "..") };
}
