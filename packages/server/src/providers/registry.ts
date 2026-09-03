// The single resolution point for both provider slots. Adding a model is adding a row to a map.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { EmbeddingProvider } from "../embeddings/provider";
import { resolveApiKey } from "../embeddings/provider";
import {
  bgeM3Provider,
  cohereProvider,
  ollamaProvider,
  openaiProvider,
  voyageProvider,
} from "../embeddings/providers";
import { createGatewayClient } from "../gateway/client";
import { buildModelTierProvider, buildModelTierReranker } from "../model";
import { compileEgressFilter } from "../plane/egress-filter";
import { guardReranker, type Reranker } from "../search/rerank";
import { openAiCompatibleProvider } from "./http-embeddings";
import { cohereCompatibleReranker } from "./http-rerank";
import { loadProviderModule } from "./module-loader";
import type {
  EmbeddingsConfigLike,
  EmbeddingsEntry,
  ProviderDescriptor,
  RerankerEntry,
  ResolveContext,
} from "./types";

function adapterOpts(cfg: EmbeddingsConfigLike, ctx: ResolveContext) {
  return {
    model: cfg.model,
    dimensions: cfg.dimensions,
    baseUrl: cfg.baseUrl,
    apiKey: resolveApiKey(cfg.provider, cfg.apiKey, cfg.apiKeyEnv),
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
  // THE-837: DEPRECATED, and deliberately still fully functional. obsidian-tc is provider-agnostic
  // — this entry is a built-in for one vendor whose wire format the generic `openai-compatible`
  // adapter can already serve, since Ollama exposes /v1/embeddings (OpenAI-shaped, middleware over
  // the same handler as /api/embed). What it CANNOT do is change `provider.id`, which this repo
  // stores in chunk_embeddings.model and uses as the vec-index fingerprint. Retiring `ollama:` is
  // therefore a whole-vault re-embed for every existing user, so the deletion is a major-version
  // change with a migration note and gets its own ticket. The notice ships first so operators hear
  // it before the release, not with it.
  ollama: {
    appendsPath: "/api/embed",
    deprecated:
      "the `ollama` built-in is deprecated; `openai-compatible` against http://<host>:11434/v1 " +
      "serves the same endpoint. Do NOT switch yet without planning a re-index: provider.id is " +
      "the vec-index fingerprint, so changing it re-embeds the whole vault.",
    build: (c, x) => ollamaProvider(adapterOpts(c, x)),
  },
  openai: { appendsPath: "/embeddings", build: (c, x) => openaiProvider(adapterOpts(c, x)) },
  voyage: { appendsPath: "/embeddings", build: (c, x) => voyageProvider(adapterOpts(c, x)) },
  cohere: { appendsPath: "/embed", build: (c, x) => cohereProvider(adapterOpts(c, x)) },
  "bge-m3": { appendsPath: "/embeddings", build: (c, x) => bgeM3Provider(adapterOpts(c, x)) },
  "openai-compatible": {
    appendsPath: "/embeddings",
    build: (c, x) => openAiCompatibleProvider(adapterOpts(c, x)),
  },
  "model-tier": {
    // "" — this entry does NOT consume the descriptor's top-level baseUrl at all;
    // buildModelTierProvider reads cfg.modelTier.{dense,full}.baseUrl instead. A non-empty
    // appendsPath here made the duplicate-segment guard fire on a baseUrl the adapter never reads,
    // then stay silently ignored even after the operator "fixed" it (deferred Minor from an
    // earlier task; see assertBaseUrlNotDuplicating's appendsPath === "" branch below).
    appendsPath: "",
    ownsPrefixing: true,
    build: (c, x) => buildModelTierProvider(c, { fetchFn: x.fetchFn }),
  },
  // The profile-gated escape hatch — see module-loader.ts's header comment. asyncOnly: true means
  // the sync `build` below is never actually called on a correctly-wired path; it exists only so
  // resolveEmbeddings' asyncOnly guard has something to refuse BEFORE reaching it (a documented
  // invariant, not a reachable code path).
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
        modulePath: c.modulePath ?? "",
        configDir: x.configDir,
        securityProfile: x.securityProfile,
        exportName: "createEmbeddingProvider",
        slot: "embeddings",
        // THE-677: the module must not claim a built-in's identity. Computed from EMBEDDINGS minus
        // "module" itself — deriving it from the map means a provider added later is reserved
        // automatically, rather than from a hand-kept list that would silently go stale.
        reservedProviderNames: embeddingsProviderNames().filter((n) => n !== "module"),
      }),
  },
};

