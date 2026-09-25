# @the-40-thieves/obsidian-tc-embedder-local

An **optional**, fully offline dense embedder for obsidian-tc's `embeddings.provider: "local"` —
the DEFAULT embeddings provider when the `embeddings` config block is absent. No Ollama, no API
key, no network call after the first use.

Runtime: [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) v4
(Transformers.js), running the quantized ONNX export of
[nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (Apache-2.0, 768
dimensions, ~137 MB) by default — chosen by measurement against a public corpus, not by picking the
smallest download; two smaller/faster catalog entries (`all-MiniLM-L6-v2`, `bge-small-en-v1.5`,
both 384-dim) are selectable via `embeddings.model`. See `docs/EVALUATION.md`'s "Local embedder
model selection" in the main repo for the full comparison.

## Why this package is NOT a root workspace member

Same reasoning as `packages/reranker-local` (see its own README): its runtime dependency
(`@huggingface/transformers`, which pulls in `onnxruntime-node`'s platform binaries) is large
enough that making it a root workspace member would download it on every `bun install
--frozen-lockfile` at the repo root, whether or not anyone uses the `local` embedder. Keeping it a
self-contained package with its own install step is what makes it genuinely optional.

`packages/server` never declares this package as a dependency either — it reaches it via a
three-route resolution ladder of runtime `import()` calls (see "Resolution ladder" below and
`packages/server/src/providers/registry.ts`'s `resolveLocalEmbedderModule`), and resolution failure
degrades gracefully (the same behaviour an unreachable hosted embeddings provider has always had)
rather than crashing boot.

## Setup

```bash
# 1. Install and build this package:
cd packages/embedder-local && bun install && bun run build

# 2. (Optional) pre-fetch and checksum-verify the pinned model weights into ./models/, gitignored.
#    Not required — the provider fetches and verifies them automatically on the FIRST embed() call
#    if they are not already present. Run this step anyway for an offline deployment, or in CI, to
#    avoid a network call on first use:
bun run fetch-model
```

`bun run fetch-model --check` verifies an existing download without touching the network. `--dir
<path>` downloads elsewhere; `--model <name>` selects a different catalog entry.

## Resolution ladder

`providers/registry.ts`'s `local` embeddings entry (`resolveLocalEmbedderModule`) tries THREE
routes, in order, and never throws:

| Route | When it applies |
|---|---|
| (i) explicit path | An absolute path to this package's built `dist/index.js`, for an npm-installed server pointed at a checkout of this package elsewhere. |
| (ii) bare specifier (`@the-40-thieves/obsidian-tc-embedder-local`) | Works once this package is published to npm and `bun add`ed (or `bun link`ed) into whatever installs obsidian-tc's server package. |
| (iii) automatic source-checkout fallback | Works out of the box for a SOURCE CHECKOUT of the `obsidian-tc` monorepo, once step (1) above has run — `providers/registry.ts` resolves `packages/embedder-local/dist/index.js` relative to itself. |

Every failed attempt is logged (`console.error`, one line per route) and surfaced by `obsidian-tc
doctor`'s `embeddings.buildable` check with the exact remedy. Resolution failure **never crashes
boot** — dense retrieval and indexing degrade the same way an unreachable hosted embeddings
provider has always degraded (a `[index] reconcile degraded` notice; lexical/FTS search stays
fully functional).

## Behavior

- **Lazy, memoized session.** `createEmbeddingProvider()` returns the provider object immediately
  — no import of `@huggingface/transformers`, no model load. `packages/server`'s registry resolves
  this package's own module lazily too (its `embed()` closure does the work on first call). The
  runtime import and the model/tokenizer load happen once, on the first real `embed()` call, and
  are cached for the process's lifetime.
- **Fetched and verified on first use, never at import time.** If the pinned files for the
  requested catalog entry are not already present (and sha256-verified against `src/model-info.ts`)
  under `<modelsRoot>/<model-id>/<revision>/`, the first `embed()` call downloads them there via
  `src/model-fetch.ts` — a temp-dir download, whole-batch verification, one retry, and an atomic
  rename into place, so no reader ever observes a partially-downloaded directory.
  `env.allowRemoteModels` is `false` for `@huggingface/transformers` itself — ONLY this package's
  own verified fetch touches the network. A fetch/verify failure throws an error naming `bun run
  fetch-model` as the offline alternative.
- **Degrades gracefully, never silently.** A resolution or download failure surfaces as a rejected
  `embed()` promise; the existing boot-reconcile degradation path (same one an unreachable Ollama
  endpoint has always used) catches it. `obsidian-tc doctor` keeps it loud via the
  `embeddings.buildable` check.
- **`bun --compile` and the `.mcpb` bundle are out of scope.** `onnxruntime-node` (a transitive
  dependency) dlopens a sidecar `.node`/`.so` file next to itself at runtime — that cannot survive
  being embedded in a single-file Bun standalone binary or a `.mcpb` bundle. The `local` embedder is
  unreachable from those two install methods; set `embeddings.provider` to a hosted or self-hosted
  backend there instead. It IS reachable from a source checkout (route iii above) and from an
  npm-installed server pointed at it via an explicit module path (route i).

## Provenance

Pinned model repo, revision, and per-file sha256 checksums for every catalog entry (both the
quantized q8 and full-precision fp32 ONNX variant) live in `src/model-info.ts` — the single source
of truth `src/model-fetch.ts` verifies against. Checksums were computed directly (downloaded +
sha256sum) at the pinned revision on 2026-09-24. The on-disk layout is REVISION-scoped —
`<root>/<model-id>/<revision>/...` — so a future revision bump gets its own directory instead of
silently reusing (or colliding with) a previous revision's files; this is also the literal path
handed to `@huggingface/transformers`'s `from_pretrained` as `path_or_repo_id`, not
`env.localModelPath` + the bare model id — see `src/model-fetch.ts`'s `modelDirFor` for why that
mechanism is what makes the revision segment work with the library's real path-join contract.

## License

AGPL-3.0-only, same as the rest of obsidian-tc. See `LICENSE`.
