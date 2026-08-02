#!/usr/bin/env node
// THE-663: bake sqlite-vec's vec0 extension binary into a generated TypeScript module, per
// bun --compile target, so the standalone binaries stop losing dense retrieval.
//
// packages/server/src/search/vec.ts resolves sqlite-vec via `createRequire(import.meta.url)` —
// that works from source and from the npm dist build, but `bun build --compile` freezes
// import.meta.url to the BUILD MACHINE's path, so every published standalone binary silently fell
// back to the brute-force cosine scan the moment it ran anywhere but the exact CI runner that
// built it (which never happens for a real user).
//
// Why codegen a base64 string rather than Bun's own `import ... with { type: "file" }` asset
// embedding: that import-attribute syntax is rejected outright by vitest's rollup-based parser
// (parseAstAsync throws), which would break the whole suite the moment the generated module — or
// anything that imports it — is reached from a test. A plain string constant is ordinary
// TypeScript, so it parses identically under tsc, vitest, `bun run`, and --compile — the same
// reason scripts/gen-embedded-migrations.mjs inlines migration SQL as a JS string instead of a
// `with { type: "text" }` import.
//
// Unlike migrations-embedded.ts, this is NOT a single canonical file checked in as source of
// truth: sqlite-vec ships a DIFFERENT vec0 binary per platform (no musl, no windows-arm64), so
// there are 5 valid outputs, one per bun --compile target — there is nothing to diff against.
// publish.yml's build-binaries job regenerates this file fresh, once per target, immediately
// before compiling, and never commits the result. The version checked into git is the empty
// placeholder (see the generated file's own header) used by every other path: `bun run`, the npm
// dist build, and every test suite never reach the embedded fallback at all, since loadVec() tries
// the npm require() first and only falls back on failure.
//
// Run `bun run vec:embed -- --target <bun-target>` (bun-linux-x64, bun-linux-arm64, bun-darwin-x64,
// bun-darwin-arm64, or bun-windows-x64). Omit --target to default to the host's own platform,
// useful for a local end-to-end check.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "packages/server");
const OUT = join(SERVER, "src/search/vec-embedded.ts");

// Mirrors sqlite-vec's own platformPackageName()/extensionSuffix() (index.cjs) — the 5 packages it
// actually publishes. Kept as an explicit table (not derived) so an unsupported --target fails
// loudly here rather than resolving to nothing and shipping a vec-less binary silently.
const TARGETS = {
  "bun-linux-x64": { pkg: "sqlite-vec-linux-x64", ext: "so" },
  "bun-linux-arm64": { pkg: "sqlite-vec-linux-arm64", ext: "so" },
  "bun-darwin-x64": { pkg: "sqlite-vec-darwin-x64", ext: "dylib" },
  "bun-darwin-arm64": { pkg: "sqlite-vec-darwin-arm64", ext: "dylib" },
  "bun-windows-x64": { pkg: "sqlite-vec-windows-x64", ext: "dll" },
};

function defaultTarget() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch; // "x64" | "arm64"
  const guess = `bun-${os}-${arch}`;
  return TARGETS[guess] ? guess : undefined;
}

function parseArgs(argv) {
  const i = argv.indexOf("--target");
  if (i === -1) return defaultTarget();
  const target = argv[i + 1];
  if (!target) {
    console.error("gen-embedded-vec: --target requires a value");
    process.exit(1);
  }
  return target;
}

const target = parseArgs(process.argv.slice(2));
if (!target || !TARGETS[target]) {
  console.error(
    `gen-embedded-vec: unknown or unresolved --target "${target ?? ""}". Supported: ${Object.keys(TARGETS).join(", ")}`,
  );
  process.exit(1);
}
const { pkg, ext } = TARGETS[target];