/** Sorted so the unknown-name error message is stable and diffable. */
export function embeddingsProviderNames(): string[] {
  return Object.keys(EMBEDDINGS).sort();
}

/** THE-837: the deprecation notice for a provider name, or undefined.
 *
 *  A pure map read, and that is the requirement rather than an implementation detail: doctor is
 *  offline by construction (THE-688 fix 2 — diagnosing must not acquire a side effect just because
 *  someone ran it), so reading this metadata must not go anywhere near `build`. An unknown name
 *  returns undefined rather than throwing; whether the name is valid at all is
 *  `embeddingsEntryOrThrow`'s job, and a doctor run must not die on a bad config value it is
 *  supposed to be reporting. */
export function embeddingsDeprecation(name: string): string | undefined {
  return EMBEDDINGS[name]?.deprecated;
}

/**
 * Refuse a baseUrl whose trailing segments already contain the path the entry appends.
 *
 * The adapters do NOT agree on what baseUrl means — openAiStyle appends "/embeddings" to a base
 * carrying "/v1", while model/tei.ts appends "/v1/embeddings" to a bare root. Refusing rather than
 * silently stripping is deliberate: stripping hides that the operator is on the wrong convention.
 */
export function assertBaseUrlNotDuplicating(
  baseUrl: string | undefined,
  appendsPath: string,
  slot: "embeddings" | "reranker",
): void {
  // An empty appendsPath means "this entry does not consume the descriptor's baseUrl at all"
  // (e.g. model-tier, which sources its endpoint(s) from a nested modelTier block) — there is
  // nothing for a top-level baseUrl to duplicate, so this guard has nothing to check.
  if (appendsPath === "") return;
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
  cfg: EmbeddingsConfigLike,
  ctx: ResolveContext = {},
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

/** Async resolution — the only path that can build an asyncOnly (module) entry. Boot-wiring only;
 *  CLI/eval entry points call the synchronous `resolveEmbeddings` above and get an actionable
 *  refusal instead of silently needing to become async themselves. */
export async function resolveEmbeddingsAsync(
  cfg: EmbeddingsConfigLike,
  ctx: ResolveContext = {},
): Promise<{ provider: EmbeddingProvider; entry: EmbeddingsEntry }> {
  const entry = embeddingsEntryOrThrow(cfg.provider);
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "embeddings");
  if (entry.buildAsync) return { provider: await entry.buildAsync(cfg, ctx), entry };
  return { provider: entry.build(cfg, ctx), entry };
}

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
  //
  // appendsPath "" — see assertBaseUrlNotDuplicating's comment: this entry never reads the
  // descriptor's baseUrl at all (nor model/apiKey/apiKeyEnv/timeoutMs), so it refuses to build if
  // an operator sets any of them — a loud boot error instead of a silently discarded field.
  "model-tier": {
    appendsPath: "",
    build: async (c, x) => {
      const ignored = (
        [
          ["model", c.model],
          ["baseUrl", c.baseUrl],
          ["apiKey", c.apiKey],
          ["apiKeyEnv", c.apiKeyEnv],
          ["timeoutMs", c.timeoutMs],
        ] as const
      )
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      if (ignored.length > 0) {
        throw err.invalidInput(
          `reranker.provider "model-tier" does not read ${ignored.map((k) => `reranker.${k}`).join(", ")}`,
          {
            provider: "model-tier",
            ignored,
            hint: "model-tier sources its model, endpoint and auth from embeddings.modelTier.full.* — remove these reranker fields (or configure embeddings.modelTier.full if you have not).",
          },
        );
      }
      return x.embeddings ? buildModelTierReranker(x.embeddings, { fetchFn: x.fetchFn }) : null;
    },
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
          // THE-934 fix round 1 (I2): the PORT guard — every gateway client this registry
          // constructs is guarded, unconditionally.
          excludeFilter: x.excludeFilter,
        });
      } catch {
        return null; // no base URL configured -> graceful no-op, as today
      }
      return (q, docs, topN, sourcePaths) =>
        gw.rerank({ query: q, documents: docs, topN, sourcePaths }).then((r) => r.results);
    },
  },
  // The profile-gated escape hatch — see module-loader.ts's header comment. Unlike the embeddings
  // entry above, RerankerEntry.build is already async, so there is no sync/asyncOnly split to make
  // here.
  module: {
    appendsPath: "",
    build: (c, x) =>
      loadProviderModule<Reranker>({
        modulePath: c.modulePath ?? "",
        configDir: x.configDir,
        securityProfile: x.securityProfile,
        exportName: "createReranker",
        slot: "reranker",
        // Inert for this slot today (a reranker module returns a bare function, so it declares no
        // identity), but passed for symmetry so the two entries cannot drift if that changes.
        reservedProviderNames: rerankerProviderNames().filter((n) => n !== "module"),
      }),
  },
  // THE-705 item 1: a bundled, fully offline cross-encoder — reachable with no
  // OBSIDIAN_TC_GATEWAY_URL and no bge-m3-service. appendsPath "" for the same reason as
  // model-tier: this entry reads none of the descriptor's model/baseUrl/apiKey/apiKeyEnv/timeoutMs,
  // only reranker.localModelPath / reranker.localModulePath (see buildLocalReranker below).
  local: {
    appendsPath: "",
    // THE-944 review round 1 (F3): forwards ctx.resolveLocalRerankerModule (test-only; see
    // types.ts's ResolveContext field for why it's loosely typed there) as buildLocalReranker's
    // own `resolveModule` override, so a DECLARED "local" block can be tested deterministically
    // too, not just the auto-select path — a real caller never sets this field, so this is a no-op
    // cast to `undefined` in production, falling through to buildLocalReranker's own default (the
    // real resolveLocalRerankerModule ladder).
    build: (c, x) =>
      buildLocalReranker(
        c,
        x,
        x.resolveLocalRerankerModule as
          | ((c: ProviderDescriptor, ctx: ResolveContext) => Promise<LocalRerankerResolution>)
          | undefined,
      ),
  },
};

