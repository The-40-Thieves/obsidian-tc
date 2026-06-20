# obsidian-tc — Technical Audit

Scope: full repository, read end to end with build, type check, lint, and tests
executed on the host. Findings are grounded in source and real command output,
not filenames.

- Repo: `obsidian-tc-monorepo` v1.0.1, branch `main`, HEAD `9b32b1c`.
- Host: Windows 11, Bun 1.3.13, Node 24.14.1, Rust/Cargo 1.96.0.
- Audited: 2026-06-19.
- Verification performed: clean `bun install --frozen-lockfile`; per-package
  build; `tsc` type check on all four packages; `biome check`; `cargo test`;
  `vitest run`; controlled native-build reproduction; direct enumeration of the
  tool registry, suppressions, error taxonomy, ACL/auth/HITL path, CI workflows,
  and docs.

Severity scale: critical (data loss / RCE / broken release), high (security or
release-correctness defect under a realistic config), med (correctness,
observability, or doc defect), low (hygiene / noise).

---

## Executive summary — top 5 risks

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| F1 | high | The documented build command rewrites two committed source files. `napi build` regenerates `index.js` and `index.d.ts`, clobbering the hand-written umbrella loader (and the pure-JS fallback contract it documents), then `biome check` fails on the generated file. `bun run build && bun run lint` from a clean tree is broken locally. | `packages/native/package.json:22`, `package.json:18,20`, `packages/native/index.js` |
| F2 | high | No safety interlock between `auth.mode: "none"` (the default) and a non-loopback HTTP bind. `none` returns caller `http-local` with scope `["*"]` and forces `authenticated: true`. Enabling HTTP on a routable host without setting `jwt` exposes unauthenticated read/write/create. | `packages/server/src/transports/http.ts:36-38,85`, `packages/shared/src/config.schema.ts:66,207` |
| F3 | med-high | The publish job is non-atomic: up to 7 sequential `npm publish` calls (4 platform sub-packages + native umbrella + shared + server) with no rollback. A mid-sequence failure leaves a partially published, version-skewed release, and the immutable tag cannot be re-run cleanly. | `.github/workflows/publish.yml:94-107` |
| F4 | med | Path-ACL denials are misclassified in metrics and events. Handler-level `enforcePathAcl` throws `acl_denied`, but dispatch maps only `forbidden` (plus unauthorized/elicit/throttled) to the `denied` status, and the `acl_denied` metric / `tc.acl.denied` event fire only for `forbidden`. Path-ACL denials are recorded as generic errors and never counted. | `packages/server/src/mcp/registry.ts:46-56,163-176,354`, `packages/server/src/vault/acl-path.ts:19` |
| F5 | med | The docs Tool Reference cites example tool names that do not exist in the registry (`set_frontmatter`, `edit_canvas`, `daily_note`, `run_dql`, `run_command`, `memory_write`, `capture`, `recall`, `bulk_read/write/delete`, `build_uri`, `get_health`). `bulk_read/write/delete` are documented but the real bulk surface is create / move / set_property. | `docs/src/content/docs/tools/index.md:13-22` |

Overall the codebase is disciplined: zero `TODO/FIXME/HACK/XXX` in source, three
suppressions total (all justified), a typed error taxonomy, a single path-safety
chokepoint, HS256-pinned JWT, single-use HITL tokens, and a fail-soft
observability layer. The risks above are concentrated in build tooling, one
default-config foot-gun, release atomicity, and documentation accuracy, not in
the core request pipeline.

---

## Phase 1 — Map

### Workspace layout

Bun workspaces (`package.json:16`), no Turbo/Nx. Five package directories; `docs`
is a separate Astro site outside the workspace array.

