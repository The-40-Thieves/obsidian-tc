---
title: Embeddings
description: The embeddings provider — zero-config local by default, or point at a hosted/self-hosted backend.
---

Semantic search and graph-seeded retrieval both need vectors, produced by an **embeddings
provider**. `embeddings` is absent from a minimal config on purpose: the default provider is
`local`, a bundled, fully offline dense embedder — no Ollama, no API key, no network call after
the first run. **This works today for a source checkout of this monorepo** (`git clone` +
`bun install`); on the published npm package and the Docker image it is not yet reachable pending
the package's first npm publish (a deferred owner action — see [Availability by install
method](#availability-by-install-method) below for the exact current state and the workaround).

## Zero configuration: `local`

```json
{
  "vaults": [{ "id": "primary", "path": "/home/user/vaults/primary" }]
}
```

With no `embeddings` block at all, indexing and semantic search work immediately, PROVIDED the
`local` provider resolves on this install (see [Availability by install
method](#availability-by-install-method) below — today, that means a source checkout). On its
first embed call, the server downloads a quantized ONNX model (~137 MB)
([`nomic-embed-text-v1.5`](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5), Apache-2.0
licensed, 768 dimensions) from Hugging Face, checksum-verifies it file-by-file, and caches it
under `<cacheDir>/models/embedder-local/`. Every embed call after that is offline — no network,
no external service. Two smaller, faster catalog entries (~23-34 MB, 384 dimensions) are also
available — see [Model choice: measured, not assumed](#model-choice-measured-not-assumed) for why
they are not the default.

Runtime: [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers)
v4 (Transformers.js) running on CPU, via the optional
`@the-40-thieves/obsidian-tc-embedder-local` package — the same "small optional package, resolved
at runtime, never a hard dependency of the server" shape as the [local
reranker](/configuration/config-yaml/#reranker). It is unavailable on the standalone
`bun --compile` binary and the one-click `.mcpb` bundle regardless of publishing status (see
[Availability by install method](#availability-by-install-method) below).

To choose explicitly, or to pick a different catalog model:

```json
{
  "embeddings": {
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "quantized": true
  }
}
```

| Field | Type, default | Meaning |
| --- | --- | --- |
| `model` | string, `nomic-embed-text-v1.5` | One of the pinned catalog names: `all-MiniLM-L6-v2`, `bge-small-en-v1.5`, `nomic-embed-text-v1.5`. Only these three are supported under `provider: "local"` — the download is checksum-verified against a pinned manifest, which requires knowing the exact bytes ahead of time. An unrecognized name is refused with the supported list. |
| `quantized` | boolean, `true` | `true` loads the pinned q8 (int8) ONNX export; `false` loads the pinned fp32 export — larger, slower, marginally more precise. Both variants are separately checksummed. |
| `threads` | int, unset | onnxruntime-node intra-/inter-op thread count. Unset lets the runtime pick its own default (usually the CPU core count). |
| `dimensions` | int, model-native | Set automatically from `model` (768 for nomic-embed-text-v1.5, 384 for the smaller MiniLM/bge-small entries) — only override this if you also set `truncate` (see [Embedding model migration](/configuration/embedding-model-migration/)). |

### Model choice: measured, not assumed

Three candidates were benchmarked against a public, third-party-judged corpus before picking the
default — see [`docs/EVALUATION.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/EVALUATION.md#local-embedder-model-selection)
for the full table (nDCG@10, recall, first-index time, model size, RAM) and the non-inferiority
bar each candidate had to clear. **The result was not the smaller/faster pick**: both 384-dimension
candidates (`all-MiniLM-L6-v2`, `bge-small-en-v1.5`), each run with its own correct pooling
strategy, failed strict nDCG@10's −0.015 non-inferiority floor against `nomic-embed-text-v1.5` run
through the identical code path (one-sided 95% lower bound −0.151 and −0.110 respectively, n=78).
MiniLM's deficit is clearly significant; bge-small's nDCG@10 does not reach conventional
significance at this n, so read that one number as non-inferiority not established at this
corpus's resolution rather than a pass — its recall@10 IS significant, and it still fails the
floor on its own lower bound either way. `nomic-embed-text-v1.5` is the default as the conservative
choice under this comparison, not a claimed decisive win; the smaller models remain available via
`embeddings.model` for deployments that prioritize download size or CPU cost over this measurement.

Two other candidates were evaluated and **dropped** before reaching the measurement stage, not
silently excluded: EmbeddingGemma-300M's model card carries Google's Gemma Terms of Use — a
custom license with a unilaterally-updatable prohibited-use policy and redistribution obligations
that do not fit "auto-downloaded by default from every install of an AGPL-3.0 public server" —
and a model2vec/potion static-embedding model has no Transformers.js-loadable ONNX export today
(verified directly: it fails at inference with a missing-input error, not a licensing one).

### Availability by install method

`local` resolves the optional `@the-40-thieves/obsidian-tc-embedder-local` package the same way
the local reranker resolves its own package — a published-npm route, a source-checkout route (for
anyone developing inside the monorepo), and an explicit-path escape hatch. Like the local reranker,
**the package's first publish to npm is a deferred, one-time step** (see the package's own
`README.md`'s "Publishing status") — until that has happened, the published-npm route does not
resolve anywhere. `@huggingface/transformers` also pulls in `onnxruntime-node`'s native platform
binaries, which cannot survive `bun build --compile` or ship inside a `.mcpb` bundle regardless —
the same constraint the local reranker documents. Practically, today:

| Install method | `local` embedder |
| --- | --- |
| A source checkout of this monorepo (`git clone` + `bun install`) | Works — resolves via the source-checkout route once `packages/embedder-local` is built (`bun run build` there; CI does this automatically). |
| npm (`npm install -g obsidian-tc`) | **Not yet.** The published-npm route needs the package's first `npm publish`, a deferred owner action — see [Known gaps](#known-gaps) below. |
| Docker (GHCR) | **Not yet**, same reason — the image ships only the built server bundle, no `node_modules`. |
| Standalone binary (`bun --compile`) | **Unavailable**, structurally (the `onnxruntime-node` constraint above) — set `embeddings.provider` to a hosted/self-hosted backend instead, regardless of publishing status. |
| One-click `.mcpb` bundle | **Unavailable**, same structural reason. |

An unresolvable `local` provider does not crash boot — the same graceful degradation an
unreachable Ollama endpoint has always had (a `[index] reconcile degraded` notice, FTS/lexical
search stays fully functional). `obsidian-tc doctor`'s check (a doctor check id, not a config path, named `embeddings.buildable` <!-- config-path:ignore -->) distinguishes the two
gaps above: **WARN** when running from a source checkout where the package simply hasn't been
built yet (a one-command fix), and **FAIL** everywhere else the package genuinely cannot resolve —
which, honestly, is every non-source-checkout install method today, until the first publish lands.

### Known gaps

**On npm and Docker installs specifically, `local` does not resolve today** — the same
not-yet-published-to-npm state the local reranker has been in since it shipped (its own
`README.md` documents this candidly), just higher-stakes here because `local` is the schema
default rather than an opt-in fallback. Until the package's first `npm publish` (and, for Docker,
a follow-up image change to actually install it), an npm or Docker deployment needs an explicit
hosted or self-hosted `embeddings.provider` (see [Hosted and self-hosted
providers](#hosted-and-self-hosted-providers) above) for semantic search to work. A source checkout
of the monorepo is unaffected — the source-checkout resolution route works today, which is how
this document's own [measurement table](#model-choice-measured-not-assumed) was produced.

**Install footprint is heavier than the pinned model download.** `packages/embedder-local`'s
`node_modules` is ~585 MB, almost entirely `@huggingface/transformers`'s two bundled ONNX
runtimes: `onnxruntime-node` (~288 MB, the one actually used) and `onnxruntime-web` (~141 MB).
Transformers.js's Node build (`dist/transformers.node.mjs`, selected via the package's `"node"`
export condition) never `require()`s `onnxruntime-web` at runtime — it bundles a browser/WebGPU
code path that this package's CPU-only Node usage never reaches — but it is still a hard
`dependencies` entry of `@huggingface/transformers`, so every install pays for it on disk
regardless. Excluding it would need overriding the resolved package to a stub, which this PR
does not attempt without an integration test proving the override is safe on every supported
platform (see the model-load CI leg tracked separately); until then, budget ~585 MB of install
size for this optional package, on top of the ~137 MB (or ~23-34 MB for the smaller catalog
entries) of pinned model weights downloaded on first use.

**RAM**: peak RSS during first-index varies by catalog entry — see the per-model column in the
[measurement table](#model-choice-measured-not-assumed) rather than a single number here, since
`all-MiniLM-L6-v2`/`bge-small-en-v1.5` (384-dim) and the default `nomic-embed-text-v1.5` (768-dim)
measure differently. This is the `obsidian-tc index` process's own footprint (model load + ONNX
runtime + the batch of vectors being produced), not additive with any other provider's, since a
given process runs only the one provider it is configured for.

**`embeddings.quantized` toggles automatically trigger a rebuild; a future catalog revision bump
does not.** Switching `quantized` between its default `true` (q8) and `false` (fp32) — same
catalog `model` name, same `dimensions` — changes which ONNX export produces the vectors, so it is
folded into `vec_index_fingerprint` and rebuilds `vec_chunks` on its own. A pinned catalog entry's
underlying Hugging Face revision, by contrast, is a package-internal constant
(`packages/embedder-local/src/model-info.ts`'s `revision` field) that does not flow into the
fingerprint automatically — this matches how every OTHER built-in provider already handles the
same concern (`model-tier`'s own per-service `revision` fields are explicitly "provenance only" in
`config.schema.ts`'s own description; the documented fix there is the same top-level
`embeddings.revision` this paragraph is about). If a future `@the-40-thieves/obsidian-tc-embedder-local`
release repins a catalog entry's Hugging Face revision under the same catalog name, set
`embeddings.revision` explicitly (any string) after upgrading to force a rebuild — omitting it
reproduces today's behavior (the previous checkpoint's vectors keep serving) exactly, same as it
does for every other provider.

## Hosted and self-hosted providers

Every built-in from before this default changed is unchanged and still fully supported — `local` only changes
what an **absent** block resolves to.

```json
{
  "embeddings": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Built-ins: `openai`, `voyage`, `cohere`, `bge-m3`, `model-tier` (splits dense and multi-vector
across two services), the generic `openai-compatible` (any OpenAI-embeddings-shaped endpoint —
LM Studio, vLLM, a gateway), `ollama` (deprecated but fully functional — see below), and the
profile-gated `module` escape hatch. See [Configuration
reference](/configuration/config-yaml/#embeddings) for the complete field list.

### `ollama` (deprecated, still supported)

`ollama` (model `nomic-embed-text`) was previously the zero-config default. Setting it explicitly
still works exactly as it always has, including the implicit model — `{ "embeddings": {
"provider": "ollama" } }` with no `model` set still resolves to `nomic-embed-text`/768, the same
pairing it always has. (This is restored one layer above the raw config schema — see [Upgrading
from a pre-local-embedder config](#upgrading-from-a-pre-local-embedder-config) below for exactly
what changed and what didn't.)

```json
{
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768
  }
}
```

It is marked deprecated (`obsidian-tc doctor` surfaces an advisory note, not a warning) because the
generic `openai-compatible` adapter already serves Ollama's OpenAI-shaped `/v1/embeddings`
endpoint. **Do not switch a live deployment** without planning a re-embed:
the internal `provider.id` identity field <!-- config-path:ignore --> is the vector-index fingerprint, so changing it re-embeds the whole vault; see [Embedding model
migration](/configuration/embedding-model-migration/).

## Changing providers or models on a live index

A provider or model change is a **coordinated migration**, not a drive-by config edit — see
[Embedding model migration](/configuration/embedding-model-migration/) for the full procedure. In
short: the server detects a stored-vs-configured mismatch automatically (the representation
fingerprint folds in provider, model, and dimensions) and rebuilds the vector index rather than
silently mixing vectors from two different spaces — but a dimension change also needs a full
re-embed, which the migration page walks through.

## Upgrading from a pre-local-embedder config

If your config had no `embeddings` block at all before this default changed: **it previously meant
Ollama** (`provider: "ollama"`, model `nomic-embed-text`); **it now means the in-process embedder**
(`provider: "local"`, model `nomic-embed-text-v1.5`). The server detects the mismatch automatically
on first boot after upgrading (the representation fingerprint folds in provider and model) and
rebuilds the vector index from a full re-embed — `obsidian-tc doctor` and the boot log both name
this explicitly the first time they see a stored fingerprint from a different provider than the one
your config now resolves to. To keep using Ollama unchanged, add `"embeddings": { "provider":
"ollama" }` to your config explicitly — the implicit model (`nomic-embed-text`) is preserved for
that one case; see [`ollama` (deprecated, still supported)](#ollama-deprecated-still-supported)
above.