/** The npm package name of the optional local-reranker workspace package. A named CONSTANT, not a
 *  string literal at the `import()` call site below: TypeScript only attempts to resolve a literal
 *  specifier's module/type declarations for a dynamic import, so keeping it in a variable means
 *  `packages/server` typechecks whether or not the optional package is installed — it is never a
 *  dependency of packages/server (see the package's own README for why: this is what keeps it out
 *  of every `bun install` at the repo root). */
const LOCAL_RERANKER_PACKAGE = "@the-40-thieves/obsidian-tc-reranker-local";

/** THE-705 round 2 (adversarial review, confirmed finding 1): the bare specifier above cannot
 *  resolve from packages/server under ANY setup this repo actually supports today — the package is
 *  not a root workspace member (deliberately, see its README), is not on any node_modules path
 *  packages/server searches, and is not yet published to npm. Route (iii) below is what makes a
 *  SOURCE CHECKOUT of this monorepo actually work: `packages/server/src/providers/registry.ts` ->
 *  up three (`providers` -> `src` -> `server`) lands at `packages/`, then into the sibling
 *  package's build output. Computed once, not per-call, since `import.meta.url` is a module-eval
 *  constant. */
const SOURCE_CHECKOUT_LOCAL_RERANKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "reranker-local",
  "dist",
  "index.js",
);

/** The shape `LOCAL_RERANKER_PACKAGE`'s default export surface must have. Declared here rather than
 *  imported — importing the package's real types would require it to resolve at typecheck time,
 *  defeating the point of the dynamic import above.
 *
 *  The optional second parameter on `createReranker` is NOT part of this package's production
 *  contract — it is reranker-local's own test-injection point (see its src/index.ts), declared here
 *  only so a test resolving through THIS registry's real ladder can still inject a stubbed session
 *  loader (no @huggingface/transformers, no model weights) without an `any` cast past this
 *  interface. Production callers (buildLocalReranker below) never pass it. */
interface LocalRerankerModule {
  createReranker(
    opts: { localModelPath?: string },
    loadSessionFn?: (...args: never[]) => Promise<unknown>,
  ): Reranker;
}

export type LocalRerankerResolutionRoute = "localModulePath" | "bare-specifier" | "source-checkout";

export interface LocalRerankerResolutionAttempt {
  route: LocalRerankerResolutionRoute;
  target: string;
  ok: boolean;
  error?: string;
}

export interface LocalRerankerResolution {
  ok: boolean;
  mod?: LocalRerankerModule;
  /** One entry per route actually tried, in order, whether it succeeded or not — this is the
   *  "each logged when it fails" record: buildLocalReranker below turns every failing entry into a
   *  console.error at resolution time, and doctor/checks.ts's rerankerBuildableCheck surfaces the
   *  same list as the remediation text, so the boot log and doctor can never disagree about why. */
  attempts: LocalRerankerResolutionAttempt[];
}