| Package | Name (npm) | Lang | Purpose | Public entry |
|---------|-----------|------|---------|--------------|
| `packages/server` | `obsidian-tc` | TS (Bun) | MCP protocol layer, auth, dispatch, 103 tools, plugin bridges, observability | `dist/index.js`; bin `dist/cli.js` |
| `packages/shared` | `@the-40-thieves/obsidian-tc-shared` | TS | Zod config schema, error taxonomy, scopes, result/morgiana schemas | `dist/index.js` + `.d.ts` |
| `packages/native` | `@the-40-thieves/obsidian-tc-native` | Rust (napi-rs) | `cosine_similarity`, `tokenize`, `bm25_score`; pure-JS fallback | `index.js` / `index.d.ts` |
| `packages/plugin` | `@the-40-thieves/obsidian-tc-plugin` (private) | TS | Companion Obsidian plugin (command dispatch + bridges) | `dist/main.js` (esbuild) |
| `docs` | (private) | Astro Starlight | Documentation site | n/a |

Internal dependency edges (from manifests):

```
server  ──depends──▶ shared   (workspace:*)
server  ──depends──▶ native   (workspace:*)
shared  ──(no internal deps)
native  ──(no internal deps; Rust crate has no internal deps)
plugin  ──(no internal deps; obsidian peer only)
```

The dispatch pipeline (`packages/server/src/mcp/registry.ts:226`) is the spine:
`validate -> auth -> scope -> ACL/read-only -> HITL -> rate-limit -> execute ->
byte-governor -> audit`, wrapped in one optional OTEL span. The MCP assembly
(`mcp/server.ts`) is transport-agnostic and bound by both stdio
(`transports/stdio.ts`) and streamable HTTP (`transports/http.ts`).

### Build orchestration and the install-to-artifact path

Root scripts (`package.json:17-22`) fan out with `bun run --filter='*'`. There is
no task graph tool; ordering relies on per-job working-directory steps in CI.

Local path from install to a publishable server artifact:

```
bun install --frozen-lockfile
  -> (packages/shared)  bun run build   # tsc -> dist/*.js + *.d.ts
  -> (packages/native)  bun run build   # napi build --platform --release -> *.node  (see F1)
  -> (packages/server)  bun run build   # bun build src/index.ts src/cli.ts -> dist/ + copy-assets.mjs
```

Publish path (`.github/workflows/publish.yml`, on a `v*` tag): build native on a
4-OS matrix, upload `*.node` artifacts; then in one `publish-npm` job download
artifacts, `napi create-npm-dir` + `napi artifacts` + `napi prepublish` (publishes
the 4 platform sub-packages and writes the umbrella `optionalDependencies`), build
shared + server, run `scripts/pin-workspace-deps.mjs` to rewrite `workspace:*` to
concrete versions, then `npm publish --provenance` for native, shared, server.
Parallel jobs build standalone Bun binaries, the plugin zip, and the multi-arch
GHCR image; `draft-release` aggregates artifacts with SHA-256 sums.

Published npm set is 7 packages: `obsidian-tc`, `@the-40-thieves/obsidian-tc-shared`,
`@the-40-thieves/obsidian-tc-native`, and 4 generated platform packages
(`...-native-linux-x64-gnu`, `-darwin-x64`, `-darwin-arm64`, `-win32-x64-msvc`).
The plugin is private. The prompt's "six npm packages" does not match; the repo's
own docs and CHANGELOG are consistent at "103 tools, 28 domains, 4 native prebuilds".

### TS to Rust boundary

The entire FFI surface is three functions in one crate (`packages/native/src/lib.rs`),
all exported through napi-rs:

| napi binding | Rust signature (`lib.rs`) | TS type (`index.d.ts`) | Consumer |
|---|---|---|---|
| `cosineSimilarity` | `cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64` (`:19`) | `:5` | `packages/server/src/search/native.ts` (semantic brute-force recall) |
| `tokenize` | `tokenize(text: String) -> Vec<String>` (`:43`) | `:8` | `search/native.ts` (BM25 lexical path) |
| `bm25Score` | `bm25_score(tf, doc_len, avg_doc_len, doc_freq, doc_count) -> f64` (`:57`) | `:11` | `search/native.ts` |

The crate is `cdylib` only (`Cargo.toml:9-10`), napi8 features, LTO release
profile. `build.rs` adds macOS `-undefined dynamic_lookup` via `napi_build::setup()`.
The umbrella `index.js` resolves a host `.node`, then the published platform
package, then falls back to `fallback.js` (numerically identical pure JS). The
loader's expected filename `obsidian-tc-native.<triple>.node` was verified to match
the produced artifact (`obsidian-tc-native.win32-x64-msvc.node`). The crate name and
`napi.name` are both unscoped (`obsidian-tc-native`), which is required: a scoped
`napi.name` would write the `.node` into a subdir and break the platform-package
layout.