// The main "sqlite-vec" package is a plain (non-optional, platform-agnostic) dependency of
// packages/server, so it is always installed by `bun install` regardless of host — its version is
// what pins which platform-package version to fetch below.
const sqliteVecPkgJson = join(SERVER, "node_modules/sqlite-vec/package.json");
if (!existsSync(sqliteVecPkgJson)) {
  console.error(
    `gen-embedded-vec: ${sqliteVecPkgJson} not found — run \`bun install\` in packages/server first`,
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(sqliteVecPkgJson, "utf8")).version;

// Fetch the TARGET platform's package regardless of the HOST platform. `bun install`/`npm install`
// both skip installing a platform package whose os/cpu doesn't match the current host (that's how
// sqlite-vec's own optionalDependencies stay small) — which is exactly why 2 of the 5 --compile
// targets cross-compile from the wrong host and would otherwise embed the wrong binary. `npm pack`
// has no such gating: it downloads the requested package@version's tarball unconditionally, which
// is why this shells out to it instead of relying on node_modules.
const work = mkdtempSync(join(tmpdir(), "otc-vec-embed-"));
let bytes;
try {
  const spec = `${pkg}@${version}`;
  console.log(`gen-embedded-vec: fetching ${spec} for target ${target}...`);
  let tgzName;
  try {
    // npm.cmd on Windows, npm everywhere else. execFileSync does NOT go through a shell, so on
    // Windows it looks for an executable literally named "npm" — there is none, only npm.cmd — and
    // fails with `spawnSync npm ENOENT`. That took down build-binaries (windows-latest) on the
    // v1.14.1 tag, the first run in which that job ever reached a verdict: on v1.14.0 it was
    // CANCELLED by the darwin failure, and a cancelled job is not a pass.
    //
    // Resolved by name rather than with `shell: true`, which on Windows re-joins argv into one
    // command string and reintroduces quoting/injection concerns for a value (`spec`) built from
    // package metadata.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    tgzName = execFileSync(npm, ["pack", spec, "--silent"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
  } catch (err) {
    console.error(
      `gen-embedded-vec: \`npm pack ${spec}\` failed — is ${pkg} published at ${version}?`,
    );
    console.error(err.message ?? err);
    process.exit(1);
  }
  const tgzPath = join(work, tgzName.split("\n").pop());
  execFileSync("tar", ["-xzf", tgzPath, "-C", work]);
  const binPath = join(work, "package", `vec0.${ext}`);
  if (!existsSync(binPath)) {
    console.error(`gen-embedded-vec: expected ${binPath} inside ${spec} but it was not there`);
    process.exit(1);
  }
  bytes = readFileSync(binPath);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (bytes.length === 0) {
  console.error("gen-embedded-vec: fetched vec0 binary is empty — refusing to embed nothing");
  process.exit(1);
}

const banner = `// GENERATED by scripts/gen-embedded-vec.mjs — DO NOT EDIT BY HAND.
//
// THE-663: the sibling vec.ts resolves sqlite-vec via node_modules, which breaks under
// \`bun build --compile\` (import.meta.url freezes to the build machine's path — see vec.ts's
// loadVec() for the fallback that reads EMBEDDED_VEC_BASE64 below). Full rationale in this
// script's header.
//
// This is a PER-TARGET build artifact, not source: publish.yml's build-binaries job regenerates
// this file once per bun --compile target (there are 5, one per platform sqlite-vec publishes),
// immediately before compiling, and never commits the result. The value checked into git is the
// empty placeholder below — every other path (\`bun run\`, the npm dist build, every test suite)
// never touches it, because loadVec() tries the npm require() first and only falls back here on
// failure, which outside a --compile binary never happens.
//
// Regenerate with \`bun run vec:embed -- --target <bun-target>\`.

/** Base64-encoded sqlite-vec \`vec0\` shared library for the target this binary was compiled for.
 *  Empty in source control; only ever non-empty inside a compiled release binary. */
export const EMBEDDED_VEC_BASE64 = ${JSON.stringify(bytes.toString("base64"))};
`;

writeFileSync(OUT, banner);
console.log(
  `gen-embedded-vec: wrote ${OUT} (${pkg}@${version}, ${bytes.length} bytes, target ${target})`,
);
