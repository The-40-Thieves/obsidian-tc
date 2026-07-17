# Portability

How `obsidian-tc` builds, installs, and loads its compiled native addon across platforms,
and how that is verified in CI.

The server (`obsidian-tc`), plugin, and shared schemas are platform-independent TypeScript.
The only compiled artifact is the native performance addon
`@the-40-thieves/obsidian-tc-native` (vector ops, BM25, tokenize), and it always has a
pure-JS fallback — so the project runs on every platform even where no prebuild exists.

## Supported platforms / triples

The native addon ships prebuilt binaries for eight target triples. The publish matrix
(`.github/workflows/publish.yml`), the `napi.targets` list (`packages/native/package.json`),
and the `hostTriple()` loader (`packages/native/index.js`) are kept in 8-way sync.

| Rust target (napi)            | package triple    | publish runner   | builds in CI            | install-smoke         |
| ----------------------------- | ----------------- | ---------------- | ----------------------- | --------------------- |
| `x86_64-unknown-linux-gnu`    | `linux-x64-gnu`   | `ubuntu-latest`  | ✅ native               | ✅ `ubuntu-latest`    |
| `aarch64-unknown-linux-gnu`   | `linux-arm64-gnu` | `ubuntu-latest`  | ✅ cross (gcc-aarch64)  | ⚙️ build-verified only |
| `x86_64-unknown-linux-musl`   | `linux-x64-musl`  | `ubuntu-latest`  | ✅ cross (napi -x / zig)| ⚙️ build-verified only |
| `aarch64-unknown-linux-musl`  | `linux-arm64-musl`| `ubuntu-latest`  | ✅ cross (napi -x / zig)| ⚙️ build-verified only |
| `x86_64-apple-darwin`         | `darwin-x64`      | `macos-latest`   | ✅ clang cross          | ⚙️ build-verified only |
| `aarch64-apple-darwin`        | `darwin-arm64`    | `macos-14`       | ✅ native               | ✅ `macos-latest`     |
| `x86_64-pc-windows-msvc`      | `win32-x64-msvc`  | `windows-latest` | ✅ native               | ✅ `windows-latest`   |
| `aarch64-pc-windows-msvc`     | `win32-arm64-msvc`| `windows-latest` | ✅ cross (MSVC ARM64)   | ⚙️ build-verified only |

The install smoke test runs on the three GitHub-hosted host architectures — `ubuntu-latest`
(x64), `macos-latest` (arm64), and `windows-latest` (x64) — so those three host triples are
exercised end-to-end. The remaining five triples are **cross-compiled** in the publish
matrix and verified to build, but are not run in CI because GitHub does not offer hosted
arm64-Linux or arm64-Windows runners (and `macos-latest` is arm64, so `darwin-x64` is a
cross target there). They load through the same loader path, which is itself smoke-tested on
every runner.

## Prebuild + fallback flow

`@the-40-thieves/obsidian-tc-native` is an umbrella package. Its hand-written loader
(`packages/native/index.js`) resolves an implementation in this order:

1. **Local build** — `obsidian-tc-native.<triple>.node` next to `index.js` (a source checkout
   that ran `bun run build`, i.e. `napi build`).
2. **Published prebuild** — the platform package
   `@the-40-thieves/obsidian-tc-native-<triple>`, added to the umbrella's
   `optionalDependencies` by `napi pre-publish` at release time, so npm/bun installs only the
   matching one.
3. **Pure-JS fallback** — `packages/native/fallback.js`, numerically identical to the Rust
   (`src/lib.rs`).

`hostTriple()` maps `process.platform`/`process.arch` to a triple; an unknown platform, a
missing prebuild, or an install without the optional dep all fall through to the JS fallback
**instead of throwing** (G2.2 component 9). `module.exports.nativeLoaded` reports which path
won (`true` = compiled binary active, `false` = JS fallback).

## Runtime

The server bundle (`packages/server/dist/cli.js`) runs under **both Node (>= 24) and Bun** — the
DB adapter is auto-selected at runtime: `better-sqlite3` under Node, `bun:sqlite` under Bun
(`node:sqlite` is the last-resort fallback when `better-sqlite3` can't be resolved — e.g. the packed `.mcpb`, which ships no `node_modules` — and is also what the test suite runs on). `bun:sqlite` is imported lazily inside the Bun
adapter, so the node-targeted bundle carries no static `bun:` import and Node loads it cleanly
(the earlier "Node cannot resolve `bun:`" limitation was fixed in #58). Run the published CLI:

```sh
obsidian-tc <config.json>          # under Node (npm / npx) or Bun; the runtime is auto-detected
```

or use the per-platform standalone binaries from the GitHub release (built with
`bun build --compile`), or the multi-arch Docker image.

## Cross-compilation in `publish.yml`

- **linux-arm64** — built on the x64 `ubuntu-latest` runner. A gated step installs
  `gcc-aarch64-linux-gnu` and exports `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER`
  (plus `CC_/CXX_aarch64_unknown_linux_gnu`, so the `cc` crate cross-compiles cleanly once
  the commented-out `sqlite-vec`/`ndarray` deps land). Equivalent alternative:
  `napi build … --use-napi-cross` (zig-based toolchain, no apt).
- **win-arm64** — built on the x64 `windows-latest` runner; its VS 2022 image ships the MSVC
  ARM64 cross tools, so `napi build --target aarch64-pc-windows-msvc` works with only the
  Rust target added by `dtolnay/rust-toolchain`.
- **darwin** — Apple `clang` cross-compiles freely between `x86_64`/`aarch64`, so each macOS
  runner builds its non-host target with just the Rust target added.
- **linux-musl (x64 + arm64)** — cross-compiled on the x64 `ubuntu-latest` runner via
  `napi build -x` (cargo-zigbuild; `goto-bus-stop/setup-zig` 0.13.0), gated to the two musl
  rows. This is what lets Alpine/musl installs load the native addon: `hostTriple()` detects
  musl (`process.report.glibcVersionRuntime`, then `/usr/bin/ldd` text) and requests
  `linux-{x64,arm64}-musl`. Unknown/glibc hosts stay on `-gnu`.

## CI install smoke test

`.github/workflows/ci-install-smoke.yml` runs a `ubuntu-latest`/`macos-latest`/`windows-latest`
matrix. On each runner it installs deps, builds the host native addon + shared + server, then
asserts:

1. **Host prebuild loads** — `require('packages/native')` reports `nativeLoaded === true` and
   exposes `cosineSimilarity`/`cosineBatch`/`tokenize`/`bm25Score`.
2. **Missing prebuild degrades, not crashes** — with the `.node` moved aside, the loader
   returns the JS fallback (`nativeLoaded === false`) with all exports intact and no throw.
3. **CLI boots** — `scripts/write-smoke-config.mjs` writes a minimal config for a throwaway
   vault, and `bun packages/server/dist/cli.js <config>` reaches its `ready on stdio` line
   (stdin is closed so the stdio transport ends and the process exits cleanly).