---

## Phase 2 — Build and verify (real output)

| Step | Command | Result |
|------|---------|--------|
| install | `bun install --frozen-lockfile` | exit 0 |
| build shared | `tsc` | exit 0 |
| build native | `napi build --platform --release` | exit 0, `Finished release in 0.51s`; **mutates committed `index.js` 76->317 lines, `index.d.ts` 20->29 lines, emits untracked `Cargo.lock`** (F1) |
| build server | `bun build ... && copy-assets.mjs` | exit 0 |
| build plugin | `esbuild ... production` | exit 0 |
| typecheck | `tsc --noEmit` x4 (shared, server, native, plugin) | all exit 0 |
| lint | `biome check .` | exit 1, 6 errors — **all in the napi-generated `index.js`/`index.d.ts` after F1; on a clean committed tree biome passes** (see note) |
| cargo test | `cargo test` | 9 passed, 0 failed (benign `Load Node-API [...] GetProcAddress failed` warnings, see F11) |
| vitest | `vitest run` | **85 files, 537 tests, 0 failed**, ~6s; `ExperimentalWarning: SQLite is experimental` per worker (F12) |
| coverage | v8, gated | thresholds lines/statements/functions 80, branches 75 (`vitest.config.ts:36`); in-repo note claims ~95% line / ~77% branch |

Note on lint: the 6 biome errors (`useNodejsImportProtocol`, `noUnusedTemplateLiteral`,
formatter) are an artifact of F1. They appear because the audit ran the native build
before lint, which replaced the hand-written loader with the napi-generated one. CI
does not hit this: `ci-server` lints with `bun install --ignore-scripts` (native is
never built) and `ci-native` builds native but does not lint. The committed tree
lints clean. The defect is that the documented local build sequence does not.

Cross-compilation / host assumptions: native release builds are per-host (4-OS
matrix in CI); `linux-arm64` is explicitly deferred to v1.1. `cargo test` loads the
`cdylib` without a Node host, hence the napi symbol-load warnings (harmless).
`node:sqlite` requires Node >= 22 (CI injects `--experimental-sqlite` and pins Node
22), while `packages/native/package.json:32` declares `node >= 20`; the server in
practice needs 22 (F12).

Zero-test packages: `shared` runs `vitest run --passWithNoTests` and ships no test
files (`packages/shared/package.json:13`); `plugin` has no test script at all. Schema
and plugin behavior are covered only indirectly via the server suite (F13).

---

## Phase 3 — Correctness and risk

### F1 (high) — native build clobbers committed source and breaks local lint

`packages/native/package.json:22` defines `build` as `napi build --platform
--release`. napi-rs regenerates `index.js` and `index.d.ts` by default. The repo
ships a hand-written `index.js` (the umbrella loader that provides the pure-JS
fallback, documented in its own header) and a hand-written `index.d.ts`. Running
the documented build overwrites both. Reproduced deterministically:

```
before: index.js 76 lines, index.d.ts 20 lines, tree clean
napi build --platform --release  (Finished in 0.05s, cached)
after:  index.js 317 lines, index.d.ts 29 lines
        git: ' M index.d.ts', ' M index.js', '?? Cargo.lock'
        grep win32-arm64|nativeBinding|loadError -> 60 hits (generated loader)
        biome check index.js index.d.ts -> errors
```

The generated loader throws when no `.node` resolves, defeating the fallback
contract the hand-written file exists to guarantee. The publish job survives only
because it never runs `napi build` in the publishing checkout (it downloads
prebuilt artifacts), so the committed `index.js` is what ships. The audited files
were restored with `git checkout`.

Fix: stop napi from generating JS/d.ts. With `@napi-rs/cli` v2, set the build to
`napi build --platform --release --js false --dts false` (or the equivalent
`--no-js` plus a `.d.ts` guard), or move the hand-written loader to a distinct
filename and point `main`/`exports` at it. Add a CI guard: run `napi build` then
`git diff --exit-code packages/native/index.js packages/native/index.d.ts` so a
future regression fails fast. Decide on `Cargo.lock`: commit it (recommended for a
binary-producing crate) or add it to `.gitignore`.

