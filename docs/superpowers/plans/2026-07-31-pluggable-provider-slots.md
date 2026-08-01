# Pluggable Embedding and Rerank Provider Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedding model and the reranker drop-in slots, so any model behind a standard HTTP shape can be named in `config.json` with no code change, plus a security-gated module escape hatch.

**Architecture:** A per-slot provider registry (`packages/server/src/providers/`) replaces the `switch` in `embeddings/index.ts`. Two name→entry maps — one for embeddings, one for reranking — share one resolver, one error contract, and one `baseUrl` validation rule. The six existing embedding provider names become registry entries, so every existing config resolves identically and nothing migrates. `EmbeddingsConfigSchema.provider` opens from a Zod enum to `z.string()`; a new optional `reranker` block gives the reranker slot the provider-selection surface it has never had.

**Tech Stack:** Bun 1.3.14 · TypeScript 7.0.2 · Zod 4.4.3 · Vitest 4.1.10 · Biome 2.5.5

> **Revision note (2026-07-31).** This plan was rewritten after a cross-vendor audit (Codex) checked
> it against the tree and found ~15 defects and 8 coverage gaps in the first draft — wrong appended
> paths, a truncated edit range, a type that lives in another file, a broken docgen test, three stale
> doc files, a permanently-dead `model-tier` reranker entry, and a module hatch with no config field.
> Six were independently re-verified before rewriting. Where the first draft was wrong, the correct
> value is stated inline with its evidence so the same mistake is not re-derived.

## Global Constraints

- **Zero config migration.** Every config valid before this change must produce a byte-identical provider afterwards. `"provider": "ollama"` keeps working untouched.
- **Boot-time failure only.** Every misconfiguration throws during wiring, never lazily at first embed/query.
- **Wire-body invariant (generic entries only).** `openai-compatible` sends exactly `{model, input}`. `cohere-compatible` sends exactly `{model, query, documents}` plus `top_n` only when set. Never `dimensions`, `encoding_format`, `max_tokens_per_doc`, or `max_chunks_per_doc`. Named entries are exempt — `cohere` legitimately sends `input_type` because Cohere v2 mandates it.
- **No provider SDKs in the tree.** Raw `postJson` only (standing rule at `gateway/client.ts:46`).
- **Zod 4 currency — new code takes the modern form.** Verified against the installed 4.4.3, which **is** npm `latest`: `z.string().url()` is deprecated → use **`z.url()`**; `z.ZodIssueCode` is deprecated → use `{ code: "custom", ... }`. The repo's 2 existing `z.string().url()` and 4 `z.ZodIssueCode` sites stay; migrating them is a separate task.
- **Every `expect(...).rejects` MUST be awaited.** In Vitest 4 matchers after `.rejects` return a Promise; an un-awaited assertion lets the test finish before the promise settles and **passes even when the code is wrong**. Task 8 guards a security boundary with these. After writing it, invert each guard and watch the test fail.
- **Never pipe a gate through `tail`/`head`** — `$?` reports the pipe. Redirect to a log; check `$?` separately.
- **Do not run the full suite locally.** 4 cores under ~43 containers. Targeted vitest via `bun run test:local <file>`; full CI via `gh workflow run ci-server.yml --ref <branch>`.
- **Every commit is signed off** (`git commit -s`; the `prepare-commit-msg` hook does it automatically).
- **Generated artifacts are hook-blocked.** After a schema change run `bun run config:schema` AND `bun run docgen:render` — see Task 7, which exists because the first draft forgot the docs.

## Design decisions this revision had to make

1. **Module providers are boot-path only.** `createEmbeddingProvider` is synchronous and is called
   directly by four CLI/eval paths (`cli/commands/citation-infer.ts:32`, `cli/commands/prefetch.ts:17`,
   `cli/commands/gaps.ts:33`, `eval/run.ts:547`). `loadProviderModule` is `async`. Rather than make
   every caller async, the sync path **refuses** `provider: "module"` with an error naming the
   limitation. Only the two boot wiring sites get the async resolver. This is a documented boundary,
   not a silent gap.
2. **The `model-tier` reranker reads the EMBEDDINGS config, not the reranker descriptor.**
   `buildModelTierReranker` takes `ModelTierConfigLike`, which requires `dimensions: number` and
   `modelTier` (`model/factory.ts:87-94`) — fields a reranker descriptor does not and should not
   carry. It is passed through `ResolveContext.embeddings` instead. The first draft used a double
   cast, which compiled and returned `null` forever.
3. **`RerankerEntry.build` is async.** The reranker slot needs the module hatch too, so both slots
   get an async resolver and the sync convenience wrapper exists only for embeddings.

---

## File Structure

**Create:**

| file | responsibility |
|---|---|
| `packages/server/src/providers/types.ts` | Descriptor + entry interfaces shared by both slots. No logic. |
| `packages/server/src/providers/registry.ts` | Both name→entry maps, sync + async resolvers, name listing, `baseUrl` duplicate-segment refusal. |
| `packages/server/src/providers/http-embeddings.ts` | The `openai-compatible` generic embedder. |
| `packages/server/src/providers/http-rerank.ts` | The `cohere-compatible` generic reranker. |
| `packages/server/src/providers/module-loader.ts` | The profile-gated `module` escape hatch for both slots. |
| `packages/shared/src/config/reranker.schema.ts` | `RerankerConfigSchema`. Leaf schema — imports Zod only. |

**Modify:**

| file | change | task |
|---|---|---|
| `packages/shared/src/config/indexing-embeddings.schema.ts:11-16` | `provider` enum → `z.string()`; add `apiKeyEnv`, `modulePath`, `revision`, `pooling` | 2,4,6,8 |
| `packages/shared/src/config/server.schema.ts` | Mount the optional `reranker` block | 5 |
| `packages/shared/src/config.schema.ts` | Re-export `RerankerConfigSchema`/`RerankerConfig` — **every** other config leaf is re-exported through this facade | 5 |
| `packages/server/src/embeddings/index.ts:58-97` | `switch` → registry delegation. **Range is 58-97, not 58-90**: the switch body ends at 92 and the factory continues to 97 | 1 |
| `packages/server/src/embeddings/provider.ts` | `resolveApiKey` honours `apiKeyEnv` | 4 |
| `packages/server/src/embeddings/http.ts:16` | Hint names `embeddings.api_key`; the real field is `apiKey` | 4 |
| `packages/server/src/runtime/tool-wiring.ts:132-146` | Reranker precedence → registry resolve | 5 |
| `packages/server/src/runtime/server-runtime.ts:379` | The **only** `wireGatewaySeams` caller — it is in this file, not in `tool-wiring.ts` | 5,8 |
| `packages/server/src/search/indexing/types.ts:128` | `IndexVaultArgs` gains `revision?: string`. **`IndexVaultArgs` is declared here, not in `index-vault.ts`** | 6 |
| `packages/server/src/runtime/indexing-wiring.ts:107-115` | VecFingerprint literal gains `revision` | 6 |
| `packages/server/src/search/indexing/index-vault.ts:76-84` | VecFingerprint literal gains `revision` | 6 |
| `packages/server/src/cli/commands/doctor.ts:68-80` | `multiVector` + reranker readiness stop assuming the closed provider set | 7 |
| `docs/wiki/Configuration.md`, `docs/src/content/docs/configuration/config-reference.md` | Regenerated — they enumerate the closed enum | 7 |
| `packages/server/test/docgen-config.test.ts:25` | Asserts `embeddings.provider` renders as `enum(ollama|...)`; opening it breaks this | 7 |