/**
 * THE-705 round 2: the resolution LADDER, tried in order until one succeeds. Never throws —
 * resolution failure is reported structurally (`ok: false` + `attempts`), because whether the
 * optional package is resolvable on THIS deployment is an environment-availability question, not a
 * config-correctness one (see buildLocalReranker's header for why that distinction matters for boot
 * safety). Exported and given an injectable `importModule` so both this module's own callers and
 * tests can exercise the ladder without a real dynamic import.
 *
 *   (i)   `reranker.localModulePath` — an explicit path to the module's built entry file, absolute
 *         or resolved against `ctx.configDir` (same convention as `reranker.modulePath`). The
 *         escape hatch for every deployment shape routes (ii)/(iii) don't cover: an npm-installed
 *         server pointed at a reranker-local checkout that lives somewhere else, a container image
 *         that vendors the built package at a fixed path, etc.
 *   (ii)  the bare package specifier, `LOCAL_RERANKER_PACKAGE` — works once the package is
 *         published to npm and `bun add`ed, or `bun link`ed locally.
 *   (iii) `SOURCE_CHECKOUT_LOCAL_RERANKER_PATH` — works out of the box for anyone developing INSIDE
 *         this monorepo, once `packages/reranker-local` has been built (`bun run build` there).
 *         Guarded by `existsSync` first so a not-yet-built checkout fails fast into "not found"
 *         instead of a resolver error, and so failing THIS route never masks whichever error a real
 *         resolution attempt would have produced.
 */
