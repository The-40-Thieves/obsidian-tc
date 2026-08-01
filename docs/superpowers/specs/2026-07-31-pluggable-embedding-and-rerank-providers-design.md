# Pluggable embedding and rerank providers

**Date:** 2026-07-31
**Status:** design approved, not yet implemented
**Scope:** `packages/shared/src/config`, `packages/server/src/embeddings`, `packages/server/src/providers` (new), `packages/server/src/runtime/tool-wiring.ts`

## Goal

Make the embedding model and the reranker two **drop-in slots**: any model reachable over a
standard HTTP shape can be named in `config.json` and used, with no code change and no release.
An escape hatch covers wire formats no standard shape describes.

This is explicitly **not** a unification of obsidian-tc's LLM call sites. The generative roles
(`extract` / `synthesize` / `judge`) keep their existing gateway seam and are out of scope.

## Why the two slots are broken in opposite ways

**Embeddings — rich config, closed door.** `EmbeddingProvider`
(`packages/server/src/embeddings/provider.ts`) is already a clean interface: `id`, `provider`,
`model`, `dimensions`, `embed()`, and an optional `embedFull()` for multi-vector providers. But
`EmbeddingsConfigSchema.provider` is a closed enum —
`ollama | openai | voyage | cohere | bge-m3 | model-tier`. Adding a seventh model means editing
the shared Zod schema, hand-writing an adapter in `providers.ts`, and adding a row to the
hardcoded `ENV_KEY` map in `provider.ts` (which knows only `openai`, `voyage`, `cohere`).