**NOT modified:** `packages/server/src/search/representation.ts`. The first draft listed it; Task 6
does not touch it (see Task 6's preamble).

---

### Task 1: Provider registry with the six existing embedders

Moves the `switch` into a registry with **no behaviour change**. Its only job is proving the move is invisible.

**Files:**
- Create: `packages/server/src/providers/types.ts`, `packages/server/src/providers/registry.ts`
- Modify: `packages/server/src/embeddings/index.ts:58-97`
- Test: `packages/server/test/provider-registry-backcompat.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `EmbedOptions`, `assertVectors`, `resolveApiKey` (`../embeddings/provider`); `FetchFn` (`../embeddings/http`); `EmbeddingsConfigLike` (`../embeddings`); `buildModelTierProvider` (`../model`)
- Produces: `ProviderDescriptor`, `ResolveContext`, `EmbeddingsEntry`, `RerankerEntry` (types.ts); `resolveEmbeddings(cfg, ctx)`, `embeddingsProviderNames()` (registry.ts)

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-registry-backcompat.test.ts
// Task 1 — the switch → registry move must be INVISIBLE. All SIX names, not five: the first draft
// omitted model-tier from the metadata cases and only listed it in the name assertion.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import { embeddingsProviderNames } from "../src/providers/registry";

const CASES = [
  { provider: "ollama", model: "bge-m3", dimensions: 1024, id: "ollama:bge-m3" },
  { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, id: "openai:text-embedding-3-small" },
  { provider: "voyage", model: "voyage-3", dimensions: 1024, id: "voyage:voyage-3" },
  { provider: "cohere", model: "embed-v4.0", dimensions: 1024, id: "cohere:embed-v4.0" },
  { provider: "bge-m3", model: "BAAI/bge-m3", dimensions: 1024, id: "bge-m3:BAAI/bge-m3" },
];

describe("provider registry back-compat", () => {
  for (const c of CASES) {
    it(`${c.provider} resolves with an unchanged id`, () => {
      const p = createEmbeddingProvider({ provider: c.provider, model: c.model, dimensions: c.dimensions });
      expect(p.id).toBe(c.id);
      expect(p.provider).toBe(c.provider);
      expect(p.model).toBe(c.model);
      expect(p.dimensions).toBe(c.dimensions);
    });
  }

  // model-tier takes a different shape (its own config sub-object) and bypasses withPrefixes,
  // so it needs its own case rather than a row in CASES.
  it("model-tier resolves and keeps its own prefixing", () => {
    const p = createEmbeddingProvider({
      provider: "model-tier",
      model: "Qwen/Qwen3-Embedding-0.6B",
      dimensions: 1024,
      modelTier: { dense: { baseUrl: "http://tei:8080" } },
    });
    expect(p.provider).toBe("model-tier");
    expect(p.dimensions).toBe(1024);
  });

  it("registers every previously-supported name", () => {
    expect(embeddingsProviderNames()).toEqual(
      ["bge-m3", "cohere", "model-tier", "ollama", "openai", "voyage"],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-registry-backcompat.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/registry'`

- [ ] **Step 3: Create the shared types**

```ts
// packages/server/src/providers/types.ts
// Descriptor and entry shapes shared by BOTH provider slots. Types only.
import type { EmbeddingsConfigLike } from "../embeddings";
import type { FetchFn } from "../embeddings/http";
import type { EmbeddingProvider } from "../embeddings/provider";
import type { Reranker } from "../search/rerank";

/** Everything a registry entry may read off a config block, for either slot. */
export interface ProviderDescriptor {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  modulePath?: string;
}

export interface ResolveContext {
  fetchFn?: FetchFn;
  /** Directory of the loaded config file — the trust root for `modulePath`. Undefined when the
   *  config was derived from a vault path rather than a file. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
  /** The EMBEDDINGS config, needed by the model-tier reranker entry: buildModelTierReranker takes
   *  ModelTierConfigLike, which requires `dimensions` and `modelTier` (model/factory.ts:87-94) —
   *  fields a reranker descriptor does not carry. Passing it as ambient context is what makes that
   *  entry work; the first draft cast the descriptor instead, which compiled and returned null. */
  embeddings?: EmbeddingsConfigLike;
}

export interface EmbeddingsEntry {
  /** The path this entry appends to `baseUrl`. Declared so the resolver can refuse a baseUrl that
   *  would duplicate it — the adapters do NOT agree on whether baseUrl carries a version segment. */
  readonly appendsPath: string;
  /** True when the entry does its own query/document prefixing and must bypass withPrefixes.
   *  Only model-tier does (Qwen instruct on the dense query, BGE bare). */
  readonly ownsPrefixing?: boolean;
  /** True when the entry can only be built asynchronously (the module hatch). The sync
   *  createEmbeddingProvider refuses these with an actionable error. */
  readonly asyncOnly?: boolean;
  build(cfg: EmbeddingsConfigLike, ctx: ResolveContext): EmbeddingProvider;
  buildAsync?(cfg: EmbeddingsConfigLike, ctx: ResolveContext): Promise<EmbeddingProvider>;
}

export interface RerankerEntry {
  readonly appendsPath: string;
  /** Null means "configured, but this backend is unavailable" — the caller falls back to the
   *  graceful no-op, exactly as buildModelTierReranker does today. Async because the module hatch
   *  needs it and both slots share one resolver contract. */
  build(cfg: ProviderDescriptor, ctx: ResolveContext): Promise<Reranker | null>;
}
```

- [ ] **Step 4: Create the registry with the six existing entries**

```ts
// packages/server/src/providers/registry.ts
// The single resolution point for both provider slots. Adding a model is adding a row to a map.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { EmbeddingsConfigLike } from "../embeddings";
import { resolveApiKey } from "../embeddings/provider";
import {
  bgeM3Provider, cohereProvider, ollamaProvider, openaiProvider, voyageProvider,
} from "../embeddings/providers";
import { buildModelTierProvider } from "../model";
import type { EmbeddingsEntry, ResolveContext } from "./types";

function adapterOpts(cfg: EmbeddingsConfigLike, ctx: ResolveContext) {
  return {
    model: cfg.model,
    dimensions: cfg.dimensions,
    baseUrl: cfg.baseUrl,
    apiKey: resolveApiKey(cfg.provider, cfg.apiKey),
    fetchFn: ctx.fetchFn,
    timeoutMs: cfg.timeoutMs,
    truncate: cfg.truncate,
  };
}

// appendsPath values are the REAL suffix each adapter appends — verified against providers.ts.
// NOTE bge-m3 appends "/embeddings" (providers.ts:117), NOT "/encode". "/v1/encode" belongs to the
// separate model/bge.ts client used by model-tier. The first draft had this wrong, which would have
// made the duplicate-segment guard silently useless for bge-m3.
const EMBEDDINGS: Record<string, EmbeddingsEntry> = {
  ollama: { appendsPath: "/api/embed", build: (c, x) => ollamaProvider(adapterOpts(c, x)) },
  openai: { appendsPath: "/embeddings", build: (c, x) => openaiProvider(adapterOpts(c, x)) },
  voyage: { appendsPath: "/embeddings", build: (c, x) => voyageProvider(adapterOpts(c, x)) },
  cohere: { appendsPath: "/embed", build: (c, x) => cohereProvider(adapterOpts(c, x)) },
  "bge-m3": { appendsPath: "/embeddings", build: (c, x) => bgeM3Provider(adapterOpts(c, x)) },
  "model-tier": {
    appendsPath: "/v1/embeddings",
    ownsPrefixing: true,
    build: (c, x) => buildModelTierProvider(c, { fetchFn: x.fetchFn }),
  },
};

/** Sorted so the unknown-name error message is stable and diffable. */
export function embeddingsProviderNames(): string[] {
  return Object.keys(EMBEDDINGS).sort();
}

/**
 * Refuse a baseUrl whose trailing segments already contain the path the entry appends.
 *
 * The adapters do NOT agree on what baseUrl means — openAiStyle appends "/embeddings" to a base
 * carrying "/v1", while model/tei.ts appends "/v1/embeddings" to a bare root. Refusing rather than
 * silently stripping is deliberate: stripping hides that the operator is on the wrong convention.
 */
export function assertBaseUrlNotDuplicating(
  baseUrl: string | undefined, appendsPath: string, slot: "embeddings" | "reranker",
): void {
  if (!baseUrl) return;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!trimmed.endsWith(appendsPath)) return;
  throw err.invalidInput(
    `${slot}.baseUrl already ends with "${appendsPath}", which this provider appends itself`,
    {
      baseUrl,
      hint: `the request URL would be "${trimmed}${appendsPath}". Set ${slot}.baseUrl to the prefix WITHOUT "${appendsPath}".`,
    },
  );
}

function embeddingsEntryOrThrow(name: string): EmbeddingsEntry {
  const entry = EMBEDDINGS[name];
  if (!entry) {
    throw err.invalidInput(`unknown embeddings provider: ${name}`, {
      provider: name,
      hint: `set embeddings.provider to one of: ${embeddingsProviderNames().join(", ")}`,
    });
  }
  return entry;
}

/** Synchronous resolution. Refuses asyncOnly entries (the module hatch) — see resolveEmbeddingsAsync. */
export function resolveEmbeddings(
  cfg: EmbeddingsConfigLike, ctx: ResolveContext = {},
): { provider: EmbeddingProvider; entry: EmbeddingsEntry } {
  const entry = embeddingsEntryOrThrow(cfg.provider);
  if (entry.asyncOnly) {
    throw err.invalidInput(
      `embeddings.provider "${cfg.provider}" cannot be used on this code path`,
      {
        provider: cfg.provider,
        hint: "a module provider is only loadable from the server's boot wiring, not from a CLI or eval entry point. Use a declarative provider (e.g. openai-compatible) for these commands.",
      },
    );
  }
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "embeddings");
  return { provider: entry.build(cfg, ctx), entry };
}
```

Add `import type { EmbeddingProvider } from "../embeddings/provider";`.

- [ ] **Step 5: Delegate from `createEmbeddingProvider`**

Replace lines **58-97** of `packages/server/src/embeddings/index.ts` (from the `export function
createEmbeddingProvider` signature through the closing `}` after the `withPrefixes` return — the
switch body ends at 92 and the factory continues to 97; the first draft's `58-90` would have left
lines 91-97 orphaned):

```ts
export function createEmbeddingProvider(
  cfg: EmbeddingsConfigLike,
  opts: { fetchFn?: FetchFn; override?: EmbeddingProvider } = {},
): EmbeddingProvider {
  if (opts.override) return opts.override;
  const { provider, entry } = resolveEmbeddings(cfg, { fetchFn: opts.fetchFn });
  // model-tier owns its own asymmetric prefixing and must not be double-wrapped.
  if (entry.ownsPrefixing) return provider;
  const qp = cfg.queryPrefix ?? "";
  const dp = cfg.documentPrefix ?? "";
  return qp === "" && dp === "" ? provider : withPrefixes(provider, qp, dp);
}
```

Add `import { resolveEmbeddings } from "../providers/registry";`. **Keep** the `EmbedOptions`
import (used by `withPrefixes`), `FetchFn` and `EmbeddingProvider` (the factory signature), and the
`export { resolveApiKey }` re-export at the bottom. Delete only the five adapter imports,
`buildModelTierProvider`, and `err` if now unused.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-registry-backcompat.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 7: Run the existing regression set**

Run: `cd packages/server && bun run test:local test/embeddings.test.ts test/embed-prefix.test.ts test/embed-batching.test.ts test/embedding-truncate.test.ts test/embedding-batch.test.ts test/model-factory.test.ts`
Expected: PASS. **`embeddings.test.ts` is the critical one** — lines 71-78 directly assert provider
resolution and the unknown-provider throw. The first draft omitted it. `embed-prefix` pins that
model-tier bypasses `withPrefixes`.

- [ ] **Step 8: Types and boundaries**

```bash
cd ~/obsidian-tc
bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"
bun run check:boundaries > /tmp/cb.log 2>&1; echo "boundaries=$?"
```

Expected: both `0`. **A cycle here is likely**, not hypothetical: `embeddings/index.ts` will import
`providers/registry.ts`, while `providers/types.ts` imports `EmbeddingsConfigLike` back from
`embeddings/index.ts`. `.dependency-cruiser.cjs:33-42` forbids circular deps including type-only
edges. If it fails, **move `EmbeddingsConfigLike` into `providers/types.ts`** and re-export it from
`embeddings/index.ts` for compatibility.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/providers/ packages/server/src/embeddings/index.ts \
        packages/server/test/provider-registry-backcompat.test.ts
git commit -s -m "refactor: move embeddings provider switch into a per-slot registry

No behaviour change. All six names become registry entries resolving to
byte-identical providers. The sync resolver refuses asyncOnly entries up front,
so the module hatch (Task 8) cannot silently reach a CLI path."
```

---

### Task 2: Open the provider enum and fail loudly on an unknown name

**Files:**
- Modify: `packages/shared/src/config/indexing-embeddings.schema.ts:11-16`
- Test: `packages/server/test/provider-registry-unknown-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-registry-unknown-name.test.ts
// Opening the enum moves typo detection from parse time to resolve time. Only acceptable if the
// resolve error is BETTER than the Zod one: it must name every valid option.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import { embeddingsProviderNames } from "../src/providers/registry";

describe("unknown embeddings provider", () => {
  it("throws naming the offending value", () => {
    expect(() => createEmbeddingProvider({ provider: "olama", model: "m", dimensions: 3 })).toThrow(/olama/);
  });

  it("lists EVERY registered name in the message", () => {
    let message = "";
    try {
      createEmbeddingProvider({ provider: "olama", model: "m", dimensions: 3 });
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(embeddingsProviderNames().length).toBeGreaterThan(0); // floor: never vacuous
    for (const name of embeddingsProviderNames()) expect(message).toContain(name);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-registry-unknown-name.test.ts`
Expected: test 1 may PASS already; test 2 FAILS until the hint lists names.

- [ ] **Step 3: Open the enum**

Replace lines 11-16 of `packages/shared/src/config/indexing-embeddings.schema.ts`:

```ts
  provider: z
    .string()
    .min(1)
    .default("ollama")
    .describe(
      "Embeddings backend name, resolved against the provider registry at startup. Built-ins: ollama, openai, voyage, cohere, bge-m3, model-tier (splits dense and multi-vector across two services), the generic openai-compatible, and the profile-gated module. An unregistered name is a startup error listing every valid option.",
    ),
```

The default stays `"ollama"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-registry-unknown-name.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Fix what this change breaks — same task, same commit**

Opening the enum breaks two things immediately. They are fixed here, not later, so no commit is ever
red. (An earlier draft deferred them to a separate task and accepted a known-red window; that was
the wrong shape — the task that breaks something fixes it.)

**5a — the docgen test's enum assertion.** `packages/server/test/docgen-config.test.ts:25` asserts:

```ts
    expect(byPath.get("embeddings.provider")?.type).toMatch(/^enum\(ollama\|/);
```

That is now false by design. Replace that single line with:

```ts
    expect(byPath.get("embeddings.provider")).toMatchObject({ type: "string", default: "ollama" });
```

Leave the `auth.mode` assertion on line 24 untouched — it still renders as an enum, and keeping it
is what proves the enum renderer itself did not regress.

**5b — the three committed docs that print the closed list.**

```bash
cd ~/obsidian-tc
bun run docgen:render > /tmp/dg.log 2>&1; echo "render=$?"
bun run docgen:render -- --check > /tmp/dgc.log 2>&1; echo "check=$?"
git diff --stat docs/
```

Expected: both `=0`. The diff touches `docs/wiki/Configuration.md` (~line 249) and
`docs/src/content/docs/configuration/config-reference.md` (~line 100), which are marker-region
generated. **`docs/wiki/Configuration.md` line 123 is hand-written prose** carrying
`Providers: \`ollama | openai | voyage | cohere | bge-m3 | model-tier\`` — docgen will NOT touch it.
Edit that sentence by hand to describe the registry and name the built-ins as examples rather than
as an exhaustive set.

- [ ] **Step 6: Verify green, then commit**

```bash
cd packages/server && bun run test:local test/provider-registry-unknown-name.test.ts test/docgen-config.test.ts > /tmp/t2.log 2>&1; echo "tests=$?"
cd ~/obsidian-tc && bun run config:schema && bun run config:schema:check > /tmp/css.log 2>&1; echo "schema=$?"
bun run docgen:facts-check > /tmp/facts.log 2>&1; echo "facts=$?"
```

Expected: every line `=0`.

```bash
git add packages/shared/src/config/indexing-embeddings.schema.ts docs/ \
        packages/server/test/provider-registry-unknown-name.test.ts \
        packages/server/test/docgen-config.test.ts
git commit -s -m "feat: open embeddings.provider from a closed enum to a registry name

The six enum values survive as registry keys, so no config migrates. Typo
detection moves from Zod parse to registry resolve, which is only acceptable
because the resolve error lists every registered name — the test asserts the
listing, not just that it threw.

Fixes what the change breaks in the same commit: docgen-config.test.ts asserted
the provider renders as enum(ollama|...), and three committed docs enumerated
the closed list."
```

---

### Task 3: The `openai-compatible` generic embedder and its wire-body invariant

**Files:**
- Create: `packages/server/src/providers/http-embeddings.ts`
- Modify: `packages/server/src/providers/registry.ts`
- Test: `packages/server/test/provider-wire-body-invariant.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-wire-body-invariant.test.ts
// The generic adapter must send the MINIMAL common body. Three published incidents share one shape:
//   dimensions      -> 400 on any non-Matryoshka OpenAI-compatible backend (mem0 #4153)
//   encoding_format -> SDK default base64 breaks proxies; explicit null breaks vLLM (LiteLLM)
//   max_tokens_per_doc / max_chunks_per_doc -> Cohere rerank v2 vs v1
// Asserting the EXACT key set is the point: a test over present keys passes while an extra key 400s.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";

function capture(): { fetchFn: FetchFn; urls: string[]; bodies: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const inputs = body.input as string[];
    return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchFn;
  return { fetchFn, urls, bodies };
}

const BASE = { provider: "openai-compatible", model: "BAAI/bge-m3", dimensions: 3 } as const;

describe("openai-compatible wire body", () => {
  it("sends EXACTLY {model, input}", async () => {
    const { fetchFn, bodies } = capture();
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1" }, { fetchFn }).embed(["hello"]);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["input", "model"]);
    expect(bodies[0]).toEqual({ model: "BAAI/bge-m3", input: ["hello"] });
  });

  it("appends /embeddings, tolerating a trailing slash", async () => {
    const a = capture();
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1" }, { fetchFn: a.fetchFn }).embed(["x"]);
    const b = capture();
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1/" }, { fetchFn: b.fetchFn }).embed(["x"]);
    expect(a.urls[0]).toBe("http://gw:4001/v1/embeddings");
    expect(b.urls[0]).toBe("http://gw:4001/v1/embeddings");
  });

  it("requires baseUrl", () => {
    expect(() => createEmbeddingProvider({ ...BASE })).toThrow(/baseUrl/);
  });

  it("refuses a baseUrl that would duplicate the appended path", () => {
    expect(() => createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1/embeddings" })).toThrow(/embeddings/);
  });

  it("sends the bearer token when a key is configured", async () => {
    const { fetchFn } = capture();
    let auth: string | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return fetchFn(url, init);
    }) as FetchFn;
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1", apiKey: "sk-x" }, { fetchFn: spy }).embed(["x"]);
    expect(auth).toBe("Bearer sk-x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-wire-body-invariant.test.ts`
Expected: FAIL — `unknown embeddings provider: openai-compatible`

- [ ] **Step 3: Write the generic adapter**

```ts
// packages/server/src/providers/http-embeddings.ts
// The generic "any OpenAI-shaped endpoint" embedder. Deliberately NOT an alias of openaiProvider:
// a named vendor entry may grow vendor-required fields over time (cohere already sends input_type
// because Cohere v2 mandates it), and this one must be provably unable to.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FetchFn, postJson } from "../embeddings/http";
import { assertVectors, type EmbeddingProvider } from "../embeddings/provider";

export interface HttpEmbeddingsOpts {
  model: string; dimensions: number; baseUrl?: string; apiKey?: string;
  fetchFn?: FetchFn; timeoutMs?: number; truncate?: boolean;
}

export function openAiCompatibleProvider(o: HttpEmbeddingsOpts): EmbeddingProvider {
  if (!o.baseUrl) {
    throw err.invalidInput("embeddings.baseUrl is required for provider 'openai-compatible'", {
      provider: "openai-compatible",
      hint: "set embeddings.baseUrl to the endpoint prefix that precedes /embeddings, e.g. http://127.0.0.1:4000/v1",
    });
  }
  const base = o.baseUrl.replace(/\/+$/, "");
  return {
    id: `openai-compatible:${o.model}`,
    provider: "openai-compatible",
    model: o.model,
    dimensions: o.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      // INVARIANT: exactly {model, input}. `dimensions` 400s every non-Matryoshka backend;
      // `encoding_format` 400s vLLM. Width is enforced below, client-side.
      const r = await postJson<{ data?: Array<{ embedding: number[] }> }>({
        url: `${base}/embeddings`,
        headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        body: { model: o.model, input: texts },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "openai-compatible",
      });
      return assertVectors((r.data ?? []).map((d) => d.embedding), o.dimensions, texts.length, {
        truncate: o.truncate,
      });
    },
  };
}
```

- [ ] **Step 4: Register it**

In `registry.ts` add `import { openAiCompatibleProvider } from "./http-embeddings";` and the entry:

```ts
  "openai-compatible": {
    appendsPath: "/embeddings",
    build: (c, x) => openAiCompatibleProvider(adapterOpts(c, x)),
  },
```

- [ ] **Step 5: Run tests, update the name list**

Add `"openai-compatible"` to Task 1's expected array (sorted: `["bge-m3", "cohere", "model-tier", "ollama", "openai", "openai-compatible", "voyage"]`).

Run: `cd packages/server && bun run test:local test/provider-wire-body-invariant.test.ts test/provider-registry-backcompat.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/providers/ packages/server/test/provider-wire-body-invariant.test.ts \
        packages/server/test/provider-registry-backcompat.test.ts
git commit -s -m "feat: add the openai-compatible generic embedder

Sends exactly {model, input}, pinned by asserting the EXACT key set. Refuses a
baseUrl duplicating the appended path: the tree has three baseUrl conventions,
making /v1/v1/embeddings the likely first-run failure of a drop-in slot."
```

---

### Task 4: `apiKeyEnv`, and the hint that names the wrong key

**Files:**
- Modify: `packages/server/src/embeddings/provider.ts`, `packages/server/src/embeddings/http.ts:16`, `packages/server/src/embeddings/index.ts` (`EmbeddingsConfigLike`), `packages/server/src/providers/registry.ts`, `packages/shared/src/config/indexing-embeddings.schema.ts`
- Test: `packages/server/test/provider-api-key-env.test.ts`

**Interfaces:**
- Produces: `resolveApiKey(provider: string, configKey?: string, apiKeyEnv?: string)` — third optional parameter, so every existing two-argument call site is unchanged

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-api-key-env.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resolveApiKey } from "../src/embeddings/provider";

afterEach(() => {
  delete process.env.MY_GATEWAY_KEY;
  delete process.env.OPENAI_API_KEY;
});

describe("resolveApiKey with apiKeyEnv", () => {
  it("reads the named environment variable", () => {
    process.env.MY_GATEWAY_KEY = "sk-from-env";
    expect(resolveApiKey("openai-compatible", undefined, "MY_GATEWAY_KEY")).toBe("sk-from-env");
  });
  it("prefers an inline apiKey", () => {
    process.env.MY_GATEWAY_KEY = "sk-from-env";
    expect(resolveApiKey("openai-compatible", "sk-inline", "MY_GATEWAY_KEY")).toBe("sk-inline");
  });
  it("falls back to the built-in map", () => {
    process.env.OPENAI_API_KEY = "sk-builtin";
    expect(resolveApiKey("openai", undefined, undefined)).toBe("sk-builtin");
  });
  it("returns undefined for an unknown provider with no apiKeyEnv", () => {
    expect(resolveApiKey("openai-compatible", undefined, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-api-key-env.test.ts`
Expected: FAIL on the first two — `resolveApiKey` ignores a third parameter.

- [ ] **Step 3: Extend `resolveApiKey`**

```ts
/**
 * Resolve a provider API key. Precedence: inline `apiKey`, then the variable named by `apiKeyEnv`,
 * then the built-in per-provider variable.
 *
 * `apiKeyEnv` exists because ENV_KEY is a closed map of vendor names — a generic endpoint has no
 * entry in it and therefore had no way to supply a key at all.
 */
export function resolveApiKey(
  provider: string, configKey?: string, apiKeyEnv?: string,
): string | undefined {
  if (configKey && configKey.length > 0) return configKey;
  if (apiKeyEnv && apiKeyEnv.length > 0) {
    const fromNamed = process.env[apiKeyEnv];
    if (fromNamed && fromNamed.length > 0) return fromNamed;
  }
  const name = ENV_KEY[provider];
  return name ? process.env[name] : undefined;
}
```

- [ ] **Step 4: Fix the hint that names a key which does not exist**

`packages/server/src/embeddings/http.ts:16` tells the user to set `embeddings.api_key`. The config
field is `apiKey`. This is the first error a drop-in user hits. Replace the fallback branch:

```ts
  return `check that the ${provider} endpoint (${url}) is reachable and a key is configured — set embeddings.apiKey, or name an environment variable with embeddings.apiKeyEnv.`;
```

- [ ] **Step 5: Thread it and add the schema field**

In `registry.ts`: `apiKey: resolveApiKey(cfg.provider, cfg.apiKey, cfg.apiKeyEnv),`.
Add `apiKeyEnv?: string;` to `EmbeddingsConfigLike`. In the schema, after `apiKey`:

```ts
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of the environment variable holding the provider API key. Needed for generic providers, which have no entry in the built-in per-vendor variable map. An inline apiKey takes precedence.",
    ),
```

- [ ] **Step 6: Run and commit**

Run: `cd packages/server && bun run test:local test/provider-api-key-env.test.ts`
Expected: PASS — 4 tests

```bash
cd ~/obsidian-tc && bun run config:schema
git add packages/server/src/embeddings/ packages/server/src/providers/registry.ts \
        packages/shared/src/config/indexing-embeddings.schema.ts docs/obsidian-tc.config.schema.json \
        packages/server/test/provider-api-key-env.test.ts
git commit -s -m "feat: let a provider name its API key env var via apiKeyEnv

ENV_KEY is a closed map of vendor names, so a generic endpoint had no way to
supply a key. Also fixes the failure hint, which told users to set
embeddings.api_key — a field that does not exist; it is apiKey."
```

---

### Task 5: The reranker slot

**Files:**
- Create: `packages/shared/src/config/reranker.schema.ts`, `packages/server/src/providers/http-rerank.ts`
- Modify: `packages/shared/src/config/server.schema.ts`, `packages/shared/src/config.schema.ts`, `packages/server/src/providers/registry.ts`, `packages/server/src/runtime/tool-wiring.ts:132-146`, `packages/server/src/runtime/server-runtime.ts:379`
- Test: `packages/server/test/reranker-slot-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/reranker-slot-wiring.test.ts
import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import { rerankerProviderNames, resolveReranker } from "../src/providers/registry";

function capture(): { fetchFn: FetchFn; urls: string[]; bodies: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ model: "rerank-v3.5", results: [{ index: 1, relevance_score: 0.9 }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchFn;
  return { fetchFn, urls, bodies };
}

const CFG = { provider: "cohere-compatible", model: "rerank-v3.5", baseUrl: "http://gw:4001/v2" };

describe("reranker slot", () => {
  it("registers the expected names", () => {
    expect(rerankerProviderNames()).toEqual(["cohere-compatible", "gateway", "model-tier"]);
  });

  it("sends EXACTLY {model, query, documents} when topN is 0", async () => {
    const { fetchFn, bodies } = capture();
    const r = await resolveReranker(CFG, { fetchFn });
    await r?.("q", ["a", "b"], 0);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["documents", "model", "query"]);
  });

  it("adds top_n only when positive, never a truncation parameter", async () => {
    const { fetchFn, bodies, urls } = capture();
    const r = await resolveReranker(CFG, { fetchFn });
    const hits = await r?.("q", ["a", "b"], 2);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["documents", "model", "query", "top_n"]);
    expect(bodies[0]).not.toHaveProperty("max_tokens_per_doc");
    expect(bodies[0]).not.toHaveProperty("max_chunks_per_doc");
    expect(urls[0]).toBe("http://gw:4001/v2/rerank");
    expect(hits).toEqual([{ index: 1, relevanceScore: 0.9 }]);
  });

  it("throws on an unknown name, listing every registered one", async () => {
    let message = "";
    try {
      await resolveReranker({ provider: "no-such-reranker", model: "m" }, {});
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(rerankerProviderNames().length).toBeGreaterThan(0);
    for (const name of rerankerProviderNames()) expect(message).toContain(name);
  });

  // The absent-config case the first draft claimed to cover but did not.
  it("model-tier yields null when modelTier.full is unconfigured, so the caller falls back", async () => {
    const r = await resolveReranker(
      { provider: "model-tier", model: "bge-reranker-v2-m3" },
      { embeddings: { provider: "model-tier", model: "q", dimensions: 1024 } },
    );
    expect(r).toBeNull();
  });

  it("gateway yields null when no gateway URL is configured", async () => {
    const prev = process.env.OBSIDIAN_TC_GATEWAY_URL;
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    try {
      expect(await resolveReranker({ provider: "gateway", model: "rerank" }, {})).toBeNull();
    } finally {
      if (prev !== undefined) process.env.OBSIDIAN_TC_GATEWAY_URL = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/reranker-slot-wiring.test.ts`
Expected: FAIL — `resolveReranker` is not exported.

- [ ] **Step 3: Write the generic reranker**

```ts
// packages/server/src/providers/http-rerank.ts
// The generic "any Cohere-shaped /rerank endpoint" reranker. LiteLLM follows the Cohere rerank
// format for ALL rerank providers; Jina, Voyage, TogetherAI and Infinity speak it.
//
// Cohere rerank is VERSIONED and the dialects differ: v2 replaced v1's max_chunks_per_doc with
// max_tokens_per_doc. Since this adapter appends only "/rerank", the dialect is decided by whether
// baseUrl ends in /v1 or /v2 — which is why neither truncation parameter is ever sent.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FetchFn, postJson } from "../embeddings/http";
import type { RerankHit, Reranker } from "../search/rerank";

export interface HttpRerankOpts {
  model: string; baseUrl?: string; apiKey?: string; fetchFn?: FetchFn; timeoutMs?: number;
}

export function cohereCompatibleReranker(o: HttpRerankOpts): Reranker {
  if (!o.baseUrl) {
    throw err.invalidInput("reranker.baseUrl is required for provider 'cohere-compatible'", {
      provider: "cohere-compatible",
      hint: "set reranker.baseUrl to the prefix preceding /rerank, INCLUDING the dialect version segment (e.g. http://127.0.0.1:4000/v2)",
    });
  }
  const base = o.baseUrl.replace(/\/+$/, "");
  return async (query: string, documents: string[], topN: number): Promise<RerankHit[]> => {
    const payload = await postJson<{ results?: Array<{ index: number; relevance_score: number }> }>({
      url: `${base}/rerank`,
      headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
      body: { model: o.model, query, documents, ...(topN > 0 ? { top_n: topN } : {}) },
      fetchFn: o.fetchFn,
      timeoutMs: o.timeoutMs,
      provider: "cohere-compatible",
    });
    return (payload.results ?? []).map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
  };
}
```

- [ ] **Step 4: Add the reranker map**

Append to `registry.ts`:

```ts
import { createGatewayClient } from "../gateway/client";
import { buildModelTierReranker } from "../model";
import { cohereCompatibleReranker } from "./http-rerank";
import type { ProviderDescriptor, RerankerEntry } from "./types";
import type { Reranker } from "../search/rerank";

const RERANKERS: Record<string, RerankerEntry> = {
  "cohere-compatible": {
    appendsPath: "/rerank",
    build: async (c, x) =>
      cohereCompatibleReranker({
        model: c.model,
        baseUrl: c.baseUrl,
        apiKey: resolveApiKey(c.provider, c.apiKey, c.apiKeyEnv),
        fetchFn: x.fetchFn,
        timeoutMs: c.timeoutMs,
      }),
  },
  // Reads the EMBEDDINGS config, not the reranker descriptor: buildModelTierReranker takes
  // ModelTierConfigLike, requiring `dimensions` and `modelTier` (model/factory.ts:87-94). Casting
  // the descriptor instead compiles and returns null forever.
  "model-tier": {
    appendsPath: "/v1/rerank",
    build: async (_c, x) =>
      x.embeddings ? buildModelTierReranker(x.embeddings, { fetchFn: x.fetchFn }) : null,
  },
  // Forwards the DECLARED config. GatewayClientOptions names them token / rerankModel / timeoutMs
  // (gateway/client.ts:62-74); dropping them silently falls back to env vars and model "rerank".
  gateway: {
    appendsPath: "/rerank",
    build: async (c, x) => {
      let gw: ReturnType<typeof createGatewayClient>;
      try {
        gw = createGatewayClient({
          baseUrl: c.baseUrl,
          token: resolveApiKey(c.provider, c.apiKey, c.apiKeyEnv),
          rerankModel: c.model,
          timeoutMs: c.timeoutMs,
          fetchFn: x.fetchFn,
        });
      } catch {
        return null; // no base URL configured -> graceful no-op, as today
      }
      return (q, docs, topN) => gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results);
    },
  },
};

export function rerankerProviderNames(): string[] {
  return Object.keys(RERANKERS).sort();
}

export async function resolveReranker(
  cfg: ProviderDescriptor, ctx: ResolveContext = {},
): Promise<Reranker | null> {
  const entry = RERANKERS[cfg.provider];
  if (!entry) {
    throw err.invalidInput(`unknown reranker provider: ${cfg.provider}`, {
      provider: cfg.provider,
      hint: `set reranker.provider to one of: ${rerankerProviderNames().join(", ")}`,
    });
  }
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "reranker");
  return entry.build(cfg, ctx);
}
```

- [ ] **Step 5: Write the config schema**

```ts
// packages/shared/src/config/reranker.schema.ts
// The reranker slot's PROVIDER-SELECTION surface. Rerank BEHAVIOUR flags already exist
// (retrieval.gatedRerank, retrieval.colbert, experiential.activationRerank); what never existed is
// a way to name WHICH backend answers. Leaf schema — imports Zod only.
import { z } from "zod";

export const RerankerConfigSchema = z.object({
  provider: z.string().min(1).describe(
    "Reranker backend name, resolved against the provider registry at startup. Built-ins: cohere-compatible (any Cohere-format /rerank endpoint), model-tier (the BGE cross-encoder, configured via embeddings.modelTier.full), gateway (the inference gateway passthrough), and the profile-gated module.",
  ),
  model: z.string().min(1).describe("Rerank model name as the provider names it."),
  // z.url(), not z.string().url() — the latter is deprecated in Zod 4.
  baseUrl: z.url().optional().describe(
    "Endpoint prefix preceding /rerank. Include the dialect version segment: Cohere rerank v2 replaced v1's max_chunks_per_doc with max_tokens_per_doc, and this prefix selects the dialect.",
  ),
  apiKey: z.string().optional().describe("Provider API key. Secret — never logged."),
  apiKeyEnv: z.string().min(1).optional().describe("Environment variable holding the API key. Inline apiKey wins."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout in ms for a single rerank request."),
  modulePath: z.string().min(1).optional().describe(
    "Module exporting createReranker, for provider 'module'. Refused under the hardened security profile.",
  ),
});
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
```

- [ ] **Step 6: Mount it and re-export through the facade**

In `server.schema.ts`, import `RerankerConfigSchema` and add beside `embeddings`:

```ts
  reranker: RerankerConfigSchema.optional().describe(
    "Reranker backend. ABSENT is meaningful: it preserves the historical behaviour of preferring the model-tier cross-encoder when configured, else the gateway passthrough, else a graceful no-op.",
  ),
```

**Also add `RerankerConfigSchema` and `RerankerConfig` to `packages/shared/src/config.schema.ts`.**
Every other config leaf is re-exported through that facade; omitting this one breaks the convention
and may trip `check:export-surface`.

- [ ] **Step 7: Switch the wiring (two files)**

`wireGatewaySeams` is defined at `tool-wiring.ts:132` and its **only caller is
`server-runtime.ts:379`** — a different file. Widen the signature and update that caller.

```ts
// tool-wiring.ts
export async function wireGatewaySeams(
  embeddings: ServerConfig["embeddings"],
  rerankerCfg?: ServerConfig["reranker"],
): Promise<GatewaySeams> {
  // ...existing gateway construction unchanged...
  const gatewayReranker: Reranker | null = gw
    ? (q, docs, topN) => gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results)
    : null;
  // A declared block wins. ABSENT preserves the historical precedence exactly.
  const reranker: Reranker | null = rerankerCfg
    ? await resolveReranker(rerankerCfg, { embeddings })
    : (buildModelTierReranker(embeddings) ?? gatewayReranker);
```

```ts
// server-runtime.ts:379
const { reranker, roles } = await wireGatewaySeams(config.embeddings, config.reranker);
```

Confirm `server-runtime.ts:379` is inside an async function; if not, hoist the await to the nearest
async boundary rather than making the whole path sync-blocking.

- [ ] **Step 8: Run tests**

Run: `cd packages/server && bun run test:local test/reranker-slot-wiring.test.ts test/rerank.test.ts test/gated-rerank.test.ts test/gated-rerank-config-wiring.test.ts`
Expected: PASS — 6 new plus the existing three files.

- [ ] **Step 9: Commit**

```bash
cd ~/obsidian-tc && bun run config:schema
git add packages/shared/src/config/ packages/shared/src/config.schema.ts \
        packages/server/src/providers/ packages/server/src/runtime/tool-wiring.ts \
        packages/server/src/runtime/server-runtime.ts docs/obsidian-tc.config.schema.json \
        packages/server/test/reranker-slot-wiring.test.ts
git commit -s -m "feat: give the reranker a provider-selection surface

Rerank BEHAVIOUR flags already existed; what did not was a way to name which
backend answers. An ABSENT block preserves the old model-tier ?? gateway
precedence exactly.

The model-tier entry reads the EMBEDDINGS config, because buildModelTierReranker
takes ModelTierConfigLike (requires dimensions + modelTier) — casting a reranker
descriptor compiles and returns null forever. The gateway entry forwards the
declared apiKey/model/timeoutMs as token/rerankModel/timeoutMs rather than
silently falling back to env vars."
```

---

### Task 6: Thread a declared `revision` into the vec fingerprint — at BOTH sites

**Read first.** The spec called this "manifest passthrough". That was wrong:

- `RepresentationManifest` (`representation.ts:88`) has **no production producer**; only its own
  test constructs one. Wiring it is out of scope — **`representation.ts` is not modified.**
- The live mechanism is `VecFingerprint` (`representation.ts:32`), which already carries an optional
  `revision` folded into the canonical string as `f.revision ?? ""`.
- **No production site supplies one**, so a checkpoint upgrade at the same name and width is invisible.
- `VecFingerprint` is built at **two** sites: `runtime/indexing-wiring.ts:107-115` and
  `search/indexing/index-vault.ts:76-84`.
- **`IndexVaultArgs` is declared in `search/indexing/types.ts:128`**, not in `index-vault.ts`.
- `Knowable<T>` is `T | "unknown"` — a string union, not an object.

**The two sites are the whole risk.** Update one and not the other and boot computes one fingerprint
while `index_vault` computes another, so each DROPs and rebuilds the table the other just built — an
unbounded rebuild loop that looks like a busy, healthy server.

**Files:**
- Modify: `packages/shared/src/config/indexing-embeddings.schema.ts`, `packages/server/src/embeddings/index.ts` (`EmbeddingsConfigLike`), `packages/server/src/search/indexing/types.ts:128`, `packages/server/src/runtime/indexing-wiring.ts:107-115`, `packages/server/src/search/indexing/index-vault.ts:76-84`
- Test: `packages/server/test/provider-revision-fingerprint.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/test/provider-revision-fingerprint.test.ts
import { describe, expect, it } from "vitest";
import { type VecFingerprint, vecFingerprint } from "../src/search/representation";

const BASE: VecFingerprint = {
  provider: "openai-compatible", model: "BAAI/bge-m3", dimensions: 1024,
  distanceMetric: "cosine", enrichmentVersion: 0, chunkerVersion: 1, schemaGen: "v1",
};

describe("revision in the vec fingerprint", () => {
  it("a declared revision changes the fingerprint", () => {
    expect(vecFingerprint({ ...BASE, revision: "abc123" })).not.toBe(vecFingerprint(BASE));
  });
  it("two different revisions differ", () => {
    expect(vecFingerprint({ ...BASE, revision: "abc123" })).not.toBe(vecFingerprint({ ...BASE, revision: "def456" }));
  });
  it("an absent revision is byte-identical to today's fingerprint", () => {
    // Back-compat: an existing index must NOT rebuild merely because this feature landed.
    expect(vecFingerprint({ ...BASE, revision: undefined })).toBe(vecFingerprint(BASE));
  });
});
```

**Site parity — this must compare VALUES, not merely find the word.** The first draft grepped each
file for any `revision:` occurrence, which would pass with two *different* revisions threaded — a
gate that cannot fail for the reason it exists.

```ts
// packages/server/test/provider-revision-site-parity.test.ts
// Both VecFingerprint construction sites must fold the SAME config value. Standing up boot wiring
// and the index_vault path to compare one string is far more setup than the property needs, so this
// reads the source and asserts each site reads revision from its own config object — then pins the
// resulting fingerprints are equal for identical inputs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type VecFingerprint, vecFingerprint } from "../src/search/representation";

const SITES = [
  { file: "src/runtime/indexing-wiring.ts", expr: "revision: deps.embeddings.revision" },
  { file: "src/search/indexing/index-vault.ts", expr: "revision: args.revision" },
];

describe("vec fingerprint construction sites", () => {
  it("both sites fold a revision from their own config", () => {
    expect(SITES.length).toBe(2); // floor: never vacuous
    for (const { file, expr } of SITES) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src, `${file} constructs a VecFingerprint`).toContain("schemaGen:");
      expect(src, `${file} must fold revision as \`${expr}\``).toContain(expr);
    }
  });

  it("identical inputs produce identical fingerprints regardless of site", () => {
    const shared: VecFingerprint = {
      provider: "p", model: "m", dimensions: 8, distanceMetric: "cosine",
      enrichmentVersion: 0, chunkerVersion: 1, schemaGen: "v1", revision: "r1",
    };
    expect(vecFingerprint({ ...shared })).toBe(vecFingerprint({ ...shared }));
    expect(vecFingerprint({ ...shared, revision: "r2" })).not.toBe(vecFingerprint(shared));
  });
});
```

- [ ] **Step 2: Run to verify the split**

Run: `cd packages/server && bun run test:local test/provider-revision-fingerprint.test.ts test/provider-revision-site-parity.test.ts`
Expected: `provider-revision-fingerprint` PASSES already (the function always supported `revision`);
`provider-revision-site-parity`'s first test FAILS. That split is the point — the mechanism was
built and never connected.

- [ ] **Step 3: Add the schema fields**

```ts
  revision: z.string().min(1).optional().describe(
    "Model revision / commit / checkpoint id. Folded into vec_index_fingerprint, so declaring it makes a checkpoint upgrade at the SAME model name and width rebuild the index instead of silently serving the old checkpoint's vectors against queries embedded by the new one. Omitting it reproduces today's behaviour exactly.",
  ),
  pooling: z.string().min(1).optional().describe(
    "Pooling strategy the backend applies (e.g. 'mean', 'last-token'). Recorded for provenance. NOTE: descriptive only today — RepresentationManifest has no production producer, so this does not affect the index.",
  ),
```

Add `revision?: string;` and `pooling?: string;` to `EmbeddingsConfigLike`.

- [ ] **Step 4: Add the argument where it is actually declared**

`IndexVaultArgs` is in `packages/server/src/search/indexing/types.ts:128`. Add:

```ts
  /** Model revision folded into the vec fingerprint. MUST match runtime/indexing-wiring.ts. */
  revision?: string;
```

- [ ] **Step 5: Thread both sites**

`runtime/indexing-wiring.ts`, after `schemaGen`:

```ts
      schemaGen: VEC_SCHEMA_GEN,
      // A checkpoint upgrade at the same model name and width is otherwise invisible. Undefined
      // reproduces the pre-existing fingerprint byte-for-byte.
      revision: deps.embeddings.revision,
```

`search/indexing/index-vault.ts`, after `schemaGen`:

```ts
      schemaGen: VEC_SCHEMA_GEN,
      // Must match runtime/indexing-wiring.ts exactly. If these diverge, boot and index_vault each
      // DROP and rebuild the table the other just built — an unbounded rebuild loop.
      revision: args.revision,
```

- [ ] **Step 6: Update the THREE config-bearing flows**

`rg 'indexVault\('` finds only the two direct calls and **misses the `indexVaultRecorded` wrapper**,
which is where two of the three flows actually originate. The complete set:

| flow | where the args are built |
|---|---|
| `add_vault` | `runtime/tool-wiring.ts:204-205` (`deps.indexVaultRecorded({...})`) |
| boot / scheduled reconcile | `runtime/plane-wiring.ts:193` (`.indexVaultRecorded({...})`) |
| MCP `index_vault` | `tools/m2/index-tools.ts:62-74` (direct `indexVault({...})`) |

Pass `revision: config.embeddings.revision` in all three. Non-production callers (eval, bun-smoke,
tests) need no edit — `revision` is optional.

- [ ] **Step 7: Run tests**

```bash
cd packages/server
bun run test:local test/provider-revision-fingerprint.test.ts test/provider-revision-site-parity.test.ts > /tmp/rev.log 2>&1; echo "revision=$?"
bunx vitest run bun-smoke/vec-model-swap.test.ts bun-smoke/vec-rebuild-signal.test.ts bun-smoke/vec-fallback-signal.test.ts > /tmp/swap.log 2>&1; echo "smoke=$?"
bun run test:local test/indexer.test.ts test/model-swap-reembed.test.ts > /tmp/idx.log 2>&1; echo "indexer=$?"
```

Expected: every line `=0`. `vec-model-swap` encodes THE-460 — a same-dimension swap where the
fingerprint was **correct** and the backfill still re-selected old-model rows.

- [ ] **Step 8: Commit**

```bash
cd ~/obsidian-tc && bun run config:schema
git add packages/shared/src/config/indexing-embeddings.schema.ts packages/server/src/embeddings/index.ts \
        packages/server/src/search/indexing/ packages/server/src/runtime/ \
        docs/obsidian-tc.config.schema.json packages/server/test/provider-revision-*.test.ts
git commit -s -m "feat: fold a declared model revision into the vec fingerprint

VecFingerprint always carried an optional revision that vecFingerprint() folded
into the canonical string, but no production site passed one — so a checkpoint
upgrade at the same name and width was invisible.

Threads it through BOTH construction sites and all THREE config-bearing flows
(add_vault, reconcile, index_vault); two of the three route through
indexVaultRecorded and are invisible to a naive rg for indexVault(. A parity
test pins that both sites fold the value, because updating one makes each DROP
and rebuild the table the other just built. Absent revision is byte-identical
to the old fingerprint, so no existing index rebuilds on upgrade.

Does NOT wire RepresentationManifest: it still has no production producer."
```

---

### Task 7: Stop `doctor` inferring capability from hardcoded provider names

`doctor` answers two questions from a closed set of provider names, so every drop-in provider gets a
wrong answer. (The docgen test and the three docs this used to also cover moved into Task 2, where
the change that breaks them lives.)

**Files:**
- Modify: `packages/server/src/cli/commands/doctor.ts:68-80`, `packages/server/src/doctor/checks.ts:10-56`
- Test: `packages/server/test/doctor-generic-provider.test.ts`

**Interfaces — verified, do not guess:** the export is
`retrievalHeadsCheck(view: RetrievalHeadsView): Check` at `doctor/checks.ts:25`. `RetrievalHeadsView`
(`checks.ts:11-19`) is `{ denseProvider, denseModel, denseDimensions, multiVector, sparseEnabled,
colbertEnabled }`. Add one optional field to it; do not rename the function.

- [ ] **Step 1: Write the doctor test**

```ts
// packages/server/test/doctor-generic-provider.test.ts
// doctor derives multiVector and reranker readiness from hardcoded provider names, so every
// drop-in provider reports multiVector:false and "reranking depends on the inference gateway"
// even with a reranker block configured. Both must key on what is CONFIGURED, not on a name.
import { describe, expect, it } from "vitest";
import { retrievalHeadsCheck, type RetrievalHeadsView } from "../src/doctor/checks";

const VIEW: RetrievalHeadsView = {
  denseProvider: "openai-compatible", denseModel: "BAAI/bge-m3", denseDimensions: 1024,
  multiVector: false, sparseEnabled: false, colbertEnabled: false,
};

describe("doctor with a generic provider", () => {
  it("does not claim model-tier rerank capability for an unknown provider name", () => {
    const c = retrievalHeadsCheck(VIEW);
    expect(JSON.stringify(c)).not.toMatch(/model-tier \/ ColBERT rerank capable/);
  });

  it("names a configured reranker instead of claiming gateway dependence", () => {
    const c = retrievalHeadsCheck({ ...VIEW, rerankerConfigured: "cohere-compatible" });
    expect(JSON.stringify(c)).toContain("cohere-compatible");
    expect(JSON.stringify(c)).not.toMatch(/reranking depends on the inference gateway/);
  });

  it("still reports model-tier capability when it genuinely applies", () => {
    const c = retrievalHeadsCheck({ ...VIEW, denseProvider: "model-tier", multiVector: true });
    expect(JSON.stringify(c)).toMatch(/model-tier \/ ColBERT rerank capable/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/doctor-generic-provider.test.ts`
Expected: FAIL on test 2 — `RetrievalHeadsView` has no `rerankerConfigured` field yet.

- [ ] **Step 3: Make doctor key on capability**

In `cli/commands/doctor.ts:74-77`, `multiVector` is
`provider === "bge-m3" || (provider === "model-tier" && modelTier?.full !== undefined)`. Keep those
as the *known-true* cases but stop implying the negative is authoritative, and pass the configured
reranker through so `checks.ts` can name it instead of asserting gateway dependence:

```ts
        multiVector:
          config.embeddings.provider === "bge-m3" ||
          (config.embeddings.provider === "model-tier" &&
            config.embeddings.modelTier?.full !== undefined),
        // A provider name no longer implies a capability set: a generic provider may well point at
        // a bge-m3 endpoint. Report what is CONFIGURED rather than inferring from the name.
        rerankerConfigured: config.reranker?.provider,
```

Then in `doctor/checks.ts`, prefer `view.rerankerConfigured` when present, and soften the negative
branch to say multi-vector could not be determined from the provider name rather than that
reranking depends on the gateway.

- [ ] **Step 4: Run the tests**

```bash
cd packages/server && bun run test:local test/doctor-generic-provider.test.ts test/doctor-checks.test.ts > /tmp/dgt.log 2>&1; echo "tests=$?"
```

Expected: `=0`. `doctor-checks.test.ts` is the existing suite for this module — it must still pass,
since `rerankerConfigured` is optional and its absence must reproduce today's output exactly.

- [ ] **Step 5: Commit**

```bash
git add packages/server/test/doctor-generic-provider.test.ts \
        packages/server/src/cli/commands/doctor.ts packages/server/src/doctor/checks.ts
git commit -s -m "fix: stop doctor inferring retrieval capability from provider names

doctor derived multiVector and reranker readiness from a closed set of provider
names, so every drop-in provider reported multiVector:false and 'reranking
depends on the inference gateway' even with a reranker block configured. It now
reports what is configured rather than inferring from a name; an absent
reranker block reproduces today's output exactly."
```

---

### Task 8: The module escape hatch

Last: the only step with a security posture, landing on a registry already proven correct.

**Files:**
- Create: `packages/server/src/providers/module-loader.ts`
- Modify: `packages/server/src/providers/registry.ts`, `packages/shared/src/config/indexing-embeddings.schema.ts` (**`modulePath` — the first draft never added it, so the embeddings hatch had no config field at all**), `packages/server/src/runtime/indexing-wiring.ts`, `packages/server/src/runtime/tool-wiring.ts`, `packages/server/src/runtime/server-runtime.ts`
- Test: `packages/server/test/provider-module-gate.test.ts`

**Context threading — bigger than it looks.** `wireGatewaySeams` receives only `embeddings`.
`IndexResourcesDeps` (`indexing-wiring.ts:42-54`) has neither `configPath` nor `securityProfile`.
The `configPath` at `tool-wiring.ts:164` belongs to the unrelated `M1WiringDeps`. Both values must be
threaded from `server-runtime.ts` (which has `configPath` at :240/:424 and reads
`config.securityProfile` at :598) down through `RuntimeCoreDeps` into both wiring functions.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-module-gate.test.ts
// FIVE refusals, all at boot. Every `rejects` is awaited: in Vitest 4 an un-awaited one PASSES
// even when the code is wrong, and these guard a security boundary.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProviderModule } from "../src/providers/module-loader";

function fixture(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "otc-provider-"));
  writeFileSync(join(dir, "provider.mjs"), contents, "utf8");
  return { dir, file: "provider.mjs" };
}

const GOOD = `export function createEmbeddingProvider() {
  return { id: "m:x", provider: "module", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0,0,0]) };
}`;
const base = { exportName: "createEmbeddingProvider" as const, slot: "embeddings" as const };

describe("module provider gate", () => {
  it("refuses under the hardened security profile", async () => {
    const { dir, file } = fixture(GOOD);
    await expect(loadProviderModule({ ...base, modulePath: file, configDir: dir, securityProfile: "hardened" }))
      .rejects.toThrow(/hardened/);
  });

  it("refuses a relative path with no config directory", async () => {
    await expect(loadProviderModule({ ...base, modulePath: "./p.mjs", configDir: undefined, securityProfile: "trusted-local" }))
      .rejects.toThrow(/config/i);
  });

  it("refuses a module missing the expected export", async () => {
    const { dir, file } = fixture(`export const nope = 1;`);
    await expect(loadProviderModule({ ...base, modulePath: file, configDir: dir, securityProfile: "trusted-local" }))
      .rejects.toThrow(/createEmbeddingProvider/);
  });

  it("refuses a malformed provider BEFORE it is used", async () => {
    const { dir, file } = fixture(`export function createEmbeddingProvider() { return { id: "x", dimensions: -1 }; }`);
    await expect(loadProviderModule({ ...base, modulePath: file, configDir: dir, securityProfile: "trusted-local" }))
      .rejects.toThrow(/embed|dimensions/);
  });

  it("refuses when modulePath is absent entirely", async () => {
    await expect(loadProviderModule({ ...base, modulePath: "", configDir: "/tmp", securityProfile: "trusted-local" }))
      .rejects.toThrow(/modulePath/);
  });

  it("loads a well-formed module under trusted-local", async () => {
    const { dir, file } = fixture(GOOD);
    const p = await loadProviderModule<{ dimensions: number }>({ ...base, modulePath: file, configDir: dir, securityProfile: "trusted-local" });
    expect(p.dimensions).toBe(3);
  });

  it("refuses a module provider on the SYNC path (CLI/eval callers)", async () => {
    const { createEmbeddingProvider } = await import("../src/embeddings");
    expect(() => createEmbeddingProvider({ provider: "module", model: "x", dimensions: 3, modulePath: "./p.mjs" }))
      .toThrow(/boot|code path/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-module-gate.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/module-loader'`

- [ ] **Step 3: Write the loader**

```ts
// packages/server/src/providers/module-loader.ts
// The escape hatch. A config that names code to import is a real capability, gated on the SAME
// securityProfile the rest of the server uses rather than a second trust axis that could disagree.
// hardened refuses; trusted-local allows — config.json already holds vault paths, API keys and the
// JWT secret, so whoever can write it already owns this process.
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { err } from "@the-40-thieves/obsidian-tc-shared";

export interface LoadProviderModuleOpts {
  modulePath: string;
  configDir: string | undefined;
  securityProfile: "hardened" | "trusted-local" | undefined;
  exportName: "createEmbeddingProvider" | "createReranker";
  slot: "embeddings" | "reranker";
}

function assertUsable(value: unknown, opts: LoadProviderModuleOpts): void {
  if (opts.slot === "reranker") {
    if (typeof value !== "function") {
      throw err.invalidInput(`${opts.slot}.modulePath did not produce a Reranker function`, {
        modulePath: opts.modulePath,
        hint: "createReranker must return (query, documents, topN) => Promise<RerankHit[]>",
      });
    }
    return;
  }
  const p = value as { embed?: unknown; dimensions?: unknown };
  const dimsOk = typeof p?.dimensions === "number" && Number.isInteger(p.dimensions) && p.dimensions > 0;
  if (typeof p?.embed !== "function" || !dimsOk) {
    throw err.invalidInput(`${opts.slot}.modulePath did not produce a usable EmbeddingProvider`, {
      modulePath: opts.modulePath,
      hint: "createEmbeddingProvider must return an object with embed(texts) and a positive integer dimensions",
    });
  }
}

export async function loadProviderModule<T>(opts: LoadProviderModuleOpts): Promise<T> {
  if (!opts.modulePath || opts.modulePath.length === 0) {
    throw err.invalidInput(`${opts.slot}.provider is "module" but ${opts.slot}.modulePath is not set`, {
      hint: `set ${opts.slot}.modulePath to a module exporting ${opts.exportName}`,
    });
  }
  const profile = opts.securityProfile ?? "trusted-local";
  if (profile === "hardened") {
    throw err.invalidInput(`${opts.slot}.provider "module" is refused under securityProfile "hardened"`, {
      modulePath: opts.modulePath,
      hint: `loading a provider module executes code named by config.json. Use a declarative provider (e.g. openai-compatible) under the hardened posture.`,
    });
  }
  if (!opts.configDir && !isAbsolute(opts.modulePath)) {
    throw err.invalidInput(`${opts.slot}.modulePath is relative but there is no config file directory to resolve it against`, {
      modulePath: opts.modulePath,
      hint: "a relative modulePath resolves against the config file's directory; this server started without a config file, so give an absolute path.",
    });
  }
  // The config DIRECTORY is the trust root, never process.cwd() — cwd in a container is arbitrary.
  const abs = isAbsolute(opts.modulePath) ? opts.modulePath : resolve(opts.configDir as string, opts.modulePath);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (cause) {
    throw err.invalidInput(`${opts.slot}.modulePath could not be imported`, {
      modulePath: opts.modulePath, resolved: abs, hint: `${(cause as Error).message}`,
    });
  }
  const factory = mod[opts.exportName];
  if (typeof factory !== "function") {
    throw err.invalidInput(`${opts.slot}.modulePath does not export ${opts.exportName}`, {
      modulePath: opts.modulePath, resolved: abs,
      hint: `export a function named ${opts.exportName} from that module`,
    });
  }
  const built = (factory as () => unknown)();
  assertUsable(built, opts);
  return built as T;
}
```

- [ ] **Step 4: Add `modulePath` to the embeddings schema**

The first draft omitted this entirely, leaving the embeddings hatch unselectable. In
`indexing-embeddings.schema.ts`, after `apiKeyEnv`:

```ts
  modulePath: z.string().min(1).optional().describe(
    "Module exporting createEmbeddingProvider, for provider 'module'. Resolved against the config file's directory. Refused under the hardened security profile, and refused on CLI/eval entry points (module providers load only from the server's boot wiring).",
  ),
```

Add `modulePath?: string;` to `EmbeddingsConfigLike`.

- [ ] **Step 5: Register both `module` entries and add the async resolvers**

```ts
  module: {
    appendsPath: "",
    asyncOnly: true,
    build: () => {
      throw err.invalidInput("module providers cannot be built synchronously", {
        hint: "this is a bug: resolveEmbeddings must refuse asyncOnly entries before calling build",
      });
    },
    buildAsync: (c, x) =>
      loadProviderModule<EmbeddingProvider>({
        modulePath: c.modulePath ?? "", configDir: x.configDir,
        securityProfile: x.securityProfile, exportName: "createEmbeddingProvider", slot: "embeddings",
      }),
  },
```

```ts
export async function resolveEmbeddingsAsync(
  cfg: EmbeddingsConfigLike, ctx: ResolveContext = {},
): Promise<{ provider: EmbeddingProvider; entry: EmbeddingsEntry }> {
  const entry = embeddingsEntryOrThrow(cfg.provider);
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "embeddings");
  if (entry.buildAsync) return { provider: await entry.buildAsync(cfg, ctx), entry };
  return { provider: entry.build(cfg, ctx), entry };
}
```

And the reranker `module` entry (its `build` is already async):

```ts
  module: {
    appendsPath: "",
    build: (c, x) =>
      loadProviderModule<Reranker>({
        modulePath: c.modulePath ?? "", configDir: x.configDir,
        securityProfile: x.securityProfile, exportName: "createReranker", slot: "reranker",
      }),
  },
```

- [ ] **Step 6: Thread `configDir` and `securityProfile` from `server-runtime.ts`**

Add `configDir?: string` and `securityProfile?: "hardened" | "trusted-local"` to `IndexResourcesDeps`
(`indexing-wiring.ts:42-54`) and to `wireGatewaySeams`'s parameters. In `server-runtime.ts`, derive
`configDir` from the existing `configPath` (`dirname(configPath)` when defined) and pass
`config.securityProfile` alongside it at both wiring calls (:379 for the gateway seams, and the
`wireIndexResources` call near :204-209). Switch `indexing-wiring.ts:99` from
`createEmbeddingProvider` to `await resolveEmbeddingsAsync(...)`, keeping the `ownsPrefixing`
handling from Task 1.

- [ ] **Step 7: Run every provider test**

Run: `cd packages/server && bun run test:local test/provider-registry-backcompat.test.ts test/provider-registry-unknown-name.test.ts test/provider-wire-body-invariant.test.ts test/provider-api-key-env.test.ts test/reranker-slot-wiring.test.ts test/provider-revision-fingerprint.test.ts test/provider-revision-site-parity.test.ts test/provider-module-gate.test.ts`
Expected: PASS. Add `"module"` to **both** name-list assertions (Tasks 1 and 5).

- [ ] **Step 8: Watch each refusal actually fail**

For each of the five refusals, temporarily invert the guard (e.g. change `profile === "hardened"` to
`profile === "never"`), re-run, confirm the test **fails**, then revert. A `rejects` assertion that
was never watched failing proves nothing.

- [ ] **Step 9: Commit**

```bash
cd ~/obsidian-tc && bun run config:schema && bun run docgen:render
git add packages/server/src/providers/ packages/server/src/runtime/ \
        packages/shared/src/config/indexing-embeddings.schema.ts \
        docs/ packages/server/test/
git commit -s -m "feat: add the profile-gated module provider escape hatch

Five boot-time refusals, each asserted and each watched failing: hardened
profile, relative path with no config dir, missing export, malformed provider,
and absent modulePath. Plus a sixth guard on the SYNC path — createEmbeddingProvider
is called directly by four CLI/eval entry points and loadProviderModule is async,
so module providers are boot-path only and say so rather than failing obscurely.

modulePath is added to BOTH schemas; the embeddings hatch previously had no
config field at all. configDir and securityProfile are threaded from
server-runtime through RuntimeCoreDeps into both wiring functions -- neither
wireGatewaySeams nor IndexResourcesDeps carried them."
```

---

## Final verification

- [ ] **Run the full gate set**

```bash
cd ~/obsidian-tc
bun run lint > /tmp/lint.log 2>&1; echo "biome=$?"
bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"
for g in check:boundaries check:dev-dep-imports check:config-paths check:duplicate-exports \
         check:duplication check:export-surface check:facade-parity; do
  bun run "$g" > "/tmp/${g//:/-}.log" 2>&1; echo "$g=$?"
done
bun run config:schema:check > /tmp/css.log 2>&1; echo "config:schema:check=$?"
bun run docgen:render -- --check > /tmp/dgc.log 2>&1; echo "docgen=$?"
bun run docgen:facts-check > /tmp/facts.log 2>&1; echo "facts=$?"
```

Expected: every line `=0`. `bun run lint` is **biome only** — the rest are separate CI steps.

- [ ] **Push and run real CI**

```bash
git push -u origin mislam2/pluggable-provider-slots-spec
gh workflow run ci-server.yml --ref mislam2/pluggable-provider-slots-spec
gh workflow run ci-docgen.yml --ref mislam2/pluggable-provider-slots-spec
```

- [ ] **Honour the gate coverage caveat**

`check:config-threading` **cannot** catch a declared-but-unread key here: it exempts generic
identifiers, and its own comment names `model` and `enabled`. `apiKeyEnv`, `modulePath`, `revision`
and `pooling` are distinctive enough to be caught; `reranker.provider`, `reranker.model` and
`reranker.baseUrl` are not. Verify by inspection that each has a test proving it reaches a consumer:
`provider` and `baseUrl` in Task 5's wiring test, `model` in the same test's body assertion.

---

## Known deferrals

- **`tei` as a standalone registry name.** Already reachable via `model-tier`; exposing it adds a
  third `baseUrl` convention to document while enabling nothing new.
- **`pooling` has no effect.** Descriptive until `RepresentationManifest` gains a producer. The
  schema description says so rather than implying an effect it does not have.
- **Migrating the repo's 2 `z.string().url()` and 4 `z.ZodIssueCode` sites** to `z.url()` and the
  `"custom"` literal. Separate diff.
- **Module providers on CLI/eval paths.** Refused by design (see Design decision 1). Making
  `createEmbeddingProvider` async would touch every caller and is its own change.