### F2 (high) — `auth.mode: "none"` has no non-loopback interlock

`transports/http.ts:36-38`: when `auth.mode === "none"`, every request resolves to
`{ caller: "http-local", scopes: new Set(["*"]) }`, and the context is built with
`authenticated: true` unconditionally (`http.ts:85`). The scope wildcard `*`
satisfies every required scope (`scopes.ts:24`), and the dispatch unauthorized
gate (`registry.ts:269`) can never trigger over HTTP. Defaults
(`config.schema.ts`): `auth.mode` `none` (`:66`, `:207`), `transports.http.enabled`
false (`:102`), `host` `127.0.0.1` (`:103`). So HTTP is off by default and
loopback by default, but nothing prevents an operator from enabling HTTP, setting
`host: "0.0.0.0"`, and leaving `auth` at the default, which yields an
unauthenticated, fully scoped MCP endpoint. Destructive (`delete_note`), bulk, and
execute tools remain HITL-gated, and folder ACLs still apply, so this is not full
RCE, but unauthenticated note read / create / append is exposed.

Fix: at config load (`config/load.ts`) or server start, reject or hard-warn when
`transports.http.enabled && transports.http.host` is not a loopback address while
`auth.mode === "none"`. Prefer failing closed (refuse to bind) with an explicit
opt-out flag for trusted networks.

### F6 (med) — error taxonomy has duplicate codes for one concept

`packages/shared/src/errors.ts` defines parallel codes: `read_only` (`:15`) and
`read_only_mode` (`:23`); `internal` (`:17`) and `internal_error` (`:27`);
`forbidden` (`:4`) and `acl_denied` (`:22`); `validation_error` (`:5`) and
`invalid_input` (`:26`); `not_found` / `note_not_found` / `vault_not_found`. Two
codes per concept invites the inconsistent mapping seen in F4 and makes client
error handling ambiguous. The comments say codes are locked by tests and must not
be renamed, so this is now a compatibility burden.

Fix: pick one canonical code per concept, alias the rest in client-facing docs,
and (post-1.x, when the additive freeze allows) collapse the duplicates. Near
term, fix the mapping in F4 so the duplication is at least harmless.

### FFI safety (no finding)

The Rust surface is total and panic-free: `cosine_similarity` returns `0.0` on
empty/mismatched input (`lib.rs:20`), `bm25_score` returns `0.0` on `tf<=0 ||
doc_count<=0` (`lib.rs:58`), `tokenize` cannot panic. No `unwrap`/`expect`/`panic!`,
no indexing that can go out of bounds (loops use `a.len()` after the length guard).
`#![deny(clippy::all)]` is in force. There is no path by which a Rust panic crosses
into JS, and every TS consumer goes through the fallback-guarded loader. The native
results are unit-tested on both backends (cargo + a CI pure-JS fallback gate in
`ci-native.yml`).

### Path traversal (no finding)

All vault filesystem access funnels through `resolveVaultPath`
(`vault/paths.ts:35`). `normalizeVaultPath` (`:20`) rejects absolute paths and any
`..` segment at the byte level, and `resolveVaultPath` adds a containment check via
`path.relative` against the resolved root (defends against symlink/normalization
escapes). `walkVault` skips dot-directories. This is a correct single chokepoint;
no traversal exposure was found.

### Auth / HITL (no finding, strong)

JWT verification pins HS256 (`auth/jwt.ts:16-18`), preventing alg-confusion and
`none`-alg attacks; bad signature/expiry/alg throws and maps to 401. Elicit tokens
are 128-bit random (`elicit.ts:25`), single-use via an atomic `UPDATE ... WHERE
consumed_at IS NULL` (`elicit.ts:70`), TTL-bound (default 300s), and bound to
`argsHash(tool, input)` plus vault, so a token cannot be replayed for different
arguments. The MCP edge strips `elicit_token` from args before hashing
(`mcp/server.ts:56-63`) so the token never perturbs the hash. HITL floors are
enforced for the `execute` and `bulk` families and for `admin:auth` /
`write:templater` (`scopes.ts:6-12`); command execution is deny-by-default with an
allowlist (`config.schema.ts:27-30`). Secrets (JWT, plur bearer, REST API key) come
from env/config and are never placed in logs or error/audit payloads
(`config/load.ts`, `bridge/transport.ts:7-8,106-111`).

