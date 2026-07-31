# Pluggable Embedding and Rerank Provider Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedding model and the reranker drop-in slots, so any model behind a standard HTTP shape can be named in `config.json` with no code change, plus a security-gated module escape hatch.

**Architecture:** A per-slot provider registry (`packages/server/src/providers/`) replaces the `switch` in `embeddings/index.ts`. Two name→entry maps — one for embeddings, one for reranking — share one resolver, one error contract, and one `baseUrl` validation rule. The six existing embedding provider names become registry entries, so every existing config resolves identically and nothing migrates. `EmbeddingsConfigSchema.provider` opens from a Zod enum to `z.string()`; a new optional `reranker` block gives the reranker slot the config surface it has never had.

**Tech Stack:** Bun 1.3.14 · TypeScript 7.0.2 · Zod 4.4.3 · Vitest 4 · Biome 2.5.x

## Global Constraints

- **Zero config migration.** Every config valid before this change must produce a byte-identical provider afterwards. `"provider": "ollama"` must keep working untouched.
- **Boot-time failure only.** Every misconfiguration in this path throws during wiring, never lazily at first embed/query. `createEmbeddingProvider` is called from `runtime/indexing-wiring.ts:99`, which is boot wiring; preserve that and match it for the reranker.
- **Wire-body invariant (generic entries only).** `openai-compatible` sends exactly `{model, input}`. `cohere-compatible` sends exactly `{model, query, documents}` plus `top_n` only when set. Never send `dimensions`, `encoding_format`, `max_tokens_per_doc`, or `max_chunks_per_doc`. Named entries (`openai`, `cohere`, …) are exempt — `cohere` legitimately sends `input_type` because Cohere v2 mandates it.
- **No provider SDKs in the tree.** Raw `postJson` only. This is already the standing rule at `gateway/client.ts:46`.
- **Zod idiom is this repo's, not the newest.** Use `.superRefine()` with `ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...], message })`, matching `server.schema.ts:132`. Messages are long and name the fix.
- **Never pipe a gate through `tail`/`head`** — `$?` reports the pipe. Redirect to a log, check `$?` separately.
- **Do not run the full suite locally.** This box is 4 cores under ~43 containers. Targeted vitest only, via `bun run test:local <file>` (wraps `scripts/with-host-budget.sh`). Full CI is `gh workflow run ci-server.yml --ref <branch>`.
- **Every commit needs DCO sign-off** (`git commit -s`). The `prepare-commit-msg` hook installed by `bun install` does this automatically.
- **Generated artifacts are hook-blocked.** After any schema change run `bun run config:schema`; never hand-edit `docs/obsidian-tc.config.schema.json`.

---

## File Structure

**Create:**

| file | responsibility |
|---|---|
| `packages/server/src/providers/types.ts` | Descriptor + entry interfaces shared by both slots. No logic. |
| `packages/server/src/providers/registry.ts` | The two name→entry maps, `resolveEmbeddings`, `resolveReranker`, name listing, `baseUrl` duplicate-segment refusal. |
| `packages/server/src/providers/http-embeddings.ts` | The `openai-compatible` generic embedder. |
| `packages/server/src/providers/http-rerank.ts` | The `cohere-compatible` generic reranker. |
| `packages/server/src/providers/module-loader.ts` | The profile-gated `module` escape hatch for both slots. |
| `packages/shared/src/config/reranker.schema.ts` | `RerankerConfigSchema`. Leaf schema — imports Zod only. |

**Modify:**

| file | change |
|---|---|
| `packages/shared/src/config/indexing-embeddings.schema.ts:12` | `provider` enum → `z.string()`; add `apiKeyEnv`, `revision`, `pooling` |
| `packages/shared/src/config/server.schema.ts` | Mount the optional `reranker` block |
| `packages/server/src/embeddings/index.ts:58-90` | `switch` → registry delegation |
| `packages/server/src/embeddings/provider.ts` | `resolveApiKey` honours `apiKeyEnv` |
| `packages/server/src/runtime/tool-wiring.ts:146` | Hardcoded reranker precedence → registry resolve with the old precedence as fallback |
| `packages/server/src/search/representation.ts` | Manifest reads declared `revision`/`pooling` |

**Test:** one file per task under `packages/server/test/`, named in each task.

---

### Task 1: Provider registry with the six existing embedders

Moves the `switch` into a registry with **no behaviour change**. This task's only job is proving the move is invisible, so it must land before anything new is added.

**Files:**
- Create: `packages/server/src/providers/types.ts`
- Create: `packages/server/src/providers/registry.ts`
- Modify: `packages/server/src/embeddings/index.ts:58-90`
- Test: `packages/server/test/provider-registry-backcompat.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `EmbedOptions` (`../embeddings/provider`), `FetchFn` (`../embeddings/http`), `EmbeddingsConfigLike` (`../embeddings`)
- Produces: `ProviderDescriptor`, `ResolveContext`, `EmbeddingsEntry` (types.ts); `resolveEmbeddings(cfg, ctx)`, `embeddingsProviderNames()` (registry.ts)

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-registry-backcompat.test.ts
// Task 1 — the switch → registry move must be INVISIBLE. Every name that worked before
// resolves to a provider with an identical id/provider/model/dimensions triple.
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
      const p = createEmbeddingProvider({
        provider: c.provider,
        model: c.model,
        dimensions: c.dimensions,
      });
      expect(p.id).toBe(c.id);
      expect(p.provider).toBe(c.provider);
      expect(p.model).toBe(c.model);
      expect(p.dimensions).toBe(c.dimensions);
    });
  }

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
// Descriptor and entry shapes shared by BOTH provider slots (embeddings, reranker). Types only —
// no logic lives here, so a slot can be read without loading the other's adapters.
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
  /** Name of the environment variable holding the key. See Task 4. */
  apiKeyEnv?: string;
  timeoutMs?: number;
  /** Module specifier for the `module` entry. See Task 7. */
  modulePath?: string;
}

/** Ambient facts a factory may need that are not part of the descriptor itself. */
export interface ResolveContext {
  fetchFn?: FetchFn;
  /** Directory of the loaded config file — the trust root for `modulePath` (Task 7).
   *  Undefined when the config was derived from a vault path rather than a file. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
}

export interface EmbeddingsEntry {
  /** The path this entry appends to `baseUrl` (e.g. "/embeddings"). Declared rather than
   *  buried in the adapter so the resolver can refuse a baseUrl that would duplicate it —
   *  the adapters do NOT agree on whether baseUrl carries the version segment. */
  readonly appendsPath: string;
  /** True when the entry applies its own query/document prefixing and must bypass the shared
   *  withPrefixes wrapper. Only model-tier does (Qwen instruct on the dense query, BGE bare). */
  readonly ownsPrefixing?: boolean;
  build(cfg: EmbeddingsConfigLike, ctx: ResolveContext): EmbeddingProvider;
}

export interface RerankerEntry {
  readonly appendsPath: string;
  /** Null means "configured, but this backend is not available" — the caller then falls back
   *  to the graceful no-op, exactly as buildModelTierReranker does today. */
  build(cfg: ProviderDescriptor, ctx: ResolveContext): Reranker | null;
}
```

