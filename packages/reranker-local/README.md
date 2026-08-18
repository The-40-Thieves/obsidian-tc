# @the-40-thieves/obsidian-tc-reranker-local

THE-705 item 1 — an **optional**, fully offline cross-encoder reranker for obsidian-tc's `gatedRerank`
seam. No `OBSIDIAN_TC_GATEWAY_URL`, no `bge-m3-service`, no network at inference time.

Runtime: [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) v4
(Transformers.js), running the int8 ONNX export of
[cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)
(via [Xenova/ms-marco-MiniLM-L-6-v2](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2), Apache-2.0,
~23 MB, CPU-only) — see `THE-705-cross-encoder` research brief for the full comparison this model and
runtime were chosen from.

## Why this package is NOT a root workspace member

Unlike `packages/server`/`packages/shared`/`packages/native`, this package is **excluded from the
root `workspaces` array** on purpose, the same way `docs/` is (see repo root `CLAUDE.md`). Its
runtime dependency (`@huggingface/transformers`, which pulls in `onnxruntime-node`'s platform
binaries) is ~230 MB unpacked — if it were a root workspace member, every `bun install
--frozen-lockfile` at the repo root (every contributor checkout, every CI job) would download that,
whether or not anyone uses the `local` reranker. Keeping it a self-contained package with its own
install step is what makes it genuinely optional rather than optional-in-name-only.

`packages/server` never declares this package as a dependency either — it reaches it via a
three-route resolution ladder of runtime `import()` calls (see "Resolution ladder" below and
`packages/server/src/providers/registry.ts`'s `resolveLocalRerankerModule`), and reports an
actionable remedy — via a server-log line at boot and via `obsidian-tc doctor` — when none of the
three resolve. Resolution failure never crashes boot.

## Publishing status

**Not yet published to npm.** That's a deferred owner action, not a blocker for using this package —
`packages/server`'s `local` reranker entry resolves it through a three-route ladder (below), and two
of the three routes work today without npm. Until it IS published, an **npm-installed** obsidian-tc
server (as opposed to a source checkout of this monorepo) can only reach it via
`reranker.localModulePath`.

## Setup

```bash
# 1. Install and build this package:
cd packages/reranker-local && bun install && bun run build

# 2. Download and checksum-verify the pinned model weights (~23 MB) into ./models/, gitignored:
bun run fetch-model

# 3. Point obsidian-tc at it — see "Resolution ladder" below for which of these you need.
```

`bun run fetch-model --check` verifies an existing download without touching the network; useful in
CI to fail fast on a stale or corrupted cache. `--dir <path>` downloads elsewhere.

## Resolution ladder

`providers/registry.ts`'s `local` entry (`resolveLocalRerankerModule`) tries THREE routes, in order,
and never throws — see that function's own doc comment for the full contract. Which one applies
depends on how you're running obsidian-tc:

| Route | Config | When it applies |
|---|---|---|
| (i) `reranker.localModulePath` | `{ "reranker": { "provider": "local", "localModulePath": "/abs/path/to/packages/reranker-local/dist/index.js" } }` | **Always works**, once (1) above has been run — an explicit pointer at the built entry file. The only route that works for an **npm-installed** obsidian-tc server before this package is published. |
| (ii) bare specifier (`@the-40-thieves/obsidian-tc-reranker-local`) | `{ "reranker": { "provider": "local" } }` | Works once this package is published to npm and `bun add`ed (or `bun link`ed) into whatever installs obsidian-tc's server package. **Not yet possible** — see "Publishing status" above. |
| (iii) automatic source-checkout fallback | `{ "reranker": { "provider": "local" } }` — no override needed | Works out of the box for a SOURCE CHECKOUT of the `obsidian-tc` monorepo (this repo, cloned), once step (1) above has run — `providers/registry.ts` resolves `packages/reranker-local/dist/index.js` relative to itself. |

If `reranker.localModelPath` (the model weights directory, step 2 above) is on a non-default path,
set it alongside whichever route above you're using — it is independent of the module-resolution
route.

Every failed attempt is logged (`console.error`, one line per route) and, when a `reranker.provider:
"local"` block is declared, surfaced by `obsidian-tc doctor` with the exact remedy. Resolution
failure **never crashes boot** — it degrades to RRF-only, exactly like every other reranker's
"not configured"/"unreachable" case.

## Behavior

- **Lazy, memoized load.** `createReranker()` returns immediately — no import of
  `@huggingface/transformers`, no model load. The runtime import and the model/tokenizer load happen
  once, on the **first** `rerank()` call, and are cached for the process's lifetime. Configuring
  `reranker.provider: "local"` but never triggering `gatedRerank`'s hardness gate costs nothing extra
  at boot.
- **Offline by construction.** `env.allowRemoteModels = false` — if the pinned files are not present
  under `localModelPath`, the first `rerank()` call rejects with an error naming this package's
  `bun run fetch-model` step, rather than falling back to a Hub download.
- **Degrades to RRF-only.** Like every other reranker in obsidian-tc, a failure here (weights not
  downloaded, unsupported platform, `@huggingface/transformers` not installed) is caught by
  `search/rerank.ts`'s `rerankWithScores` and reported as `provider_error`; retrieval falls back to
  its pre-rerank order rather than failing the request.
- **`bun --compile` is out of scope.** `onnxruntime-node` (a transitive dependency) dlopens a sidecar
  `.node`/`.so` file next to itself at runtime — that cannot survive being embedded in a single-file
  Bun standalone binary. The `local` provider is unreachable from a compiled obsidian-tc binary
  (`packages/server`'s `build` script and the release `--compile` step both mark this package
  `--external` so that limitation fails gracefully instead of breaking the compile itself). It IS
  reachable from a **source checkout** of this monorepo (route iii above, once built) and from an
  npm-installed server pointed at it via `reranker.localModulePath` (route i) — see "Resolution
  ladder" above; it is **not yet** reachable via a plain `bun add` from an npm-installed server,
  since this package is not yet published (see "Publishing status" above). A Rust-native fallback
  (via `packages/native`) is the documented path to compiled-binary parity, out of scope for this
  ticket (see the THE-705 research brief §1c).

## Provenance

Pinned model repo, revision, and per-file sha256 checksums live in `src/model-info.ts` — that is the
single source of truth `scripts/fetch-model.mjs` verifies against. The int8 ONNX file's checksum was
cross-checked against the Hugging Face API's own reported LFS sha256 for that file at the pinned
revision; the small config/tokenizer files (not LFS-tracked) were downloaded and hashed directly.