**Reranker — open door, no handle.** `Reranker` (`packages/server/src/search/rerank.ts`) is a
bare function type, `(query, documents, topN) => Promise<RerankHit[]>`. Genuinely pluggable. But
there is **no way to select a backend**. To be precise (an earlier draft said "no config surface at
all", which a cross-vendor audit correctly refuted): rerank *behaviour* flags do exist —
`retrieval.gatedRerank` and `retrieval.colbert` (`retrieval.schema.ts:41-60`) and
`experiential.activationRerank` (`:286-300`). What has never existed is a **provider descriptor**:
a way to say *which* backend answers. The wiring is hardcoded at
`packages/server/src/runtime/tool-wiring.ts:146`:

```ts
const reranker: Reranker | null = buildModelTierReranker(embeddings) ?? gatewayReranker;
```

Two hardcoded sources, fixed precedence, and the gateway is discovered only from
`OBSIDIAN_TC_GATEWAY_URL` / `OBSIDIAN_TC_GATEWAY_TOKEN` environment variables, never from
`config.json`. An operator cannot declare a reranker today.

These are mirror images of the same mistake. Embeddings put the extension point in a **type**:
cheap to validate, impossible to extend without a release. The reranker put it in a **function**:
trivially extensible, but with no way to name one from outside, so it is unreachable.

## Two findings that shrink the work

1. **The server-side factory is already open.** `createEmbeddingProvider(cfg)`
   (`embeddings/index.ts:58`) takes `cfg.provider` as a plain `string` and switches on it. The
   closed enum exists **only** in the shared Zod schema. The `switch` at `embeddings/index.ts:73`
   is already a registry written the long way.
2. **The generic HTTP embedder already exists.** `openAiStyle(provider, defaultBase)`
   (`providers.ts:44`) is a factory-of-factories; `openaiProvider` and `voyageProvider` are both
   partial applications of it. The "any web address" adapter is that helper with no baked-in
   default base.

## Decisions taken

| Decision | Choice |
|---|---|
| Drop-in contract | **Both**: declarative HTTP shapes as the main road, plus a module escape hatch |
| Escape-hatch trust | Gated on the existing `securityProfile`; refused under `hardened` |
| Reranker breadth | Rerank-API shapes only (Cohere-compatible, TEI). No LLM-as-reranker adapter |
| Registry shape | Per-slot maps (embeddings, reranker) sharing one resolver and one error contract |
| Back-compat | Zero migration. Every existing config must keep working byte-for-byte |
| Multi-vector | Generic drop-ins are dense-only. `embedFull()` stays with `bge-m3` / `model-tier` |

**Rejected — discriminated union on a `kind` tag.** Cleanest validation, but no existing config
carries a `kind`, so it needs a permanent back-compat shim and leaves two config shapes forever.

**Rejected — mandate a gateway and delete the adapters.** Simplest possible design ("any model" by
delegation to LiteLLM), but it forces every solo Obsidian user to stand up a gateway before they
can index a vault, and deletes the zero-infrastructure direct-to-Ollama path.

## Architecture

One registry module, `packages/server/src/providers/registry.ts`, holding a name → factory map and
a single `resolve()` used by **both** slots. That shared resolver is where the symmetry comes from.

```
config.embeddings.provider ─┐
                            ├─▶ resolve(name, descriptor, slot) ─▶ registry ─▶ adapter
config.reranker.provider  ──┘         │
                                      └─ miss ─▶ throw at BOOT, listing every registered name
```

**The registry is per-slot.** One module, two maps — an embeddings map and a reranker map — sharing
one `resolve()` and one set of error semantics. A name is only meaningful within its slot, so an
unknown-name error lists the names registered for *that* slot, and `tei` can appear in both maps
with a different factory in each (TEI serves embeddings and rerank on separate endpoints).

| slot | entries | role |
|---|---|---|
| embeddings | `ollama`, `openai`, `voyage`, `cohere`, `bge-m3`, `model-tier` | today's six, moved from the `switch` verbatim — behaviour unchanged |
| embeddings | `openai-compatible`, `tei` | the generic "any web address" embedders |
| embeddings | `module` | reads `modulePath`, profile-gated |
| reranker | `model-tier`, `gateway` | the two sources hardcoded at `tool-wiring.ts:146` today, now nameable |
| reranker | `cohere-compatible`, `tei` | the generic "any web address" rerankers |
| reranker | `module` | reads `modulePath`, profile-gated |

A registry entry receives a validated descriptor and returns an `EmbeddingProvider` or a
`Reranker`. It never receives the whole `ServerConfig`, so an adapter cannot reach into unrelated
configuration, and each is testable by calling its factory with a literal descriptor and a stub
`fetchFn` — the seam `embeddings/http.ts` and `embeddings/fake.ts` already use.

### Prior-art check

Two independent conventions corroborate the shape, which is worth recording because the per-slot
split was a judgement call:

- **Vercel AI SDK's `createProviderRegistry`** exposes *separate accessors per model type*
  (`languageModel`, `embeddingModel`, `imageModel`) rather than one namespace, and addresses models
  as `providerId:modelId`. That is the per-slot registry, and the id format obsidian-tc already
  emits (`ollama:bge-m3`).
- **LangChain's `Embeddings`** interface splits `embed_documents` from `embed_query` — the same
  asymmetric-encoding distinction obsidian-tc carries as `EmbedOptions.input: "query" | "document"`
  (THE-308). The existing interface is already the standard shape; nothing about it needs changing.

### Changes

1. **`EmbeddingsConfigSchema.provider`: `z.enum([...])` → `z.string()`.** The enum's six values
   survive as registry keys, so `"provider": "ollama"` resolves identically and nothing migrates.
2. **New `RerankerConfigSchema`**, structurally the same descriptor, mounted as an optional
   top-level `reranker` block. Absent → `null` → today's exact graceful no-op.
3. **`tool-wiring.ts:146` becomes a registry resolve.** When `reranker` is absent the old
   `buildModelTierReranker(embeddings) ?? gatewayReranker` precedence is preserved verbatim as the
   fallback, so existing deployments see no behavioural change.

Not touched: `EmbeddingProvider`, `Reranker`, `GatewayClient`, `graph_search.ts`, or any call site.

## Config shapes

```jsonc
// generic embedder — any OpenAI-shaped endpoint
"embeddings": {
  "provider": "openai-compatible",
  "baseUrl": "http://gateway:4001/v1",
  "model": "BAAI/bge-m3",
  "dimensions": 1024,
  "apiKeyEnv": "LITELLM_AGENT_KEY"
}

// generic reranker — any Cohere-shaped /rerank endpoint
"reranker": {
  "provider": "cohere-compatible",
  "baseUrl": "http://gateway:4001",
  "model": "rerank-v3.5"
}

// escape hatch — trusted-local only
"embeddings": { "provider": "module", "modulePath": "./my-provider.ts", "dimensions": 768 }
```

### `baseUrl` has no single convention today — each entry must declare its own

This was an assumption worth checking, and it was wrong. The existing adapters disagree:

| adapter | `baseUrl` means | path appended |
|---|---|---|
| `openAiStyle` (openai, voyage) | includes the version segment (`https://api.openai.com/v1`) | `/embeddings` |
| `cohere` | includes the version segment (`https://api.cohere.com/v2`) | `/embed` |
| `ollama` | server root (`http://127.0.0.1:11434`) | `/api/embed` |
| `model/tei.ts` | server root | `/v1/embeddings` |
| `model/bge.ts` | server root | `/v1/encode` |

So "set `baseUrl`" means two different things depending on which name you picked. For a slot whose
whole purpose is dropping in an arbitrary endpoint, that ambiguity is the most likely cause of a
confusing first-run failure — `/v1/v1/embeddings` from a base that already carried `/v1`.

**Requirement.** Every registry entry declares its appended path as part of its registration, the
generated config schema documents it per-entry, and the resolver rejects at boot a `baseUrl` whose
trailing segment would duplicate the path the entry appends. Normalising by silently stripping a
duplicate is wrong — it hides an operator's misunderstanding of which convention they are on.

### New field: `apiKeyEnv`

`resolveApiKey()` consults a hardcoded map that knows only `openai`, `voyage`, `cohere` — a second
closed door, since a generic provider has no way to name its environment variable. A descriptor may
set `apiKeyEnv` to the variable to read. Precedence, unchanged at the top: inline `apiKey` wins,
then `apiKeyEnv`, then the built-in map for the six named providers.

### Manifest passthrough: `revision`, `pooling`

`RepresentationManifest` (`packages/server/src/search/representation.ts:88`) records `revision` and
`pooling` as `Knowable<string>` — and today they are `unknown` for every adapter except TEI and
`model-tier`, because no other adapter can express them. Both become optional descriptor fields:
declared → recorded, omitted → still `unknown` (distinct from `""`, which means "asked, and the
real value is empty").

**Correction (verified 2026-07-31): the manifest is not the live mechanism.** An earlier draft of
this section said these fields "feed `vec_index_fingerprint`". Checking the tree shows otherwise,
and the difference changes the work:

- `RepresentationManifest` has **no production producer**. Only `test/search-representation-manifest.test.ts`
  constructs one. It is a type awaiting wiring.
- The live mechanism is `VecFingerprint` (`representation.ts:32`). It already carries an optional
  `revision`, and `vecFingerprint()` already folds it in as `f.revision ?? ""`.
- **No production site passes one.** Both construction sites —
  `runtime/indexing-wiring.ts:107-115` and `search/indexing/index-vault.ts:76-84` — omit it, so
  `revision` is permanently `""`.

So `revision` becomes a `VecFingerprint` field threaded through **both** sites; `pooling` is
descriptive provenance only until the manifest gains a producer, and the schema says so. Wiring
`RepresentationManifest` is out of scope.

That threading is load-bearing: it is what makes a **model checkpoint upgrade** at the same model
name and width rebuild the index rather than silently serving vectors produced by the old
checkpoint against queries embedded by the new one. And the two sites must fold it identically —
if they diverge, boot and `index_vault` each DROP and rebuild the table the other just built, an
unbounded rebuild loop that presents as a busy, healthy server.

`Knowable<T>` is `T | "unknown"` — a bare string union, not an object.

### The wire shapes

Both generic adapters target formats already implemented in this repo, so neither invents a
contract:

- **`openai-compatible`** — `POST {baseUrl}/embeddings` with `{model, input}`, response
  `{data: [{embedding}]}`. This is `openAiStyle` with no default base (so `baseUrl` is required).
- **`cohere-compatible`** — `POST {baseUrl}/rerank` with `{model, query, documents, top_n?}`,
  response `{model?, results?: [{index, relevance_score}]}`. This is exactly the shape
  `gateway/client.ts:236` already speaks. LiteLLM follows the Cohere rerank format for *all* rerank
  providers, and Jina, Voyage, TogetherAI and Infinity all speak it — which is why this one shape
  is enough.
- **`tei`** — the existing `model/tei.ts` client, exposed under its own registry name. Note it
  appends `/v1/embeddings` to a bare root, *not* `/embeddings` to a versioned base.

**Cohere rerank is versioned and the dialects differ.** V2 replaced `max_chunks_per_doc` with
`max_tokens_per_doc` (token-based, default 4096). Since the adapter appends only `/rerank`, the
dialect is decided entirely by whether the operator's `baseUrl` ends in `/v1` or `/v2` — which
makes the `baseUrl` requirement above load-bearing here, not merely tidy. Neither truncation
parameter is sent by default (see the invariants below); `top_n` is the only optional field, and it
exists in both dialects.

## Wire-protocol invariants

Verified 2026-07-31. These are the difference between "it works against my gateway" and "it works
against any endpoint", and each is backed by a real published failure.

**Send the minimal common request body. Every dialect-specific parameter is opt-in and off by
default.** Three independent incidents share one shape — a parameter that is correct in one dialect
and a hard 400 in another:

| parameter | failure |
|---|---|
| `dimensions` | Passing it to a non-Matryoshka OpenAI-compatible backend returns 400. Clients that always send it break every such backend (mem0 #4153). |
| `encoding_format` | The OpenAI SDK defaults to `base64`, which proxies may not support; a later fix sent `encoding_format=None`, which vLLM rejects outright — LiteLLM published an incident report for it. |
| `max_tokens_per_doc` / `max_chunks_per_doc` | Cohere rerank v2 vs v1. Sending either to the wrong dialect is rejected. |

**obsidian-tc is already immune to all three, and that must be preserved deliberately.**
`openAiStyle` sends `{model, input}` and nothing else; `dimensions` appears in `providers.ts` only
as a field on the *returned provider object*, never in a request body; `encoding_format` appears
nowhere in the tree. Width is enforced client-side by `assertVectors`, with optional Matryoshka
truncation via `truncate` — which is strictly better than asking the server to truncate, because it
works against servers that cannot.

This is currently an accident of how the adapters were written. Generalising `openAiStyle` into a
public `openai-compatible` entry is exactly the moment someone "improves" it by adding
`encoding_format: "float"` or reaching for the official SDK. So it becomes an explicit invariant
with a test asserting the outgoing body has exactly the expected keys — not a comment.

**The invariant binds the generic entries, not the named ones.** A named entry targets exactly one
vendor and must send whatever that vendor requires: `cohere` already sends
`{model, texts, input_type, embedding_types}` because Cohere v2 mandates `input_type`, and it
should. That difference is the reason `openai-compatible` must be a **separate entry** rather than
`openai` with the default base removed — a named entry is free to grow vendor-specific fields over
time, and the generic entry must be provably unable to. Registering them as aliases of one factory
would let a future vendor requirement leak into every self-hosted backend.

**Corollary: no provider SDKs in the tree.** Already the standing rule for the gateway
(`gateway/client.ts:46`). The `encoding_format` incident is the general case: an SDK's defaults are
tuned for its own first-party endpoint and are a liability against a compatible one.

**No emerging standard supersedes these two shapes.** The 2026 landscape search surfaced no
interoperability spec beyond the de-facto OpenAI-compatible embeddings and Cohere-format rerank
APIs; the movement is in models (Qwen3 multi-task embedding+rerank, BGE-M3, voyage-3) rather than
protocols. Choosing these two shapes is choosing the current answer, not a legacy one.

## The module gate

`provider: "module"` reads `modulePath`. Resolution order:

1. If `securityProfile` is `hardened` → **throw at boot**, naming the offending key and the active
   profile. Never a warning, never a silent skip.
2. Resolve `modulePath` relative to **the config file's directory**, not `process.cwd()`. The
   config directory is the trust root; CWD in a container is arbitrary.
3. Import it and require a named export for the slot — `createEmbeddingProvider` or
   `createReranker`. Validate the returned object structurally (`embed` is a function,
   `dimensions` is a positive integer) **before** handing it to anything.

Step 3 matters: an adapter returning a malformed object today surfaces as a confusing failure deep
inside the indexer. Validating at the boundary turns it into one clear boot error.

Rationale for gating on `securityProfile` rather than a dedicated flag: `config.json` already holds
vault paths, API keys and the JWT secret, so whoever can write it already owns the process — and a
second trust axis can disagree with the profile, with no obvious right answer when it does.

## Error handling

Every failure in this path is a **boot-time throw**. Nothing here may degrade into a
working-looking server with a dead helper.

| condition | behaviour |
|---|---|
| unknown provider name | throw, message lists **every** registered name for that slot |
| `module` under `hardened` | throw, naming the key and the profile |
| `modulePath` missing / unimportable | throw |
| module export missing or malformed | throw |
| generic adapter without required `baseUrl` | throw |
| `reranker` block absent | **not** an error — resolves `null`, today's graceful no-op |

`createEmbeddingProvider` is called from `runtime/indexing-wiring.ts:99`, which is boot wiring, so
the existing unknown-provider throw already fires at startup. That property must be preserved, and
matched for the reranker.

Validation follows the house idiom in `server.schema.ts:132` — `.superRefine()` with
`ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...], message })` and a long, actionable
message naming the fix. (Zod is 4.4.3; `z.ZodIssueCode.custom` is still what this repo uses.)

## Testing

**Adapters.** Each generic adapter, via its factory with a literal descriptor and a stub `fetchFn`:
URL construction, auth header, response unwrapping, malformed response. No network, no containers.

**Wire-body invariant — one test per generic adapter.** Capture the outgoing request body from the
stub `fetchFn` and assert its keys **exactly**: `{model, input}` for `openai-compatible`,
`{model, query, documents}` (+ `top_n` only when set) for `cohere-compatible`. Asserting the
absence of `dimensions` and `encoding_format` is the point — an assertion that only checks the
present keys would pass while the adapter sends an extra one that 400s on half of all backends.
Also assert the constructed URL for a `baseUrl` with and without a trailing slash, and that a
`baseUrl` duplicating the entry's appended path is refused at boot.

**Registry — four properties.**

1. Every built-in name resolves to a provider whose `id` matches today's (`ollama:bge-m3`, …).
   This is the back-compat gate: the six must be indistinguishable from the current `switch`.
2. An unknown name throws **and the message contains every registered name**. Assert the listing,
   not merely that it threw.
3. An absent `reranker` block resolves to exactly today's
   `buildModelTierReranker(embeddings) ?? gatewayReranker` fallback.
4. A declared `revision` changes the `vec_index_fingerprint` value, **and both construction sites
   fold it identically**. `packages/server/bun-smoke/vec-model-swap.test.ts` already exercises
   fingerprint-driven invalidation and is the natural place to extend. Absent revision must be
   byte-identical to today's fingerprint, so no existing index rebuilds merely on upgrade.

**Why property 4 is the highest-risk item in this spec.** That smoke test exists because of the
THE-460 defect: a **same-dimension** model swap was detected by the fingerprint and triggered a
rebuild, but the backfill then selected `WHERE is_active = 1 AND length(embedding) = dims*4` with
no model predicate — so it re-selected the *old* model's vectors while the stored fingerprint
claimed the new one. Retrieval then scored new-model queries against old-model embeddings.

Making providers drop-in turns a same-dimension swap from a rare event into a routine one: pointing
`baseUrl` at a different gateway alias of the same width is now a one-line config edit. Every test
in property 4 must therefore assert on the *stored model attribution*, not only on the fingerprint
changing — the fingerprint was already correct in THE-460 and the data was still wrong.

**Module gate — three refusals**, each asserting a boot-time throw: `hardened` refuses any
`modulePath`; a module exporting nothing usable is refused; a module exporting a malformed provider
is refused before first use.

### Gate note: `check:config-threading` cannot cover this change

That gate fails the build when a config key is declared in the schema but read nowhere — the
`knnMinSim` shape. It is deliberately conservative and **exempts generic identifiers**; its own
comment names `model` and `enabled` as names that will always match something.

Nearly every key added here is generic (`provider`, `model`, `baseUrl`), so a declared-and-never-read
`reranker.model` would pass it silently. The distinctive names (`apiKeyEnv`, `modulePath`,
`revision`, `pooling`) would be caught; the generic ones would not. **Each new key therefore needs
an explicit test proving it reaches a consumer.** Per repo convention, every new gate and test is
watched failing before it is trusted.

### Gates this change trips

- `bun run config:schema` — the generated `docs/obsidian-tc.config.schema.json` must be
  regenerated; a `PreToolUse` hook blocks hand-editing it and `config:schema:check` fails CI on drift.
- `check:config-paths`, `check:config-threading` (with the caveat above).
- `docgen:render -- --check` for any marker region covering config.
- CI runs via `gh workflow run ci-server.yml --ref <branch>` — three OSes, free for a public repo.
  This box is 4 cores under ~43 containers; only targeted vitest runs locally.

## Out of scope

- Unifying the generative call sites (`extract` / `synthesize` / `judge`).
- An LLM-as-reranker adapter (prompt template, output parsing, batching). The module hatch lets
  someone prototype one without waiting for it.
- A multi-vector (`embedFull`) wire contract for arbitrary models. ColBERT rerank is off by
  default and eval recalibration placed reranking in "settled-dead", so this would be speculative.
- Runtime/hot swapping of a provider. Resolution stays at boot.

## Build sequence

1. `providers/registry.ts` with the six existing names moved from the `switch`; prove
   back-compat property 1 before anything else changes.
2. Open `EmbeddingsConfigSchema.provider` to `z.string()`; wire the boot-time unknown-name throw
   with the full name listing.
3. Add the generic adapters (`openai-compatible`, `cohere-compatible`, `tei`) and `apiKeyEnv`.
   Land the wire-body invariant tests **with** the adapters, not after — they are the only thing
   standing between "works against my gateway" and "works against any endpoint". Declare each
   entry's appended path and enforce the duplicate-segment refusal here too.
4. Add `RerankerConfigSchema` and switch `tool-wiring.ts:146` to resolve, preserving the fallback.
5. Add manifest passthrough (`revision`, `pooling`) and the fingerprint test.
6. Add the `module` entry and its three refusals last — it is the only step with a security
   posture, and it should land on top of a registry already proven correct.