### Tool surface (Phase 3b)

103 tools (102 `defineTool` calls across `tools/m1..m6` + `admin`, plus the
inline `createHealthTool` registered in `cli.ts:104`), grouped m1 (30: notes,
frontmatter, tags, links, registry), m2 (7: search + index), m3 (23: attachments,
bases, bookmarks, canvas, periodic, workspace), m4 (20: dataview, templater, ocr,
quickadd, tasks, makemd, excalidraw, command, bundle), m5 (15: capture, memory,
plur, sessions), m6 (7: admin, bulk, uri), admin (1: health). Naming is
consistently `snake_case` verb_noun; no outliers found in the registry (the only
non-tool `name:` strings are Prometheus metric identifiers).

Input-schema validation: every tool carries a real Zod schema via `defineTool`,
validated in dispatch before the handler runs (`registry.ts:263`). 28 fields use
`z.unknown()` / `z.record(z.unknown())` / `.passthrough()`, all for genuinely
opaque payloads (frontmatter YAML values, canvas/excalidraw/base JSON blobs,
JSONLogic, plugin args). The three no-argument tools use
`z.object({}).strict()`. No empty or accidentally permissive top-level schema was
found. Caveat (low): opaque `z.record(z.unknown())` structures (e.g. canvas
layout, base views) are not structurally validated at the boundary; malformed
structures are caught downstream or written to disk as-is.

Destructive operations: 3 tools set `destructive: true` and gate HITL in dispatch
(`delete_note` `notes-tools.ts:482`, `reload_vault` `registry-tools.ts:127`,
`delete_attachment` `attachment-tools.ts:220`). ~14 more use conditional
`requireConfirmation` for overwrite / cross-folder move / frontmatter replace /
non-dry-run rewrite / bulk-threshold cases. Bulk and execute families are HITL
floors, so `bulk_*` mutations always require confirmation. No destructive vault
operation reaches the filesystem without either an explicit `destructive` flag or
a conditional confirmation, and all go through `resolveVaultPath` + `enforcePathAcl`.

### Error-handling patterns

Dominant pattern: throw `ObsidianTcError` (or the `err.*` factories,
`errors.ts:91`), caught once in `runDispatch` (`registry.ts:348`) and converted to
a typed `ToolResult`; non-typed throwables collapse to `internal`. Observability
sinks (audit, metrics, MORGIANA) are wrapped in intentional empty catches that are
documented "must never break dispatch" (`registry.ts:118-122,127-133,253-255`),
which is correct fail-soft design, not silent failure. The bridge maps network
failures and abort/timeout to `plugin_unreachable` and whitelists passthrough
codes (`bridge/transport.ts:54-75,106-111`). No raw-string throws, no stray
`console.*` in server/shared source, and only one `@ts-expect-error` (justified,
`bun:sqlite`) and two `biome-ignore noExplicitAny` (justified, heterogeneous
registry). The one real deviation is F4 (path-ACL denial not mapped to the denied
status/metric).

### Dependency audit

Versions are coherent. OpenTelemetry SDK 2.x (`sdk-trace-node`, `resources`
`^2.8.0`) with API `^1.9.1` and exporter `^0.219.0` is the correct current
alignment (the exporter line is independently 0.x by design). `jose ^6`, `hono
^4.6`, `zod ^3.23`, `zod-to-json-schema ^3.24` are current. Rust deps are minimal
(`napi`/`napi-derive`/`napi-build` v2); ndarray, nalgebra, sqlite-vec, petgraph are
commented out as deferred (`Cargo.toml:16-24`), which is honest, not dead config.

Notable points:
- Three SQLite backends are maintained: `better-sqlite3 ^11` (native build burden),
  `node:sqlite` (experimental, runtime), and `bun:sqlite` (smoke-tested). This is a
  real long-term maintenance surface (low/med), justified by the Node-vs-Bun
  runtime split but worth consolidating when `node:sqlite` stabilizes.