- [ ] **Step 4: Create the registry with the six existing entries**

```ts
// packages/server/src/providers/registry.ts
// The single resolution point for both provider slots. Replaces the switch that lived in
// embeddings/index.ts. Adding a model is adding a row to a map here — no schema edit, no release.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { EmbeddingsConfigLike } from "../embeddings";
import {
  bgeM3Provider,
  cohereProvider,
  ollamaProvider,
  openaiProvider,
  voyageProvider,
} from "../embeddings/providers";
import { resolveApiKey } from "../embeddings/provider";
import { buildModelTierProvider } from "../model";
import type { EmbeddingsEntry, ResolveContext } from "./types";

/** The option bag every openAiStyle-family adapter takes. Built once so entries stay one-liners. */
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

const EMBEDDINGS: Record<string, EmbeddingsEntry> = {
  // appendsPath values are the REAL suffix each adapter appends today — see providers.ts.
  ollama: { appendsPath: "/api/embed", build: (c, x) => ollamaProvider(adapterOpts(c, x)) },
  openai: { appendsPath: "/embeddings", build: (c, x) => openaiProvider(adapterOpts(c, x)) },
  voyage: { appendsPath: "/embeddings", build: (c, x) => voyageProvider(adapterOpts(c, x)) },
  cohere: { appendsPath: "/embed", build: (c, x) => cohereProvider(adapterOpts(c, x)) },
  "bge-m3": { appendsPath: "/encode", build: (c, x) => bgeM3Provider(adapterOpts(c, x)) },
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

export function embeddingsEntry(name: string): EmbeddingsEntry | undefined {
  return EMBEDDINGS[name];
}

export function resolveEmbeddings(
  cfg: EmbeddingsConfigLike,
  ctx: ResolveContext = {},
): { provider: ReturnType<EmbeddingsEntry["build"]>; entry: EmbeddingsEntry } {
  const entry = EMBEDDINGS[cfg.provider];
  if (!entry) {
    throw err.invalidInput(`unknown embeddings provider: ${cfg.provider}`, {
      provider: cfg.provider,
      hint: `set embeddings.provider to one of: ${embeddingsProviderNames().join(", ")}`,
    });
  }
  return { provider: entry.build(cfg, ctx), entry };
}
```

- [ ] **Step 5: Delegate from `createEmbeddingProvider`**

Replace the body of `createEmbeddingProvider` in `packages/server/src/embeddings/index.ts` (currently lines 58-90, the `if (cfg.provider === "model-tier")` branch through the `switch`) with:

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

Add `import { resolveEmbeddings } from "../providers/registry";` at the top and delete the now-unused `bgeM3Provider`/`cohereProvider`/`ollamaProvider`/`openaiProvider`/`voyageProvider`/`buildModelTierProvider`/`resolveApiKey`/`err` imports that only the switch used. Keep the `export { resolveApiKey }` re-export at the bottom — it is part of the module's public surface.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-registry-backcompat.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 7: Run the existing embeddings tests for regressions**

Run: `cd packages/server && bun run test:local test/embed-prefix.test.ts test/embed-batching.test.ts test/embedding-truncate.test.ts test/embedding-batch.test.ts`
Expected: PASS. `embed-prefix` is the critical one — it pins that model-tier bypasses `withPrefixes` and that empty prefixes are byte-identical.

- [ ] **Step 8: Check boundaries and types**

Run: `cd ../.. && bun run typecheck > /tmp/tc.log 2>&1; echo $?` then `bun run check:boundaries > /tmp/cb.log 2>&1; echo $?`
Expected: both `0`. `check:boundaries` rejects type-only import cycles; `providers/types.ts` imports types from `embeddings/` and `search/`, and `providers/registry.ts` is imported *by* `embeddings/index.ts`, so a cycle here is plausible. If it fails, move `EmbeddingsConfigLike` into `providers/types.ts` and re-export it from `embeddings/index.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/providers/types.ts packages/server/src/providers/registry.ts \
        packages/server/src/embeddings/index.ts \
        packages/server/test/provider-registry-backcompat.test.ts
git commit -s -m "refactor: move embeddings provider switch into a per-slot registry

No behaviour change. The six provider names become registry entries resolving
to byte-identical providers; the test pins id/provider/model/dimensions for
each so the move is provably invisible before anything new is added."
```

---

### Task 2: Open the provider enum and fail loudly on an unknown name

**Files:**
- Modify: `packages/shared/src/config/indexing-embeddings.schema.ts:11-16`
- Test: `packages/server/test/provider-registry-unknown-name.test.ts`

**Interfaces:**
- Consumes: `embeddingsProviderNames()`, `resolveEmbeddings()` from Task 1
- Produces: nothing new; `EmbeddingsConfigSchema.provider` becomes `z.string()`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-registry-unknown-name.test.ts
// Task 2 — opening the enum moves typo detection from parse time to resolve time. That is only
// acceptable if the resolve error is BETTER than the Zod one: it must name every valid option.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import { embeddingsProviderNames } from "../src/providers/registry";

