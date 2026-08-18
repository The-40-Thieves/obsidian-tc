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

`packages/server` never declares this package as a dependency either — it reaches it via a plain
runtime `import()` of the package name (see `packages/server/src/providers/registry.ts`'s `local`
reranker entry), and reports an actionable error naming the install command below when the import
fails.

## Setup

```bash
# 1. Install this package (from the repo root, or wherever obsidian-tc's server package lives):
cd packages/reranker-local && bun install

# 2. Download and checksum-verify the pinned model weights (~23 MB) into ./models/, gitignored:
bun run fetch-model

# 3. Point obsidian-tc at it:
#    { "reranker": { "provider": "local" } }
# or, if you downloaded the weights somewhere else:
#    { "reranker": { "provider": "local", "localModelPath": "/absolute/path/to/models" } }
```

`bun run fetch-model --check` verifies an existing download without touching the network; useful in
CI to fail fast on a stale or corrupted cache. `--dir <path>` downloads elsewhere.

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
  Bun standalone binary. The `local` provider is unreachable from a compiled obsidian-tc binary; it
  works from the npm-published server package and from source. A Rust-native fallback (via
  `packages/native`) is the documented path to compiled-binary parity, out of scope for this ticket
  (see the THE-705 research brief §1c).

## Provenance

Pinned model repo, revision, and per-file sha256 checksums live in `src/model-info.ts` — that is the
single source of truth `scripts/fetch-model.mjs` verifies against. The int8 ONNX file's checksum was
cross-checked against the Hugging Face API's own reported LFS sha256 for that file at the pinned
revision; the small config/tokenizer files (not LFS-tracked) were downloaded and hashed directly.