- `sqlite-vec ^0.1.9` is pre-1.0 (low); acceptable but pin-worthy.
- Version drift across packages is minor: `typescript ^5.7` and `vitest ^2.1`
  agree where present; `@types/node ^22` (server, plugin) versus the node>=20 engine
  on native and the practical node>=22 requirement of the server (F12).

---

## Phase 4 — Ship health

### F3 (med-high) — non-atomic publish, no rollback, non-idempotent on retry

`publish.yml:94-107` runs, in sequence within one job: `napi prepublish` (publishes
the 4 platform sub-packages and writes umbrella `optionalDependencies`), then `npm
publish` for native, then shared, then server. Up to 7 immutable npm publishes with
no transaction. If any later step fails (network, registry, auth), earlier packages
are already public at the new version, the release is half-shipped and
version-skewed (server may reference a shared/native version that never published,
or vice versa), and re-pushing the same `v*` tag fails on the already-published
versions (npm versions are immutable). There is no `--dry-run` preflight and no
"all-or-nothing" guard.

Fix: add a preflight that verifies all target versions are unpublished before any
publish; order so the umbrella + server (which carry the cross-references) publish
last; on failure, surface a clear "partial publish, do not re-tag, bump patch"
runbook. Consider `npm publish` with a staged dist-tag (e.g. `next`) promoted to
`latest` only after all succeed.

### F7 (med) — provenance / token / org-policy assumptions

`npm publish --provenance` requires `id-token: write` (present, `publish.yml:9`) and
an OIDC-trusted runner; it relies on `NPM_TOKEN` (`:98,101,104,107`). For an
unattended publish the token must be an automation/granular token that bypasses
2FA OTP; a token on an account enforcing "auth and writes" 2FA will fail at publish
time, after native may already be live (compounds F3). Publishing under the
`@the-40-thieves` scope and the unscoped `obsidian-tc` also assumes the org and the
unscoped name are owned and that org-level GitHub Actions policy permits the
`publish.yml` actions and `id-token` issuance. None of this is validated before the
first immutable publish.

Fix: document the exact token type and 2FA posture required; add a `whoami` / scope
ownership preflight step; gate the workflow on a manual environment approval.

### F8 (low) — config accepts an auth mode the runtime cannot serve

`AuthConfigSchema.mode` enum includes `"oauth"` (`config.schema.ts:66`), but
`resolveAuth` returns HTTP 501 for it (`transports/http.ts:51`). A config with
`mode: "oauth"` validates at load and fails only at request time.

Fix: drop `"oauth"` from the enum until implemented, or reject it at config load
with a clear message.

### F5 (med) — docs vs tool surface

`docs/src/content/docs/tools/index.md:13-22` lists curated example tool names that
are not in the registry: `set_frontmatter` (actual: `update_frontmatter` /
`read_frontmatter`), `edit_canvas` (`update_canvas`), `daily_note`
(`create_periodic_note` / `get_periodic_note`), `run_dql` (`search_dql` /
`eval_dataview_field`), `run_command` (`execute_command`), `memory_write`
(`add_observation` / `create_entity`), `capture` (`enqueue_capture` /
`commit_capture`), `recall` (`plur_recall`), `build_uri` (`generate_uri`),
`get_health` (`server_health`), and the `bulk_read` / `bulk_write` / `bulk_delete`
row (actual: `bulk_create_notes` / `bulk_move_notes` / `bulk_set_property`). The
count and domain claims (103 / 28) are correct; the page itself notes that
per-tool pages are deferred, but the wrong example names will mislead integrators.

Fix: replace the examples with real tool names, or auto-generate the page from the
live `ToolRegistry` (the deferred G3 follow-up the page already mentions). A
`list()` dump validated against the doc in CI would prevent recurrence.

### Docs vs surface (positive)

No stale "coming soon / draft / TODO / unreleased" claims remain in `README.md` or
the docs landing/roadmap (recent commits removed them). README, CHANGELOG, and the
tools page all agree on 103 tools / 28 domains / 4 native prebuilds, which matches
the registry.