export async function resolveLocalRerankerModule(
  c: ProviderDescriptor,
  ctx: ResolveContext,
  importModule: (specifier: string) => Promise<unknown> = (s) => import(s),
): Promise<LocalRerankerResolution> {
  const attempts: LocalRerankerResolutionAttempt[] = [];
  const record = (route: LocalRerankerResolutionRoute, target: string, error: unknown): void => {
    attempts.push({
      route,
      target,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  if (c.localModulePath) {
    const abs = isAbsolute(c.localModulePath)
      ? c.localModulePath
      : resolvePath(ctx.configDir ?? process.cwd(), c.localModulePath);
    try {
      const mod = (await importModule(pathToFileURL(abs).href)) as LocalRerankerModule;
      attempts.push({ route: "localModulePath", target: abs, ok: true });
      return { ok: true, mod, attempts };
    } catch (e) {
      record("localModulePath", abs, e);
    }
  }

  try {
    const mod = (await importModule(LOCAL_RERANKER_PACKAGE)) as LocalRerankerModule;
    attempts.push({ route: "bare-specifier", target: LOCAL_RERANKER_PACKAGE, ok: true });
    return { ok: true, mod, attempts };
  } catch (e) {
    record("bare-specifier", LOCAL_RERANKER_PACKAGE, e);
  }

  if (existsSync(SOURCE_CHECKOUT_LOCAL_RERANKER_PATH)) {
    try {
      const mod = (await importModule(
        pathToFileURL(SOURCE_CHECKOUT_LOCAL_RERANKER_PATH).href,
      )) as LocalRerankerModule;
      attempts.push({
        route: "source-checkout",
        target: SOURCE_CHECKOUT_LOCAL_RERANKER_PATH,
        ok: true,
      });
      return { ok: true, mod, attempts };
    } catch (e) {
      record("source-checkout", SOURCE_CHECKOUT_LOCAL_RERANKER_PATH, e);
    }
  } else {
    record(
      "source-checkout",
      SOURCE_CHECKOUT_LOCAL_RERANKER_PATH,
      'not built — run "bun run build" in packages/reranker-local',
    );
  }

  return { ok: false, attempts };
}

/** THE-679/THE-944: the doctor-facing shape of a resolution attempt — shared by BOTH the explicit
 *  `reranker.provider: "local"` probe and the THE-944 auto-select probe (cli/commands/doctor.ts's
 *  two `rerankerBuildable.probe*` closures), so the two never duplicate (and cannot drift on) the
 *  route/attempts-to-string mapping doctor/checks.ts's `LocalRerankerProbeResult` expects. */
export async function probeLocalRerankerResolution(
  c: ProviderDescriptor,
  ctx: ResolveContext,
): Promise<{ ok: boolean; route?: string; attempts: string[] }> {
  const r = await resolveLocalRerankerModule(c, ctx);
  return {
    ok: r.ok,
    route: r.attempts.find((a) => a.ok)?.route,
    attempts: r.attempts.map((a) =>
      a.ok ? `${a.route}: ${a.target} — resolved` : `${a.route}: ${a.target} — ${a.error}`,
    ),
  };
}

/** reranker.provider "local" — exported (rather than inlined into the RERANKERS.local.build above)
 *  so it is directly unit-testable with an injected `resolveModule`, without needing
 *  @huggingface/transformers or the real model weights present in packages/server's own test run.
 *
 *  MANDATORY LAZY INIT: this function does exactly one thing at boot-resolution time — resolve
 *  (§resolveLocalRerankerModule) the small, transformers-free adapter package. It does NOT import
 *  @huggingface/transformers itself, and does NOT load the model. That happens inside the Reranker
 *  closure `mod.createReranker` returns, on its first invocation (see the package's own index.ts).
 *  So resolving `reranker.provider: "local"` at boot — even for a deployment that configures it but
 *  whose gatedRerank hardness gate never actually fires — costs only this resolution, not a model
 *  load.
 *
 *  NEVER THROWS ON RESOLUTION FAILURE (THE-705 round 2, confirmed finding 1). The first cut of this
 *  entry threw an actionable-looking error naming `bun add <package>` — dead advice, since the
 *  package is deliberately unpublishable-by-default and not a workspace dependency, so EVERY
 *  documented setup hit this throw, and nothing in runtime/tool-wiring.ts's `resolveDeclaredReranker`
 *  caught it: an operator setting `reranker.provider: "local"` got a hard boot crash, the opposite
 *  of "rerank reachable without a gateway". Resolution failure now returns `null` — the SAME
 *  contract `model-tier` and `gateway` already have for their own "prerequisite missing" case — and
 *  `resolveDeclaredReranker` treats a null `local` result as environment-unavailable rather than a
 *  config defect (see that function's own comment). `doctor/checks.ts`'s `rerankerBuildableCheck` is
 *  what keeps this failure LOUD instead of silently identical to "not configured".
 *
 *  The one thing that STILL throws here is a genuine config mistake — setting a field this provider
 *  does not read (`model`/`baseUrl`/`apiKey`/`apiKeyEnv`/`timeoutMs`/`modulePath`) — because that is
 *  deterministic and fixable by editing the config, unlike "is the package resolvable right now". */
export async function buildLocalReranker(
  c: ProviderDescriptor,
  ctx: ResolveContext = {},
  resolveModule: (
    c: ProviderDescriptor,
    ctx: ResolveContext,
  ) => Promise<LocalRerankerResolution> = resolveLocalRerankerModule,
): Promise<Reranker | null> {
  const ignored = (
    [
      ["model", c.model],
      ["baseUrl", c.baseUrl],
      ["apiKey", c.apiKey],
      ["apiKeyEnv", c.apiKeyEnv],
      ["timeoutMs", c.timeoutMs],
      ["modulePath", c.modulePath],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (ignored.length > 0) {
    throw err.invalidInput(
      `reranker.provider "local" does not read ${ignored.map((k) => `reranker.${k}`).join(", ")}`,
      {
        provider: "local",
        ignored,
        hint: "the local reranker sources its model from the bundled @the-40-thieves/obsidian-tc-reranker-local package, not these fields — remove them, or set reranker.localModulePath/localModelPath instead if you need a non-default location.",
      },
    );
  }
  const resolution = await resolveModule(c, ctx);
  if (!resolution.ok) {
    // THE-705 round 2's "each logged when it fails" — this is the one place in providers/ that
    // intentionally writes to the console: a boot-time throw is exactly what this code path must
    // NOT do (see this function's header comment), so a log line is the only way this failure
    // reaches an operator who isn't also running `doctor`.
    for (const a of resolution.attempts) {
      console.error(
        `reranker "local": ${a.route} (${a.target}) did not resolve — ${a.error ?? "unknown error"}`,
      );
    }
    return null;
  }
  return resolution.mod?.createReranker({ localModelPath: c.localModelPath }) ?? null;
}

/** Sorted so the unknown-name error message is stable and diffable. */
export function rerankerProviderNames(): string[] {
  return Object.keys(RERANKERS).sort();
}

export async function resolveReranker(
  cfg: ProviderDescriptor,
  ctx: ResolveContext = {},
): Promise<Reranker | null> {
  const entry = RERANKERS[cfg.provider];
  if (!entry) {
    throw err.invalidInput(`unknown reranker provider: ${cfg.provider}`, {
      provider: cfg.provider,
      hint: `set reranker.provider to one of: ${rerankerProviderNames().join(", ")}`,
    });
  }
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "reranker");
  const reranker = await entry.build(cfg, ctx);
  // THE-934 fix round 2 (N3): the reranker PORT guard, applied here regardless of WHICH of the
  // five entries built it — cohere-compatible and model-tier post full document text over HTTP
  // with no fail-closed backstop of their own (the `gateway` entry's own createGatewayClient guard
  // makes this a harmless double-wrap for that one entry, not a gap).
  return reranker ? guardReranker(reranker, ctx.excludeFilter ?? compileEgressFilter([])) : null;
}