describe("unknown embeddings provider", () => {
  it("throws naming the offending value", () => {
    expect(() =>
      createEmbeddingProvider({ provider: "olama", model: "m", dimensions: 3 }),
    ).toThrow(/olama/);
  });

  it("lists EVERY registered name in the message", () => {
    let message = "";
    try {
      createEmbeddingProvider({ provider: "olama", model: "m", dimensions: 3 });
    } catch (e) {
      message = JSON.stringify(e);
    }
    // Asserting the listing, not merely that it threw. A bare "unknown provider" is the
    // failure mode this replaces.
    for (const name of embeddingsProviderNames()) {
      expect(message).toContain(name);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-registry-unknown-name.test.ts`
Expected: The first test may already PASS (Task 1's registry throws). The second FAILS unless the hint lists names — if both pass, the hint is already correct and you may proceed to Step 3 for the schema change only.

- [ ] **Step 3: Open the enum**

In `packages/shared/src/config/indexing-embeddings.schema.ts`, replace lines 11-16:

```ts
  provider: z
    .string()
    .min(1)
    .default("ollama")
    .describe(
      "Embeddings backend name, resolved against the provider registry at startup. Built-ins: ollama, openai, voyage, cohere, bge-m3, model-tier (splits dense and multi-vector across two services), plus the generic openai-compatible and the profile-gated module. An unregistered name is a startup error listing every valid option.",
    ),
```

Note the default stays `"ollama"` — changing it would be a behaviour change outside this plan's scope.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-registry-unknown-name.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Regenerate the config schema**

Run: `cd ../.. && bun run config:schema && bun run config:schema:check > /tmp/cs.log 2>&1; echo $?`
Expected: `0`. The generated `docs/obsidian-tc.config.schema.json` is hook-blocked for hand edits — it must be regenerated, never patched.

- [ ] **Step 6: Run the config gates**

Run: `bun run check:config-paths > /tmp/ccp.log 2>&1; echo $?`
Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/config/indexing-embeddings.schema.ts \
        docs/obsidian-tc.config.schema.json \
        packages/server/test/provider-registry-unknown-name.test.ts
git commit -s -m "feat: open embeddings.provider from a closed enum to a registry name

The six enum values survive as registry keys, so no config migrates. Typo
detection moves from Zod parse to registry resolve, which is only acceptable
because the resolve error lists every registered name — the test asserts the
listing, not just that it threw."
```

---

### Task 3: The `openai-compatible` generic embedder, its wire-body invariant, and the baseUrl contract

The core of the feature. The invariant tests land **with** the adapter — they are the only thing between "works against my gateway" and "works against any endpoint".

**Files:**
- Create: `packages/server/src/providers/http-embeddings.ts`
- Modify: `packages/server/src/providers/registry.ts`
- Test: `packages/server/test/provider-wire-body-invariant.test.ts`

**Interfaces:**
- Consumes: `postJson` (`../embeddings/http`), `assertVectors` (`../embeddings/provider`), `EmbeddingsEntry` (Task 1)
- Produces: `openAiCompatibleProvider(o: AdapterOpts): EmbeddingProvider`; registry name `openai-compatible`; `assertBaseUrlNotDuplicating(baseUrl, appendsPath, slot)` exported from `registry.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-wire-body-invariant.test.ts
// Task 3 — the generic adapter must send the MINIMAL common body. Three published incidents
// share one shape: a parameter correct in one dialect is a hard 400 in another.
//   dimensions       -> 400 on any non-Matryoshka OpenAI-compatible backend (mem0 #4153)
//   encoding_format  -> SDK default base64 breaks proxies; explicit null breaks vLLM (LiteLLM)
//   max_tokens_per_doc / max_chunks_per_doc -> Cohere rerank v2 vs v1
// Asserting the EXACT key set is the point: a test over present keys passes while an extra
// key 400s half of all backends.
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
    return new Response(
      JSON.stringify({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as FetchFn;
  return { fetchFn, urls, bodies };
}

const BASE = { provider: "openai-compatible", model: "BAAI/bge-m3", dimensions: 3 } as const;

describe("openai-compatible wire body", () => {
  it("sends EXACTLY {model, input} — no dimensions, no encoding_format", async () => {
    const { fetchFn, bodies } = capture();
    const p = createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1" }, { fetchFn });
    await p.embed(["hello"]);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["input", "model"]);
    expect(bodies[0]).toEqual({ model: "BAAI/bge-m3", input: ["hello"] });
  });

  it("appends /embeddings to baseUrl, tolerating a trailing slash", async () => {
    const a = capture();
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1" }, { fetchFn: a.fetchFn })
      .embed(["x"]);
    const b = capture();
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1/" }, { fetchFn: b.fetchFn })
      .embed(["x"]);
    expect(a.urls[0]).toBe("http://gw:4001/v1/embeddings");
    expect(b.urls[0]).toBe("http://gw:4001/v1/embeddings");
  });

  it("requires baseUrl — there is no sensible default endpoint", () => {
    expect(() => createEmbeddingProvider({ ...BASE })).toThrow(/baseUrl/);
  });

  it("refuses a baseUrl that would duplicate the appended path", () => {
    expect(() =>
      createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1/embeddings" }),
    ).toThrow(/embeddings/);
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
// a named vendor entry is free to grow vendor-required fields over time (cohere already sends
// input_type because Cohere v2 mandates it), and this one must be provably unable to. The body it
// sends is the minimal common denominator and is pinned by test.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FetchFn, postJson } from "../embeddings/http";
import { assertVectors, type EmbeddingProvider } from "../embeddings/provider";

export interface HttpEmbeddingsOpts {
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  truncate?: boolean;
}

/** Strip trailing slashes so `${base}/embeddings` never yields a doubled separator. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function openAiCompatibleProvider(o: HttpEmbeddingsOpts): EmbeddingProvider {
  if (!o.baseUrl) {
    throw err.invalidInput("embeddings.baseUrl is required for provider 'openai-compatible'", {
      provider: "openai-compatible",
      hint: "set embeddings.baseUrl to the endpoint prefix that precedes /embeddings, e.g. http://127.0.0.1:4000/v1",
    });
  }
  const base = normalizeBase(o.baseUrl);
  return {
    id: `openai-compatible:${o.model}`,
    provider: "openai-compatible",
    model: o.model,
    dimensions: o.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      // INVARIANT: exactly {model, input}. Adding `dimensions` 400s every non-Matryoshka
      // backend; adding `encoding_format` 400s vLLM. Width is enforced below, client-side.
      const r = await postJson<{ data?: Array<{ embedding: number[] }> }>({
        url: `${base}/embeddings`,
        headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        body: { model: o.model, input: texts },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "openai-compatible",
      });
      return assertVectors(
        (r.data ?? []).map((d) => d.embedding),
        o.dimensions,
        texts.length,
        { truncate: o.truncate },
      );
    },
  };
}
```

- [ ] **Step 4: Add the baseUrl duplicate-segment guard to the registry**

Append to `packages/server/src/providers/registry.ts`:

```ts
/**
 * Refuse a baseUrl whose trailing segments already contain the path the entry will append.
 *
 * The adapters in this tree do NOT agree on what baseUrl means — openAiStyle appends
 * "/embeddings" to a base that carries "/v1", while model/tei.ts appends "/v1/embeddings" to a
 * bare root. So "set baseUrl" means different things per name, and http://host/v1/embeddings +
 * "/embeddings" is the most likely first-run failure of a drop-in slot.
 *
 * Refusing rather than silently stripping is deliberate: stripping hides that the operator is on
 * the wrong convention, and they will hit it again on the next provider.
 */
export function assertBaseUrlNotDuplicating(
  baseUrl: string | undefined,
  appendsPath: string,
  slot: "embeddings" | "reranker",
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
```

Then call it inside `resolveEmbeddings`, immediately after the entry lookup and before `entry.build(...)`:

```ts
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "embeddings");
```

- [ ] **Step 5: Register the entry**

Add to the `EMBEDDINGS` map in `registry.ts`, and import the adapter:

```ts
import { openAiCompatibleProvider } from "./http-embeddings";
```

```ts
  "openai-compatible": {
    appendsPath: "/embeddings",
    build: (c, x) => openAiCompatibleProvider(adapterOpts(c, x)),
  },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-wire-body-invariant.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Update the back-compat name list**

Task 1's test asserts the exact registered-name array. Add `"openai-compatible"` to the expected list in `packages/server/test/provider-registry-backcompat.test.ts` (sorted: `["bge-m3", "cohere", "model-tier", "ollama", "openai", "openai-compatible", "voyage"]`), then re-run both files.

Run: `cd packages/server && bun run test:local test/provider-registry-backcompat.test.ts test/provider-wire-body-invariant.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/providers/http-embeddings.ts \
        packages/server/src/providers/registry.ts \
        packages/server/test/provider-wire-body-invariant.test.ts \
        packages/server/test/provider-registry-backcompat.test.ts
git commit -s -m "feat: add the openai-compatible generic embedder

Sends exactly {model, input}, pinned by a test asserting the EXACT key set --
dimensions 400s non-Matryoshka backends and encoding_format 400s vLLM, and a
test over present keys would pass while an extra key breaks half of all
endpoints. Kept separate from the openai entry rather than aliasing it, so a
future vendor-required field cannot leak into self-hosted backends.

Also refuses a baseUrl that duplicates the path the entry appends: the tree has
three different baseUrl conventions, making /v1/v1/embeddings the likely
first-run failure of a drop-in slot."
```

---

### Task 4: `apiKeyEnv`

Closes the second locked door: `resolveApiKey` knows only three provider names, so a generic provider has no way to name its key variable.

**Files:**
- Modify: `packages/server/src/embeddings/provider.ts` (the `ENV_KEY` map and `resolveApiKey`)
- Modify: `packages/shared/src/config/indexing-embeddings.schema.ts`
- Modify: `packages/server/src/providers/registry.ts` (pass `apiKeyEnv` through `adapterOpts`)
- Test: `packages/server/test/provider-api-key-env.test.ts`

**Interfaces:**
- Consumes: `resolveApiKey` (existing)
- Produces: `resolveApiKey(provider: string, configKey?: string, apiKeyEnv?: string): string | undefined` — a third optional parameter, so every existing two-argument call site is unchanged

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-api-key-env.test.ts
// Task 4 — precedence is inline apiKey > apiKeyEnv > the built-in per-provider map.
import { afterEach, describe, expect, it } from "vitest";
import { resolveApiKey } from "../src/embeddings/provider";

const TOUCHED = ["MY_GATEWAY_KEY", "OPENAI_API_KEY"];
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

describe("resolveApiKey with apiKeyEnv", () => {
  it("reads the named environment variable", () => {
    process.env.MY_GATEWAY_KEY = "sk-from-env";
    expect(resolveApiKey("openai-compatible", undefined, "MY_GATEWAY_KEY")).toBe("sk-from-env");
  });

  it("prefers an inline apiKey over apiKeyEnv", () => {
    process.env.MY_GATEWAY_KEY = "sk-from-env";
    expect(resolveApiKey("openai-compatible", "sk-inline", "MY_GATEWAY_KEY")).toBe("sk-inline");
  });

  it("falls back to the built-in map when apiKeyEnv is absent", () => {
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
Expected: FAIL — the first two tests fail; `resolveApiKey` currently takes two parameters and ignores the third.

- [ ] **Step 3: Extend `resolveApiKey`**

Replace `resolveApiKey` in `packages/server/src/embeddings/provider.ts`:

```ts
/**
 * Resolve a provider API key. Precedence: an inline `apiKey` from config, then the variable named
 * by `apiKeyEnv`, then the built-in per-provider variable.
 *
 * `apiKeyEnv` exists because ENV_KEY is a closed map of vendor names — a generic
 * openai-compatible endpoint has no entry in it and therefore had no way to supply a key at all.
 */
export function resolveApiKey(
  provider: string,
  configKey?: string,
  apiKeyEnv?: string,
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

- [ ] **Step 4: Thread it through the registry**

In `packages/server/src/providers/registry.ts`, change the `apiKey` line of `adapterOpts`:

```ts
    apiKey: resolveApiKey(cfg.provider, cfg.apiKey, cfg.apiKeyEnv),
```

Add `apiKeyEnv?: string;` to `EmbeddingsConfigLike` in `packages/server/src/embeddings/index.ts`, beside the existing `apiKey` field.

- [ ] **Step 5: Add the schema field**

In `packages/shared/src/config/indexing-embeddings.schema.ts`, after the `apiKey` field:

```ts
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of the environment variable holding the provider API key. Needed for generic providers, which have no entry in the built-in per-vendor variable map. An inline apiKey takes precedence.",
    ),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-api-key-env.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Regenerate the schema and commit**

```bash
cd ../.. && bun run config:schema
git add packages/server/src/embeddings/provider.ts packages/server/src/embeddings/index.ts \
        packages/server/src/providers/registry.ts \
        packages/shared/src/config/indexing-embeddings.schema.ts \
        docs/obsidian-tc.config.schema.json \
        packages/server/test/provider-api-key-env.test.ts
git commit -s -m "feat: let a provider name its API key env var via apiKeyEnv

ENV_KEY is a closed map of vendor names, so a generic endpoint had no way to
supply a key. Third optional parameter, so every existing call site is
unchanged; precedence is inline apiKey > apiKeyEnv > the built-in map."
```

---

### Task 5: The reranker slot — config schema, registry, and wiring

Gives the reranker the config surface it has never had, without changing what any existing deployment does.

**Files:**
- Create: `packages/shared/src/config/reranker.schema.ts`
- Create: `packages/server/src/providers/http-rerank.ts`
- Modify: `packages/shared/src/config/server.schema.ts`
- Modify: `packages/server/src/providers/registry.ts`
- Modify: `packages/server/src/runtime/tool-wiring.ts:132-146`
- Test: `packages/server/test/reranker-slot-wiring.test.ts`

**Interfaces:**
- Consumes: `Reranker`, `RerankHit` (`../search/rerank`); `GatewayClient.rerank` (`../gateway/client`); `buildModelTierReranker` (`../model`)
- Produces: `cohereCompatibleReranker(o): Reranker`; `resolveReranker(cfg, ctx): Reranker | null`; `rerankerProviderNames(): string[]`; `RerankerConfigSchema`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/reranker-slot-wiring.test.ts
// Task 5 — an ABSENT reranker block must behave exactly as today (null -> graceful no-op), and a
// present one must reach the declared backend with the minimal Cohere-format body.
import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import { rerankerProviderNames, resolveReranker } from "../src/providers/registry";

function capture(): { fetchFn: FetchFn; urls: string[]; bodies: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ model: "rerank-v3.5", results: [{ index: 1, relevance_score: 0.9 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as FetchFn;
  return { fetchFn, urls, bodies };
}

describe("reranker slot", () => {
  it("registers the expected names", () => {
    expect(rerankerProviderNames()).toEqual(["cohere-compatible", "gateway", "model-tier"]);
  });

  it("sends EXACTLY {model, query, documents} when topN is not set", async () => {
    const { fetchFn, bodies } = capture();
    const r = resolveReranker(
      { provider: "cohere-compatible", model: "rerank-v3.5", baseUrl: "http://gw:4001/v2" },
      { fetchFn },
    );
    await r?.("q", ["a", "b"], 0);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["documents", "model", "query"]);
  });

  it("includes top_n only when positive, and never a truncation parameter", async () => {
    const { fetchFn, bodies, urls } = capture();
    const r = resolveReranker(
      { provider: "cohere-compatible", model: "rerank-v3.5", baseUrl: "http://gw:4001/v2" },
      { fetchFn },
    );
    const hits = await r?.("q", ["a", "b"], 2);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["documents", "model", "query", "top_n"]);
    expect(bodies[0]).not.toHaveProperty("max_tokens_per_doc");
    expect(bodies[0]).not.toHaveProperty("max_chunks_per_doc");
    expect(urls[0]).toBe("http://gw:4001/v2/rerank");
    expect(hits).toEqual([{ index: 1, relevanceScore: 0.9 }]);
  });

  it("throws on an unknown name, listing every registered one", () => {
    let message = "";
    try {
      resolveReranker({ provider: "no-such-reranker", model: "m" }, {});
    } catch (e) {
      message = JSON.stringify(e);
    }
    for (const name of rerankerProviderNames()) expect(message).toContain(name);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/reranker-slot-wiring.test.ts`
Expected: FAIL — `resolveReranker` is not exported from the registry.

- [ ] **Step 3: Write the generic reranker**

```ts
// packages/server/src/providers/http-rerank.ts
// The generic "any Cohere-shaped /rerank endpoint" reranker. LiteLLM follows the Cohere rerank
// format for ALL rerank providers, and Jina, Voyage, TogetherAI and Infinity speak it — one shape
// covers the field.
//
// Cohere rerank is VERSIONED and the dialects differ: v2 replaced v1's max_chunks_per_doc with
// max_tokens_per_doc. Since this adapter appends only "/rerank", the dialect is decided entirely
// by whether the operator's baseUrl ends in /v1 or /v2 — which is why neither truncation
// parameter is ever sent. top_n is the only optional field, and it exists in both dialects.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FetchFn, postJson } from "../embeddings/http";
import type { RerankHit, Reranker } from "../search/rerank";

export interface HttpRerankOpts {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export function cohereCompatibleReranker(o: HttpRerankOpts): Reranker {
  if (!o.baseUrl) {
    throw err.invalidInput("reranker.baseUrl is required for provider 'cohere-compatible'", {
      provider: "cohere-compatible",
      hint: "set reranker.baseUrl to the endpoint prefix that precedes /rerank, including the dialect version segment (e.g. http://127.0.0.1:4000/v2)",
    });
  }
  const base = o.baseUrl.replace(/\/+$/, "");
  return async (query: string, documents: string[], topN: number): Promise<RerankHit[]> => {
    // INVARIANT: exactly {model, query, documents}, plus top_n only when positive.
    const payload = await postJson<{
      results?: Array<{ index: number; relevance_score: number }>;
    }>({
      url: `${base}/rerank`,
      headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
      body: {
        model: o.model,
        query,
        documents,
        ...(topN > 0 ? { top_n: topN } : {}),
      },
      fetchFn: o.fetchFn,
      timeoutMs: o.timeoutMs,
      provider: "cohere-compatible",
    });
    return (payload.results ?? []).map((r) => ({
      index: r.index,
      relevanceScore: r.relevance_score,
    }));
  };
}
```

- [ ] **Step 4: Add the reranker map to the registry**

Append to `packages/server/src/providers/registry.ts`:

```ts
import { createGatewayClient } from "../gateway/client";
import { buildModelTierReranker } from "../model";
import { cohereCompatibleReranker } from "./http-rerank";
import type { ProviderDescriptor, RerankerEntry } from "./types";

const RERANKERS: Record<string, RerankerEntry> = {
  "cohere-compatible": {
    appendsPath: "/rerank",
    build: (c, x) =>
      cohereCompatibleReranker({
        model: c.model,
        baseUrl: c.baseUrl,
        apiKey: resolveApiKey(c.provider, c.apiKey, c.apiKeyEnv),
        fetchFn: x.fetchFn,
        timeoutMs: c.timeoutMs,
      }),
  },
  // The two sources tool-wiring.ts hardcoded before this change, now nameable.
  "model-tier": {
    appendsPath: "/v1/rerank",
    build: (c, x) =>
      buildModelTierReranker(c as unknown as Parameters<typeof buildModelTierReranker>[0], {
        fetchFn: x.fetchFn,
      }),
  },
  gateway: {
    appendsPath: "/rerank",
    build: (c, x) => {
      let gw: ReturnType<typeof createGatewayClient> | null = null;
      try {
        gw = createGatewayClient({ baseUrl: c.baseUrl, fetchFn: x.fetchFn });
      } catch {
        return null; // no base URL configured -> graceful no-op, as today
      }
      const client = gw;
      return (q, docs, topN) =>
        client.rerank({ query: q, documents: docs, topN }).then((r) => r.results);
    },
  },
};

export function rerankerProviderNames(): string[] {
  return Object.keys(RERANKERS).sort();
}

export function resolveReranker(
  cfg: ProviderDescriptor,
  ctx: ResolveContext = {},
): Reranker | null {
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

Add `import type { Reranker } from "../search/rerank";` to the imports.

- [ ] **Step 5: Write the config schema**

```ts
// packages/shared/src/config/reranker.schema.ts
// THE reranker slot's config surface. Before this existed the reranker was wired entirely in code
// (tool-wiring.ts hardcoded model-tier ?? gateway) and could not be selected by an operator at all.
//
// Leaf schema — imports Zod only. It must never import config.schema.ts or server.schema.ts.
import { z } from "zod";

export const RerankerConfigSchema = z.object({
  provider: z
    .string()
    .min(1)
    .describe(
      "Reranker backend name, resolved against the provider registry at startup. Built-ins: cohere-compatible (any Cohere-format /rerank endpoint), model-tier (the BGE cross-encoder), gateway (the inference gateway passthrough), and the profile-gated module.",
    ),
  model: z.string().min(1).describe("Rerank model name as the provider names it."),
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Endpoint prefix that precedes /rerank. Include the dialect version segment: Cohere rerank v2 replaced v1's max_chunks_per_doc with max_tokens_per_doc, and this prefix is what selects the dialect.",
    ),
  apiKey: z.string().optional().describe("Provider API key. Secret — never logged."),
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe("Name of the environment variable holding the API key. Inline apiKey wins."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in ms for a single rerank request."),
  modulePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Module exporting createReranker, for provider 'module'. Refused under the hardened security profile.",
    ),
});
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
```

- [ ] **Step 6: Mount it on the server schema**

In `packages/shared/src/config/server.schema.ts`, add the import and the optional field beside the existing `embeddings` entry:

```ts
import { RerankerConfigSchema } from "./reranker.schema";
```

```ts
  reranker: RerankerConfigSchema.optional().describe(
    "Reranker backend. ABSENT is meaningful: it preserves the historical behaviour of preferring the model-tier cross-encoder when configured, else the gateway passthrough, else a graceful no-op.",
  ),
```

- [ ] **Step 7: Switch the wiring, preserving the old precedence**

In `packages/server/src/runtime/tool-wiring.ts`, replace the reranker lines (currently 140-146):

```ts
  // W-RETRIEVAL rerank seam. A declared `reranker` block wins. ABSENT preserves the historical
  // precedence exactly: model-tier's BGE cross-encoder when its service is configured, else the
  // gateway /rerank passthrough, else null (graceful no-op).
  const gatewayReranker: Reranker | null = gw
    ? (q, docs, topN) => gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results)
    : null;
  const reranker: Reranker | null = rerankerCfg
    ? resolveReranker(rerankerCfg, { fetchFn: undefined })
    : (buildModelTierReranker(embeddings) ?? gatewayReranker);
```

Add `import { resolveReranker } from "../providers/registry";`, and thread `rerankerCfg` in by widening `wireGatewaySeams`'s signature to `(embeddings: ServerConfig["embeddings"], rerankerCfg?: ServerConfig["reranker"])`. Update its single call site in the same file to pass `config.reranker`.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/reranker-slot-wiring.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 9: Run the existing rerank tests for regressions**

Run: `cd packages/server && bun run test:local test/rerank.test.ts test/gated-rerank.test.ts test/gated-rerank-config-wiring.test.ts`
Expected: PASS. These pin the graceful-no-op fallback and the `RerankOutcome` reporting, which this task must not disturb.

- [ ] **Step 10: Regenerate the schema and commit**

```bash
cd ../.. && bun run config:schema
git add packages/shared/src/config/reranker.schema.ts packages/shared/src/config/server.schema.ts \
        packages/server/src/providers/http-rerank.ts packages/server/src/providers/registry.ts \
        packages/server/src/runtime/tool-wiring.ts docs/obsidian-tc.config.schema.json \
        packages/server/test/reranker-slot-wiring.test.ts
git commit -s -m "feat: give the reranker a config surface

The Reranker type was always pluggable but had nowhere to be named from --
tool-wiring.ts hardcoded both sources and their precedence. Adds an optional
reranker block and a per-slot registry; an ABSENT block preserves the old
model-tier ?? gateway precedence exactly, so no deployment changes behaviour.

cohere-compatible sends exactly {model, query, documents} plus top_n. Neither
max_tokens_per_doc nor max_chunks_per_doc is sent: the adapter appends only
/rerank, so baseUrl's version segment picks the v1/v2 dialect and sending
either truncation parameter would be rejected by the other one."
```

---

### Task 6: Thread a declared `revision` into the vec fingerprint — at BOTH construction sites

**Read this before starting.** The spec described this as "manifest passthrough". That was wrong,
and the correction changes the work:

- `RepresentationManifest` (`representation.ts:88`) has **no production producer**. Only its own
  test constructs one. It is a type awaiting wiring, not a live mechanism. Wiring it is out of
  scope here.
- The live mechanism is `VecFingerprint` (`representation.ts:32`). It already carries an optional
  `revision`, and `vecFingerprint()` already folds it into the canonical string as `f.revision ?? ""`.
- **No production site passes one.** So `revision` is permanently `""` and a checkpoint upgrade at
  the same model name and width is invisible today.
- `VecFingerprint` is constructed at **two** sites: `runtime/indexing-wiring.ts:107-115` (boot) and
  `search/indexing/index-vault.ts:76-84` (the `index_vault` tool path).

`Knowable<T>` is `T | "unknown"` — a bare string union, not an object. Do not write assertions
against `{ known: true, value }`.

**The two sites are the whole risk.** They must produce identical fingerprints for identical
config. Update one and not the other and boot computes one fingerprint while `index_vault`
computes another, so each DROPs and rebuilds the vector table the other just built — an unbounded
rebuild loop that looks like a busy, healthy server.

**Files:**
- Modify: `packages/shared/src/config/indexing-embeddings.schema.ts`
- Modify: `packages/server/src/runtime/indexing-wiring.ts:107-115`
- Modify: `packages/server/src/search/indexing/index-vault.ts:76-84`
- Test: `packages/server/test/provider-revision-fingerprint.test.ts`

**Interfaces:**
- Consumes: `VecFingerprint`, `vecFingerprint()` (`../search/representation`)
- Produces: no new exported symbols. `EmbeddingsConfigLike` gains `revision?: string` and `pooling?: string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-revision-fingerprint.test.ts
// Task 6 — a declared revision must change the vec fingerprint, and BOTH construction sites must
// agree. Divergence is worse than the bug it fixes: boot and index_vault would each DROP and
// rebuild the table the other just built, forever, while looking busy and healthy.
import { describe, expect, it } from "vitest";
import { type VecFingerprint, vecFingerprint } from "../src/search/representation";

const BASE: VecFingerprint = {
  provider: "openai-compatible",
  model: "BAAI/bge-m3",
  dimensions: 1024,
  distanceMetric: "cosine",
  enrichmentVersion: 0,
  chunkerVersion: 1,
  schemaGen: "v1",
};

describe("revision in the vec fingerprint", () => {
  it("a declared revision changes the fingerprint", () => {
    expect(vecFingerprint({ ...BASE, revision: "abc123" })).not.toBe(vecFingerprint(BASE));
  });

  it("two different revisions differ", () => {
    expect(vecFingerprint({ ...BASE, revision: "abc123" })).not.toBe(
      vecFingerprint({ ...BASE, revision: "def456" }),
    );
  });

  it("an absent revision is byte-identical to today's fingerprint", () => {
    // Back-compat: an existing index must NOT rebuild merely because this feature landed.
    expect(vecFingerprint({ ...BASE, revision: undefined })).toBe(vecFingerprint(BASE));
  });
});
```

And the site-parity test, which is the one that matters:

```ts
// packages/server/test/provider-revision-site-parity.test.ts
// The two VecFingerprint construction sites must fold config.revision identically. This test reads
// the SOURCE of both sites rather than calling them, because standing up the full boot wiring and
// the index_vault path just to compare one string is far more setup than the property needs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SITES = [
  "src/runtime/indexing-wiring.ts",
  "src/search/indexing/index-vault.ts",
];

describe("vec fingerprint construction sites", () => {
  it("both sites exist and both fold a revision", () => {
    // Floor: if this ever reads zero sites, the test would vacuously pass.
    expect(SITES.length).toBe(2);
    for (const site of SITES) {
      const src = readFileSync(new URL(`../${site}`, import.meta.url), "utf8");
      expect(src, `${site} constructs a VecFingerprint`).toContain("schemaGen:");
      expect(src, `${site} must pass revision into the fingerprint`).toMatch(/revision:/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && bun run test:local test/provider-revision-fingerprint.test.ts test/provider-revision-site-parity.test.ts`
Expected: `provider-revision-fingerprint` PASSES already (the fingerprint function has always
supported `revision`); `provider-revision-site-parity` FAILS on both sites — neither passes one.
That split is the point: the mechanism was built and never connected.

- [ ] **Step 3: Add the schema fields**

In `packages/shared/src/config/indexing-embeddings.schema.ts`, after `apiKeyEnv`:

```ts
  revision: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model revision / commit / checkpoint id. Folded into vec_index_fingerprint, so declaring it is what makes a checkpoint upgrade at the SAME model name and width rebuild the index instead of silently serving the old checkpoint's vectors against queries embedded by the new one. Omitting it reproduces today's behaviour exactly.",
    ),
  pooling: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Pooling strategy the backend applies (e.g. 'mean', 'last-token'). Recorded for provenance in the representation manifest. NOTE: the manifest has no production producer yet, so this field is currently descriptive only and does not affect the index.",
    ),
```

Add `revision?: string;` and `pooling?: string;` to `EmbeddingsConfigLike` in
`packages/server/src/embeddings/index.ts`.

- [ ] **Step 4: Thread it into site 1 (boot wiring)**

In `packages/server/src/runtime/indexing-wiring.ts`, add one line to the `ensureVecChunks`
fingerprint literal, after `schemaGen`:

```ts
      schemaGen: VEC_SCHEMA_GEN,
      // THE-460 follow-on: a checkpoint upgrade at the same model name and width is otherwise
      // invisible. Undefined reproduces the pre-existing fingerprint byte-for-byte.
      revision: deps.embeddings.revision,
```

- [ ] **Step 5: Thread it into site 2 (the index_vault tool path)**

In `packages/server/src/search/indexing/index-vault.ts`, add the matching line after `schemaGen`:

```ts
      schemaGen: VEC_SCHEMA_GEN,
      // Must match runtime/indexing-wiring.ts exactly. If these two diverge, boot and index_vault
      // each DROP and rebuild the table the other just built — an unbounded rebuild loop.
      revision: args.revision,
```

Add `revision?: string;` to this function's `args` interface and pass `cfg.embeddings.revision`
from every caller. Find them with:

```bash
cd ~/obsidian-tc && rg -n 'indexVault\(' packages/server/src --type ts
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/server && bun run test:local test/provider-revision-fingerprint.test.ts test/provider-revision-site-parity.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Run the fingerprint regression suite**

```bash
cd packages/server
bun run test:local test/search-representation-manifest.test.ts > /tmp/rep.log 2>&1; echo "manifest=$?"
bunx vitest run bun-smoke/vec-model-swap.test.ts > /tmp/swap.log 2>&1; echo "swap=$?"
bunx vitest run bun-smoke/vec-rebuild-signal.test.ts bun-smoke/vec-fallback-signal.test.ts > /tmp/sig.log 2>&1; echo "signals=$?"
```

Expected: every line `=0`. `vec-model-swap` encodes THE-460 — a same-dimension swap where the
fingerprint was **correct** and the backfill still re-selected old-model rows. Drop-in providers
make same-dimension swaps a one-line config edit, so this test matters more after this change than
before it.

- [ ] **Step 8: Regenerate the schema and commit**

```bash
cd ../.. && bun run config:schema
git add packages/shared/src/config/indexing-embeddings.schema.ts \
        packages/server/src/embeddings/index.ts \
        packages/server/src/runtime/indexing-wiring.ts \
        packages/server/src/search/indexing/index-vault.ts \
        docs/obsidian-tc.config.schema.json \
        packages/server/test/provider-revision-fingerprint.test.ts \
        packages/server/test/provider-revision-site-parity.test.ts
git commit -s -m "feat: fold a declared model revision into the vec fingerprint

VecFingerprint has always carried an optional revision and vecFingerprint() has
always folded it into the canonical string -- but no production site ever
passed one, so a checkpoint upgrade at the same model name and width was
invisible and the index kept serving the old checkpoint's vectors.

Threads config.embeddings.revision into BOTH construction sites: boot wiring
and the index_vault tool path. A site-parity test pins that both fold it,
because updating one and not the other makes each DROP and rebuild the table
the other just built -- an unbounded rebuild loop that looks like a busy,
healthy server. An absent revision is byte-identical to the old fingerprint, so
no existing index rebuilds on upgrade.

Does NOT wire RepresentationManifest: it still has no production producer."
```

---

### Task 7: The module escape hatch

Last deliberately: it is the only step with a security posture, and it should land on a registry already proven correct.

**Files:**
- Create: `packages/server/src/providers/module-loader.ts`
- Modify: `packages/server/src/providers/registry.ts`
- Modify: `packages/server/src/runtime/tool-wiring.ts` (pass `configDir` and `securityProfile` into `ResolveContext`)
- Test: `packages/server/test/provider-module-gate.test.ts`

**Interfaces:**
- Consumes: `ResolveContext` (Task 1), `EmbeddingProvider`, `Reranker`
- Produces: `loadProviderModule<T>(opts): Promise<T>`; registry entries named `module` in both maps

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/provider-module-gate.test.ts
// Task 7 — FOUR refusals, all at boot. A config that names code to run is the one place in this
// design with a security posture, so every rejection path is asserted explicitly.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProviderModule } from "../src/providers/module-loader";

function fixture(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "otc-provider-"));
  const file = "provider.mjs";
  writeFileSync(join(dir, file), contents, "utf8");
  return { dir, file };
}

const GOOD = `export function createEmbeddingProvider() {
  return { id: "m:x", provider: "module", model: "x", dimensions: 3, embed: async (t) => t.map(() => [0, 0, 0]) };
}`;

describe("module provider gate", () => {
  it("refuses under the hardened security profile", async () => {
    const { dir, file } = fixture(GOOD);
    await expect(
      loadProviderModule({
        modulePath: file,
        configDir: dir,
        securityProfile: "hardened",
        exportName: "createEmbeddingProvider",
        slot: "embeddings",
      }),
    ).rejects.toThrow(/hardened/);
  });

  it("refuses when there is no config directory to resolve against", async () => {
    await expect(
      loadProviderModule({
        modulePath: "./provider.mjs",
        configDir: undefined,
        securityProfile: "trusted-local",
        exportName: "createEmbeddingProvider",
        slot: "embeddings",
      }),
    ).rejects.toThrow(/config/i);
  });

  it("refuses a module missing the expected export", async () => {
    const { dir, file } = fixture(`export const nope = 1;`);
    await expect(
      loadProviderModule({
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
        exportName: "createEmbeddingProvider",
        slot: "embeddings",
      }),
    ).rejects.toThrow(/createEmbeddingProvider/);
  });

  it("refuses a malformed provider BEFORE it is used", async () => {
    const { dir, file } = fixture(
      `export function createEmbeddingProvider() { return { id: "x", dimensions: -1 }; }`,
    );
    await expect(
      loadProviderModule({
        modulePath: file,
        configDir: dir,
        securityProfile: "trusted-local",
        exportName: "createEmbeddingProvider",
        slot: "embeddings",
      }),
    ).rejects.toThrow(/embed|dimensions/);
  });

  it("loads a well-formed module under trusted-local", async () => {
    const { dir, file } = fixture(GOOD);
    const p = await loadProviderModule<{ dimensions: number }>({
      modulePath: file,
      configDir: dir,
      securityProfile: "trusted-local",
      exportName: "createEmbeddingProvider",
      slot: "embeddings",
    });
    expect(p.dimensions).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun run test:local test/provider-module-gate.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/module-loader'`

- [ ] **Step 3: Write the loader**

```ts
// packages/server/src/providers/module-loader.ts
// The escape hatch. A config file that names code to import is a real capability, so it is gated
// on the SAME securityProfile the rest of the server uses rather than a second trust axis that
// could disagree with it.
//
// The gate is `hardened` refuses, `trusted-local` allows: config.json already holds vault paths,
// API keys and the JWT secret, so whoever can write it already owns this process.
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";

export interface LoadProviderModuleOpts {
  modulePath: string;
  /** Directory of the loaded config file — the trust root. Undefined when the config was derived
   *  from a vault path rather than a file, in which case there is nothing to resolve against. */
  configDir: string | undefined;
  securityProfile: "hardened" | "trusted-local" | undefined;
  exportName: "createEmbeddingProvider" | "createReranker";
  slot: "embeddings" | "reranker";
}

/** Structural check at the boundary. A malformed provider that reaches the indexer surfaces as a
 *  confusing failure deep in a batch; refusing here turns it into one clear boot error. */
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
  const profile = opts.securityProfile ?? "trusted-local";
  if (profile === "hardened") {
    throw err.invalidInput(
      `${opts.slot}.provider "module" is refused under securityProfile "hardened"`,
      {
        modulePath: opts.modulePath,
        hint: `loading a provider module executes code named by config.json. Use a declarative provider (e.g. openai-compatible) under the hardened posture, or set securityProfile to "trusted-local" if this host really is single-user.`,
      },
    );
  }
  if (!opts.configDir && !isAbsolute(opts.modulePath)) {
    throw err.invalidInput(
      `${opts.slot}.modulePath is relative but there is no config file directory to resolve it against`,
      {
        modulePath: opts.modulePath,
        hint: "a relative modulePath resolves against the config file's directory; this server was started without a config file, so give an absolute path.",
      },
    );
  }
  // The config DIRECTORY is the trust root, never process.cwd() — cwd in a container is arbitrary.
  const abs = isAbsolute(opts.modulePath)
    ? opts.modulePath
    : resolve(opts.configDir as string, opts.modulePath);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (cause) {
    throw err.invalidInput(`${opts.slot}.modulePath could not be imported`, {
      modulePath: opts.modulePath,
      resolved: abs,
      hint: `${(cause as Error).message}`,
    });
  }
  const factory = mod[opts.exportName];
  if (typeof factory !== "function") {
    throw err.invalidInput(
      `${opts.slot}.modulePath does not export ${opts.exportName}`,
      {
        modulePath: opts.modulePath,
        resolved: abs,
        hint: `export a function named ${opts.exportName} from that module`,
      },
    );
  }
  const built = (factory as () => unknown)();
  assertUsable(built, opts);
  return built as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun run test:local test/provider-module-gate.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Thread `configDir` and `securityProfile` into the wiring**

`tool-wiring.ts` already carries `configPath: string | undefined` (line 164). In `wireGatewaySeams`,
derive `configDir` with `configPath ? dirname(configPath) : undefined` and pass it, along with
`config.securityProfile`, in the `ResolveContext` handed to `resolveReranker`. Do the same for the
embeddings resolve in `runtime/indexing-wiring.ts:99`.

Because `loadProviderModule` is async while `createEmbeddingProvider` is sync, register the
`module` entry so the *await* happens in the wiring layer, not inside the sync factory: add
`resolveEmbeddingsAsync(cfg, ctx)` to `registry.ts` that awaits the module entry and delegates to
the sync path for every other name. Call the async variant from the two boot wiring sites only.

- [ ] **Step 6: Register the `module` entries and re-run every provider test**

Run: `cd packages/server && bun run test:local test/provider-registry-backcompat.test.ts test/provider-registry-unknown-name.test.ts test/provider-wire-body-invariant.test.ts test/provider-api-key-env.test.ts test/reranker-slot-wiring.test.ts test/provider-manifest-passthrough.test.ts test/provider-module-gate.test.ts`
Expected: PASS. Update the two name-list assertions (Tasks 1 and 5) to include `"module"`.

- [ ] **Step 7: Commit**

```bash
cd ../.. && bun run config:schema
git add packages/server/src/providers/module-loader.ts packages/server/src/providers/registry.ts \
        packages/server/src/runtime/tool-wiring.ts packages/server/src/runtime/indexing-wiring.ts \
        docs/obsidian-tc.config.schema.json packages/server/test/
git commit -s -m "feat: add the profile-gated module provider escape hatch

Four boot-time refusals, each asserted: the hardened profile, a relative path
with no config file to resolve against, a missing export, and a malformed
provider rejected before first use. Gated on the existing securityProfile
rather than a new flag, since a second trust axis can disagree with the profile
and has no obvious resolution when it does.

modulePath resolves against the config file's directory, never process.cwd() --
cwd in a container is arbitrary."
```

---

## Final verification

- [ ] **Run the full gate set the CI lint job runs**

```bash
cd ~/obsidian-tc
bun run lint > /tmp/lint.log 2>&1; echo "biome=$?"
bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"
for g in check:boundaries check:dev-dep-imports check:config-paths check:duplicate-exports \
         check:duplication check:export-surface check:facade-parity; do
  bun run "$g" > "/tmp/${g//:/-}.log" 2>&1; echo "$g=$?"
done
bun run config:schema:check > /tmp/css.log 2>&1; echo "config:schema:check=$?"
```

Expected: every line `=0`. Note `bun run lint` is **biome only** — the gates above are separate CI steps despite the confusingly similar job name.

- [ ] **Push and run real CI**

```bash
git push -u origin mislam2/pluggable-provider-slots-spec
gh workflow run ci-server.yml --ref mislam2/pluggable-provider-slots-spec
```

Three OSes, free for a public repo. Do not substitute a local full-suite run — this box is 4 cores under ~43 containers.

- [ ] **Confirm the gate coverage caveat is honoured**

`check:config-threading` **cannot** catch a declared-but-unread key here: it exempts generic
identifiers, and its own comment names `model` and `enabled`. Of the keys this plan adds,
`apiKeyEnv`, `modulePath`, `revision` and `pooling` are distinctive enough to be caught, but
`reranker.provider`, `reranker.model` and `reranker.baseUrl` are not. Verify by inspection that
each has a test proving it reaches a consumer: `provider` and `baseUrl` in Task 5's wiring test,
`model` in the same test's body assertion.

---

## Self-review notes

**Spec coverage.** Per-slot registry → Task 1. Open provider string → Task 2. Generic
`openai-compatible` + wire invariants + baseUrl contract → Task 3. `apiKeyEnv` → Task 4.
`RerankerConfigSchema` + `cohere-compatible` + wiring precedence → Task 5. Manifest passthrough →
Task 6. Module gate → Task 7. The spec's `tei` registry entry is **deliberately deferred**: the
existing `model/tei.ts` client is already reachable through `model-tier`, and exposing it as a
standalone name adds a third baseUrl convention to document without enabling anything new. Raise it
as a follow-up rather than smuggling it into Task 3.

**Spec correction carried into Task 6.** The spec called this "manifest passthrough". Checking the
tree during plan self-review showed `RepresentationManifest` has no production producer at all, and
that the live mechanism is `VecFingerprint` — which already supports `revision` but is never given
one, at either of its two construction sites. Task 6 was rewritten against that reality and the
spec was corrected to match. `pooling` is descriptive-only until the manifest gains a producer, and
the schema description says so rather than implying an effect it does not have.

**Placeholder scan.** No `TBD`/`TODO`. Two steps intentionally instruct the implementer to *find*
call sites with a given `rg` command (Task 6 Step 5, Task 5 Step 7) rather than listing them — the
command is exact and its output is the list, which is more reliable than a list that can go stale
between planning and execution.

**Type consistency.** `resolveEmbeddings` / `embeddingsProviderNames` / `embeddingsEntry`
(Task 1) · `assertBaseUrlNotDuplicating` (Task 3, reused Task 5) · `resolveApiKey` third parameter
(Task 4, consumed by Task 5's reranker entry) · `resolveReranker` / `rerankerProviderNames`
(Task 5) · `loadProviderModule` (Task 7). The two name-list assertions in Tasks 1 and 5 are
explicitly updated in Task 3 Step 7 and Task 7 Step 6 as new entries land, so they never silently
drift.
