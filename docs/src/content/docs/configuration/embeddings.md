---
title: Embeddings
description: The embeddings provider — zero-config local by default, or point at a hosted/self-hosted backend.
---

Semantic search and graph-seeded retrieval both need vectors, produced by an **embeddings
provider**. `embeddings` is absent from a minimal config on purpose: the default provider is
`local`, a bundled, fully offline dense embedder — no Ollama, no API key, no network call after
the first run.

## Zero configuration: `local`

```json
{
  "vaults": [{ "id": "primary", "path": "/home/user/vaults/primary" }]
}
```

With no `embeddings` block at all, indexing and semantic search work immediately. On its first
embed call, the server downloads a quantized ONNX model (~137 MB)
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
`bun --compile` binary and the one-click `.mcpb` bundle (see
[Availability by install method](#availability-by-install-method) below) — the npm and Docker
installs are the ones this default targets.

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
candidates (`all-MiniLM-L6-v2`, `bge-small-en-v1.5`) measurably regressed strict nDCG@10 past the
−0.015 non-inferiority floor against `nomic-embed-text-v1.5` run through the identical code path
(one-sided 95% lower bound −0.119 and −0.067 respectively, n=78) — `bge-small-en-v1.5` was the
stronger of the two but still failed. `nomic-embed-text-v1.5` is the default because it is the
only catalog entry that does not regress retrieval quality; the smaller models remain available
via `embeddings.model` for deployments that prioritize download size or CPU cost over recall.

Two other candidates were evaluated and **dropped** before reaching the measurement stage, not
silently excluded: EmbeddingGemma-300M's model card carries Google's Gemma Terms of Use — a
custom license with a unilaterally-updatable prohibited-use policy and redistribution obligations
that do not fit "auto-downloaded by default from every install of an AGPL-3.0 public server" —
and a model2vec/potion static-embedding model has no Transformers.js-loadable ONNX export today
(verified directly: it fails at inference with a missing-input error, not a licensing one).

### Availability by install method

`local` resolves the optional `@the-40-thieves/obsidian-tc-embedder-local` package the same way
the local reranker resolves its own package — a published-npm route, a source-checkout route (for
anyone developing inside the monorepo), and an explicit-path escape hatch. `@huggingface/transformers`
pulls in `onnxruntime-node`'s native platform binaries, which cannot survive `bun build --compile`
or ship inside a `.mcpb` bundle — the same constraint the local reranker documents. Practically:

| Install method | `local` embedder |
| --- | --- |
| npm | Works — resolves via the published package. |
| Docker (GHCR) | Works — the image is an npm install under the hood. |
| Standalone binary (`bun --compile`) | **Unavailable.** Set `embeddings.provider` to a hosted/self-hosted backend instead. |
| One-click `.mcpb` bundle | **Unavailable**, same reason. |

An unresolvable `local` provider does not crash boot — the same graceful degradation an
unreachable Ollama endpoint has always had (a `[index] reconcile degraded` notice, FTS/lexical
search stays fully functional). `obsidian-tc doctor` reports it as a `fail`-status
`embeddings.buildable` check <!-- config-path:ignore --> (a doctor check id, not a config path)
rather than a silent gap — run `obsidian-tc doctor` directly to see it.

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
still works exactly as it always has — nothing about the `ollama` provider itself changed — but
**always pair it with an explicit `model`**: the schema's own default `model`/`dimensions` values
now belong to `local`, so `{ "embeddings": { "provider": "ollama" } }` with no `model` set no
longer resolves to `nomic-embed-text`.

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