---

## Phase 5 — Inventory

### TODO / FIXME / HACK / XXX

None in source (`packages/**`, `scripts/**`, `*.mjs`). Work is tracked via Linear
IDs (`THE-xxx`) and explicit "deferred / out of scope" comments instead of inline
markers. Representative deferral comments (not defects):
- `transports/http.ts:51` returns 501 for unimplemented auth modes (graceful).
- `tools/m3/periodic-tools.ts:8` Templater placeholder expansion out of scope for M3.
- `shared/config.schema.ts:152` note on the M6 placeholder observability shape.

### Suppressions (all justified)

- `packages/server/src/db/bun-sqlite.ts:1` `@ts-expect-error` for `bun:sqlite`
  (resolves only under Bun). Justified.
- `packages/server/src/mcp/registry.ts:92,179` two `biome-ignore noExplicitAny`
  for the heterogeneous tool registry (contravariant handler input). Justified.
- `packages/native/src/lib.rs:1` `#![deny(clippy::all)]` (stricter, not a relaxation).
- No `eslint-disable`, no `@ts-ignore`, no `@ts-nocheck`, no `#[allow(...)]`.

### Dead code / unreachable exports

No dead exports found. Commented-out Cargo deps are intentional V2 deferrals
(`Cargo.toml:16-24`). The `defineTool` helper erases types via a documented,
sound cast (`tools/m1/define.ts`). The hand-written `index.js` deliberately
replaces the napi-generated loader (the friction point is F1, not dead code).

### Contradictions with README / docs

- F5 (doc example names) is the substantive one.
- The prompt's "105+ tools" and "six packages" do not match the repo; the repo's
  own docs are internally consistent at 103 tools / 7 published npm packages.
- F12: `packages/native/package.json:32` `node >= 20` versus the server's practical
  Node >= 22 requirement (node:sqlite) and CI's Node 22 pin.

### Lower-severity hygiene

- F11 (low): `cargo test` prints ~30 `Load Node-API [...] GetProcAddress failed`
  lines (the test binary loads napi symbols with no Node host). Harmless but noisy;
  consider gating the napi exports behind a test cfg or documenting the noise.
- F12 (low): per-worker `ExperimentalWarning: SQLite is experimental` on every
  vitest file; align the engine field to `node >= 22` and document the flag.
- F13 (low): `shared` and `plugin` have zero own tests
  (`shared/package.json:13` `--passWithNoTests`; plugin has no test script).
- F10 (low): `Cargo.lock` is neither committed nor gitignored; it appears untracked
  after any native build.

---

## Prioritized remediation

1. F1 (high) — disable napi JS/d.ts generation in the native `build` script (`--js
   false --dts false` or rename the loader) and add a `git diff --exit-code` guard
   in CI. Resolve `Cargo.lock` tracking. Unblocks `bun run build && bun run lint`.
2. F2 (high) — refuse to bind HTTP on a non-loopback host while `auth.mode ===
   "none"` (fail closed, explicit opt-out). Do not set `authenticated: true` for the
   `none` path, or document it as trusted-local-only.
3. F3 (med-high) — make publish all-or-nothing: preflight unpublished-version
   check, publish cross-referencing packages last, staged dist-tag promotion, and a
   partial-publish runbook.
4. F7 (med) — document and preflight the npm token / 2FA / org-policy assumptions;
   add an environment approval gate.
5. F4 (med) — map `acl_denied` to the `denied` status in `callStatusForError` and
   fire `incAclDenied` / `tc.acl.denied` for it (`registry.ts:46-56,163-176,354`).
6. F5 (med) — correct the docs Tool Reference example names or auto-generate from
   the registry; add a CI check comparing the doc to `registry.list()`.
7. F6 (med) — converge the duplicate error codes (canonical-plus-alias now,
   collapse post-1.x).
8. F8 (low) — remove `"oauth"` from the auth-mode enum until implemented, or reject
   at load.
9. F10-F13 (low) — commit/ignore `Cargo.lock`; align native `node` engine to >= 22;
   quiet the cargo napi-symbol warnings; add minimal `shared`/`plugin` tests.
