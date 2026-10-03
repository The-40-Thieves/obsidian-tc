---
title: Embeddings
description: The embeddings provider — zero-config local by default, or point at a hosted/self-hosted backend.
---

Semantic search and graph-seeded retrieval both need vectors, produced by an **embeddings
provider**. `embeddings` is absent from a minimal config on purpose: the default provider is
`local`, a bundled, fully offline dense embedder — no Ollama, no API key, no network call after
the first run. **This works today for a source checkout of this monorepo** (`git clone` +
`bun install`) and the Docker image; on the published npm package it is not yet reachable pending
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
reranker](/configuration/config-yaml/#reranker). It is reachable from the npm install, the
standalone `bun --compile` binary (compiled in) and the one-click `.mcpb` bundle (bundled), with the
one exception of the macOS x64 binary (see [Availability by install
method](#availability-by-install-method) below).

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
| `threads` | int, unset | onnxruntime-node intra-/inter-op thread count override. Unset does NOT leave this to the runtime's own default (GH #995) — it caps the intra-op pool to a quarter of the host's available CPU cores (minimum 1), sets inter-op threads to 1, and disables ORT thread spinning. An explicit value overrides that default outright for both intra- and inter-op. |
| `dimensions` | int, model-native | Set automatically from `model` (768 for nomic-embed-text-v1.5, 384 for the smaller MiniLM/bge-small entries) — only override this if you also set `truncate` (see [Embedding model migration](/configuration/embedding-model-migration/)). |

### Model choice: measured, not assumed

Three candidates were benchmarked against a public, third-party-judged corpus before picking the
default — see [`docs/EVALUATION.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/EVALUATION.md#local-embedder-model-selection)
for the full table (nDCG@10, recall, first-index time, model size, RAM) and the non-inferiority
bar each candidate had to clear. **The result was not the smaller/faster pick**: both 384-dimension
candidates (`all-MiniLM-L6-v2`, `bge-small-en-v1.5`), each run with its own correct pooling
strategy, failed strict nDCG@10's −0.015 non-inferiority floor against `nomic-embed-text-v1.5` run
through the identical code path (one-sided 95% lower bound −0.151 and −0.110 respectively, n=78).
MiniLM's deficit is real and clearly detected; bge-small's nDCG@10 does not reach conventional
significance at this n, so read that one number as non-inferiority not established at this corpus's
resolution rather than a pass — its recall@10 IS significant, and it still fails the floor on its
own lower bound either way. `nomic-embed-text-v1.5` is the default as the conservative choice under
this underpowered comparison, not a claimed decisive win; the smaller models remain available via
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
anyone developing inside the monorepo), and an explicit-path escape hatch. The package is published to npm, so a
normal install resolves it. `@huggingface/transformers` also pulls in `onnxruntime-node`'s native platform
binaries. Those cannot be loaded from inside a single-file executable or a bundle as they are, so
`scripts/build-binary.ts` (the standalone binaries) and `scripts/bundle-mcpb.ts` (the `.mcpb`) bundle
the embedder with a few build-time rewrites (`scripts/lib/embedder-bundle.mjs`) and ship the
platform's ONNX runtime files alongside: embedded in the binary and unpacked into
`<cacheDir>/runtime/` on first use, or sitting in the bundle's `ort/<platform>/` directory. The local
reranker has no such packaging, so it stays unreachable there. Practically, today:

| Install method | `local` embedder |
| --- | --- |
| A source checkout of this monorepo (`git clone` + `bun install`) | Works — resolves via the source-checkout route once `packages/embedder-local` is built (`bun run build` there; CI does this automatically). |
| Docker (GHCR) | **Works** — the image builds `packages/embedder-local` from source in the same stage as the server and copies its built package (dist + `node_modules`) into the same relative path the source-checkout resolution route walks for, so the identical route resolves inside the container. |
| npm (`npm install -g obsidian-tc`) | **Works.** `packages/server`'s `package.json` declares `@the-40-thieves/obsidian-tc-embedder-local` as an `optionalDependencies` entry, so a fresh `npm install` pulls it. The first-run matrix (`ci-first-run-smoke`) runs a real semantic search on the published package on Linux, macOS and Windows. |
| Standalone binary (`bun --compile`) | **Works** on Linux x64 and arm64, macOS arm64 and Windows x64: compiled in, about 14 MB larger. **Unavailable on macOS x64**, which `onnxruntime-node` publishes no build for: set `embeddings.provider` to a hosted/self-hosted backend there. |
| One-click `.mcpb` bundle | **Works** on Linux x64 and arm64, macOS arm64 and Windows x64 (the bundle carries those platforms' ONNX runtime; it is about 52 MB). Elsewhere, set a hosted/self-hosted `embeddings.provider`. |

An unresolvable `local` provider does not crash boot — the same graceful degradation an
unreachable Ollama endpoint has always had (a `[index] reconcile degraded` notice, FTS/lexical
search stays fully functional). `obsidian-tc doctor`'s check (a doctor check id, not a config path, named `embeddings.buildable` <!-- config-path:ignore -->) distinguishes: **WARN** when running
from a source checkout where the package simply hasn't been built yet (a one-command fix) or when
the platform genuinely has no `onnxruntime-node` prebuild AND another provider is already
configured, and **FAIL** — with remediation naming the exact fix — when the platform IS supported
but the package still cannot resolve (for example an npm install that skipped optional dependencies).

### Known gaps

**A platform `onnxruntime-node` publishes no build for has no local embedder** (the macOS x64
standalone binary, and the `.mcpb` bundle on an OS outside the four it carries). There, an explicit
hosted or self-hosted `embeddings.provider` (see [Hosted and self-hosted
providers](#hosted-and-self-hosted-providers) above) is needed for semantic search to work.

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

If your config has no `embeddings.provider` set at all, the schema's own default resolves to the
in-process embedder (`provider: "local"`, model `nomic-embed-text-v1.5`). **obsidian-tc 1.31.4 and
1.31.5 applied that default unconditionally**, so an existing install that had never configured
`embeddings` was silently switched away from whatever it was already using (for most installs,
Ollama) and fully re-embedded in-process on the next boot — see
[GH #995](https://github.com/The-40-Thieves/obsidian-tc/issues/995).

**1.31.6 and later keep an existing index's provider instead.** When `embeddings.provider` is
unset and your vault's cache already holds active vectors from a different provider than the
current default, the server keeps using that provider/model rather than switching — no re-embed,
no config change required. This is controlled by `embeddings.onProviderChange` (default `"keep"`):

- `"keep"` (default): an unconfigured install keeps its existing index's provider. A fresh install
  (nothing indexed yet) still takes the current default — there is nothing to keep.
- `"switch"`: adopts the current default (`local`) outright, same as a fresh install — this
  re-embeds the whole vault once.

Setting `embeddings.provider` explicitly — including `provider: "local"` itself — always wins over
`onProviderChange` and is itself the opt-in to switch; that also re-embeds the whole vault once
(the server detects the stored-vs-configured mismatch automatically, the same way any other
provider/model change does — see [Changing providers or models on a live
index](#changing-providers-or-models-on-a-live-index) above).

`obsidian-tc doctor`, the boot log, and `obsidian-tc config show`/`config explain` all report which
of these ways the effective provider was decided — `configured` (you set it), `kept-from-index`
(kept from your existing vault, GH #995), `default` (nothing configured, nothing to keep), or
`ambiguous-orphaned-index` (see below) — so you can always tell which one applied. To keep using
Ollama explicitly rather than relying on `"keep"`, add `"embeddings": { "provider": "ollama" }` to
your config — the implicit model (`nomic-embed-text`) is preserved for that one case; see
[`ollama` (deprecated, still supported)](#ollama-deprecated-still-supported) above.

**`obsidian-tc config show` never lets a kept value masquerade as something you configured.** Its
plain `embeddings` block always shows the SCHEMA-resolved value (what your config file/env/profile
actually produce) — never a value merely kept from your existing index — and a separate
`embeddingsEffective` field reports the effective provider/model/dimensions plus `source` and an
explicit note when it differs from what you wrote. Do not copy `embeddingsEffective` back into
`embeddings.provider` unless you actually intend to pin it — writing `embeddings.provider`
explicitly (even to the same value it was already using) IS the opt-in to switch, disables `"keep"`
on the next boot, and re-embeds if the value differs from what was actually stored.
`obsidian-tc config explain` likewise adds an `embeddings.effective` row <!-- config-path:ignore -->
(source `derived`, since it comes from reading `cacheDir`, not your config file — a synthetic
output row, not a real config path) alongside its normal per-key attribution.

**Every command that can construct an embedding provider honors this, not just `serve`** — never
silently, not even for a command reached indirectly. `index`, `prefetch`, `gaps`,
`citation-infer`, `cluster`, `rerun`, and `doctor` each resolve `onProviderChange` against their own
cache db before constructing an embedding provider — a query command (or a replayed session) run
against an unconfigured install never silently embeds under a different provider than the one its
vectors were written with. This resolution runs at the ONE construction choke point every one of
these commands goes through (directly, or transitively through `serve`'s own runtime construction),
so a new command that constructs a provider is covered by the same rule without having to remember
to call it — never-silently-switch is the rule, not a per-command opt-in.

**The kept identity carries the stored vector width and model revision, not an assumed historical
one.** A pre-1.31.4 config could set `model`/`dimensions` explicitly (e.g. a 1024-dim
`mxbai-embed-large`) without ever setting `provider`; keeping now honors the width actually written
to `chunk_embeddings` rather than a fixed 768. Likewise, if the stored `chunk_embeddings.model` value
carries a revision suffix (`provider:model@revision`), the kept config carries that same
`embeddings.revision` rather than dropping or doubling it.

**Renaming a vault's `id` no longer orphans its index.** obsidian-tc records each vault's canonical
root path in `cache.db` the first time it sees it. At boot, if a configured vault's root path
matches a path already recorded under a *different* id, every vault-scoped row (chunks, embeddings,
notes, links, sessions — every table keyed on `vault_id`, across both `cache.db` and the
experiential store) is re-keyed from the old id to the new one automatically, in one pass, before
anything else reads them — no re-embed, no manual `cacheDir`/`id` juggling. A boot notice ("vault
identity: vault "old-id" was renamed to "new-id" … re-keyed") confirms it happened. Two vaults
resolving to the **same** id but **different** root paths — including two vaults both left at the
zero-config default id `"main"` — are refused at boot instead, with an error naming both paths: give
each vault a distinct `id` (and, if they still share a `cacheDir`, a distinct `cacheDir` too).

**Ambiguous vault identity — the residual case.** Because renames are now resolved automatically
(above), `onProviderChange: "keep"`'s `ambiguous-orphaned-index` source is now rare: it only fires
when the cache db (`cacheDir`) holds active vectors under a vault id that matches no CURRENTLY
configured vault id *and* has no recorded root path either — e.g. a vault entry removed from config
outright, or a pre-upgrade cache db whose identity has not been recorded yet. In that case
obsidian-tc still refuses to guess: it **keeps the orphaned rows' provider/model/width** rather than
silently adopting this vault's own default identity over them, and reports the source as
`ambiguous-orphaned-index` (never `default` or `kept-from-index`) with a notice naming the
situation, both in `obsidian-tc doctor` and the boot log. If every orphaned row already belongs to
the current default's own provider family (nothing to keep), this falls back to the current default
and says so in the same notice. Either way: re-add the vault to config (or run `obsidian-tc doctor`
to inspect the cache directory's stored providers), or set `embeddings.provider` explicitly (or
`embeddings.onProviderChange: "switch"`) to make the choice yourself instead of relying on `"keep"`.

**An unmappable stored provider fails closed, before any vector-index rebuild.** The active
`chunk_embeddings.model` id obsidian-tc would otherwise keep must be reconstructable back into a
real provider config (`provider:model`, or `provider:model@revision`, for `ollama`, `openai`,
`voyage`, `cohere`, and `bge-m3`). A stored id outside that set — a custom `openai-compatible:...`
or `module:...` identity, or anything else obsidian-tc cannot rebuild on its own — is refused rather
than guessed: obsidian-tc exits with a config error naming the unmappable stored id and telling you
exactly what to set instead — `embeddings.provider` (plus `embeddings.model` / `embeddings.dimensions`
if needed) to match whatever that id was actually embedded with. Run `obsidian-tc doctor` first if
you are not sure which model/width that is. Guessing here would rebuild `vec_chunks` at the wrong
width and silently drop every real vector — refusing is the smaller-safe-option.

**Config files must set `cacheDir` when the embeddings provider is `local` (the default)** — the
bare `obsidian-tc <vault>` form (no config file) sets it for you, so this only affects a config
file that never named `cacheDir`. The old `.obsidian-tc`-under-the-working-directory default is
gone because it wrote model weights wherever the server happened to be started; config load now
fails at startup, naming `cacheDir`, rather than that surprising at first embed instead.

## Pacing the background re-embed against interactive use

After an upgrade that re-embeds a whole vault (see above), the leader's boot/promotion/periodic
reconcile used to run that embed pass at full speed the instant it started — competing with
whatever tool calls the client was already making for the CPU-bound in-process embed step (the
`local` provider's ONNX runtime occupies the JS thread for the whole duration of a call).
`indexing.backgroundEmbed` paces every one of those passes instead — boot, promotion catch-up, and
the periodic scheduled `vault-reconcile` job (`maintenance.reconcileIntervalMinutes`) all share it,
since a periodic repair pass is background work too:

```json
{
  "indexing": {
    "backgroundEmbed": { "mode": "idle", "idleMs": 2000, "maxDeferMs": 30000 }
  }
}
```

- `"idle"` (default): before each embed sub-batch, the reconcile waits until the server has had no
  dispatch activity — no tool call in flight, and none finished more recently than `idleMs`
  (default 2000) — before issuing the next provider call. A quiet server (nothing else calling in)
  pays nothing: the wait only ever engages while there is real contention to defer to.
- `"immediate"`: runs the embed pass at full speed with no pacing at all — the behavior before this
  key existed.
- `maxDeferMs` (default 30000): a floor under the deferral above. Ordinary polling traffic faster
  than `idleMs` (or a handler that stops observing its own abort signal) would otherwise defer a
  sub-batch forever, since every dispatch resets the quiet window. Past `maxDeferMs` of continuous
  deferral, the next sub-batch is admitted as soon as no call is currently in flight — not waiting
  for a full quiet window — and if no call ever clears at all, a second cap at 2x `maxDeferMs`
  admits it unconditionally.

**Explicit `index_vault` calls and index-on-write (a note saved through the client) are never
paced, regardless of this setting** — those are calls the user asked for directly, not a background
catch-up pass, and pacing them would make an intentional reindex feel slower for no benefit.
The `obsidian_tc_background_embed_paused` Prometheus gauge (see
[Observability](/observability/prometheus/)) reports whether a background embed pass is currently
paused for idle (1) or actively running / not reconciling at all (0).
