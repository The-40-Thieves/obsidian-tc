// THE-1122: "local" embeddings resolution — a deliberate structural MIRROR of registry.ts's
// "local" reranker ladder (LOCAL_RERANKER_PACKAGE / resolveSourceCheckoutLocalRerankerPath /
// resolveLocalRerankerModule / buildLocalReranker), not a shared implementation: the two optional
// packages (embedder-local, reranker-local) are independent, neither depends on the other or on
// packages/server, and each carries its OWN anchor file / package name / models directory. Split
// into its own module (not left inline in registry.ts) once adding it pushed that file over
// biome's 700-line cap — the same "third module, not new-imports-old" split registry.ts's own
// header references for reranker-preflight.ts. Comment density here is intentionally lighter than
// the reranker ladder; the reasoning for every design choice (why a ladder, why
// never-throws-on-resolution-failure, why the source-checkout walk is bounded and
// node_modules-aware) is identical and already spelled out there.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { EmbeddingProvider } from "../embeddings/provider";
import { isUnderNodeModules, type SourceCheckoutResolution } from "./local-package-resolution";
import type { EmbeddingsConfigLike, ResolveContext } from "./types";

const LOCAL_EMBEDDER_PACKAGE = "@the-40-thieves/obsidian-tc-embedder-local";

function isEmbedderLocalAnchor(packageJsonPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return pkg.name === LOCAL_EMBEDDER_PACKAGE;
  } catch {
    return false;
  }
}

export function resolveSourceCheckoutLocalEmbedderPath(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): SourceCheckoutResolution {
  if (isUnderNodeModules(startDir)) {
    return {
      path: join(startDir, "..", "..", "..", "embedder-local", "dist", "index.js"),
      skippedReason: "skipped: running from node_modules",
      candidates: [],
    };
  }
  const MAX_LEVELS = 6;
  const candidates: string[] = [];
  let dir = startDir;
  for (let i = 0; i < MAX_LEVELS; i++) {
    candidates.push(dir);
    const anchor = join(dir, "packages", "embedder-local", "package.json");
    if (existsSync(anchor) && isEmbedderLocalAnchor(anchor)) {
      return { path: join(dir, "packages", "embedder-local", "dist", "index.js"), candidates };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    path: join(startDir, "..", "..", "..", "embedder-local", "dist", "index.js"),
    candidates,
  };
}

const {
  path: EMBEDDER_SOURCE_CHECKOUT_PATH,
  skippedReason: EMBEDDER_SOURCE_CHECKOUT_SKIPPED_REASON,
  candidates: EMBEDDER_SOURCE_CHECKOUT_WALK_CANDIDATES,
} = resolveSourceCheckoutLocalEmbedderPath();

export interface LocalEmbedderCreateOpts {
  /** Catalog name (embeddings.model) — see packages/embedder-local's model-info.ts. Undefined ->
   *  the package's own DEFAULT_MODEL_NAME. */
  model?: string;
  quantized?: boolean;
  threads?: number;
  /** The DIRECTORY the package fetches/verifies its pinned weights under, per catalog entry
   *  (`<modelsRoot>/<modelId>/<revision>/`) — see model-fetch.ts's modelDirFor. Optional in the
   *  package's own contract (defaults to its own `models/` dir); registry.ts's production build
   *  always passes one explicitly (under the server's cacheDir), so this is optional here only to
   *  match the real signature for direct-module tests. */
  modelsRoot?: string;
}

/** Structural shape only — see resolveLocalRerankerModule's comment above for why this is declared
 *  rather than imported. `embed`/`embedFull` mirror EmbeddingProvider's own shape exactly (dense-
 *  only: embedder-local never implements embedFull). */
interface LocalEmbedderModule {
  createEmbeddingProvider(
    opts: LocalEmbedderCreateOpts,
    // Test-injection point only (embedder-local's own session loader override) — production
    // callers here never pass it, mirroring LocalRerankerModule's second `loadSessionFn` param.
    loadSessionFn?: (...args: never[]) => Promise<unknown>,
  ): {
    id: string;
    model: string;
    dimensions: number;
    embed(texts: string[], opts?: unknown): Promise<number[][]>;
  };
}

export type LocalEmbedderResolutionRoute = "localModulePath" | "bare-specifier" | "source-checkout";

export interface LocalEmbedderResolutionAttempt {
  route: LocalEmbedderResolutionRoute;
  target: string;
  ok: boolean;
  error?: string;
}

export interface LocalEmbedderResolution {
  ok: boolean;
  mod?: LocalEmbedderModule;
  attempts: LocalEmbedderResolutionAttempt[];
}

/** Never throws — resolution failure is reported structurally, exactly as
 *  resolveLocalRerankerModule's contract. `localModulePath` reuses reranker's convention: an
 *  explicit path, resolved against `ctx.configDir` when relative. THE-1122's schema does not
 *  currently expose `embeddings.localModulePath` as a config key (unlike the reranker's), since the
 *  ticket scope keeps this to a closed catalog with no per-deployment override surface — this
 *  route exists for parity/tests and future use, reachable only via a `ProviderDescriptor`-shaped
 *  test double today. */
export async function resolveLocalEmbedderModule(
  c: { localModulePath?: string },
  ctx: ResolveContext,
  importModule: (specifier: string) => Promise<unknown> = (s) => import(s),
): Promise<LocalEmbedderResolution> {
  const attempts: LocalEmbedderResolutionAttempt[] = [];
  const record = (route: LocalEmbedderResolutionRoute, target: string, error: unknown): void => {
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
      const mod = (await importModule(pathToFileURL(abs).href)) as LocalEmbedderModule;
      attempts.push({ route: "localModulePath", target: abs, ok: true });
      return { ok: true, mod, attempts };
    } catch (e) {
      record("localModulePath", abs, e);
    }
  }

  try {
    const mod = (await importModule(LOCAL_EMBEDDER_PACKAGE)) as LocalEmbedderModule;
    attempts.push({ route: "bare-specifier", target: LOCAL_EMBEDDER_PACKAGE, ok: true });
    return { ok: true, mod, attempts };
  } catch (e) {
    record("bare-specifier", LOCAL_EMBEDDER_PACKAGE, e);
  }

  if (EMBEDDER_SOURCE_CHECKOUT_SKIPPED_REASON) {
    record(
      "source-checkout",
      EMBEDDER_SOURCE_CHECKOUT_PATH,
      EMBEDDER_SOURCE_CHECKOUT_SKIPPED_REASON,
    );
  } else if (existsSync(EMBEDDER_SOURCE_CHECKOUT_PATH)) {
    try {
      const mod = (await importModule(
        pathToFileURL(EMBEDDER_SOURCE_CHECKOUT_PATH).href,
      )) as LocalEmbedderModule;
      attempts.push({ route: "source-checkout", target: EMBEDDER_SOURCE_CHECKOUT_PATH, ok: true });
      return { ok: true, mod, attempts };
    } catch (e) {
      record("source-checkout", EMBEDDER_SOURCE_CHECKOUT_PATH, e);
    }
  } else {
    record(
      "source-checkout",
      EMBEDDER_SOURCE_CHECKOUT_PATH,
      `not built — run "bun run build" in packages/embedder-local (searched for the monorepo root from: ${EMBEDDER_SOURCE_CHECKOUT_WALK_CANDIDATES.join(", ")})`,
    );
  }

  return { ok: false, attempts };
}

/** doctor-facing shape of a resolution attempt — mirrors probeLocalRerankerResolution exactly. */
export async function probeLocalEmbedderResolution(
  ctx: ResolveContext = {},
): Promise<{ ok: boolean; route?: string; attempts: string[] }> {
  const r = await resolveLocalEmbedderModule({}, ctx);
  return {
    ok: r.ok,
    route: r.attempts.find((a) => a.ok)?.route,
    attempts: r.attempts.map((a) =>
      a.ok ? `${a.route}: ${a.target} — resolved` : `${a.route}: ${a.target} — ${a.error}`,
    ),
  };
}

const DEFAULT_LOCAL_EMBEDDER_CACHE_ROOT = ".obsidian-tc";

/** embeddings.provider "local" — exported so it is directly unit-testable with an injected
 *  `resolveModule`, without needing @huggingface/transformers or real model weights present in
 *  packages/server's own test run.
 *
 *  SYNC, MANDATORY LAZY INIT: unlike the "local" reranker (which resolves its package at boot,
 *  async, but loads the model lazily inside the returned closure), this entry's `build` returns the
 *  full `EmbeddingProvider` OBJECT synchronously — id/provider/model/dimensions come straight from
 *  `c`/`c.dimensions`, exactly like every other entry in this map. BOTH the package resolution
 *  (dynamic `import()`, inherently async) and the model download/load are deferred into the closure
 *  `embed()` captures, invoked on its first real call. This is what lets `embeddings.provider:
 *  "local"` work from the SYNC `resolveEmbeddings`/`createEmbeddingProvider` path that eval/run.ts
 *  and every CLI command already use — unlike embeddings.provider "module", it is NOT `asyncOnly`.
 *
 *  A resolution or download/load failure surfaces as a REJECTED `embed()` promise, not a thrown
 *  `build()` — this repo already has a graceful-degradation path for exactly that shape (a dead
 *  Ollama endpoint's embed() throwing ECONNREFUSED degrades the boot reconcile with a logged
 *  warning rather than crashing boot; see reference_obsidian_tc_has_no_embeddings_off_switch), so
 *  "local" unresolvable/unsupported-platform degrades the same way rather than needing new
 *  machinery. `obsidian-tc doctor`'s dense probe (createQueryEncoder) and
 *  buildLocalEmbedderDoctorProbe below are what keep that failure LOUD instead of silently
 *  identical to "embeddings not configured". */
export function buildLocalEmbeddingProvider(
  c: EmbeddingsConfigLike,
  ctx: ResolveContext = {},
  resolveModule: (
    c: { localModulePath?: string },
    ctx: ResolveContext,
  ) => Promise<LocalEmbedderResolution> = resolveLocalEmbedderModule,
): EmbeddingProvider {
  const ignored = (
    [
      ["baseUrl", c.baseUrl],
      ["apiKey", c.apiKey],
      ["apiKeyEnv", c.apiKeyEnv],
      ["modulePath", c.modulePath],
      ["modelTier", c.modelTier],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (ignored.length > 0) {
    throw err.invalidInput(
      `embeddings.provider "local" does not read ${ignored.map((k) => `embeddings.${k}`).join(", ")}`,
      {
        provider: "local",
        ignored,
        hint: "the local embedder sources its model from the bundled @the-40-thieves/obsidian-tc-embedder-local package's own pinned catalog (embeddings.model selects among it) — remove these fields.",
      },
    );
  }
  const modelsRoot = join(
    ctx.cacheDir ?? DEFAULT_LOCAL_EMBEDDER_CACHE_ROOT,
    "models",
    "embedder-local",
  );
  let pending: Promise<{ embed(texts: string[], opts?: unknown): Promise<number[][]> }> | undefined;
  const session = (): Promise<{ embed(texts: string[], opts?: unknown): Promise<number[][]> }> => {
    if (!pending) {
      pending = (async () => {
        const resolution = await resolveModule(c, ctx);
        if (!resolution.ok) {
          for (const a of resolution.attempts) {
            console.error(
              `embeddings "local": ${a.route} (${a.target}) did not resolve — ${a.error ?? "unknown error"}`,
            );
          }
          throw err.embeddingProviderError(
            `embeddings.provider "local" could not resolve the optional ${LOCAL_EMBEDDER_PACKAGE} package`,
            {
              attempts: resolution.attempts,
              hint: 'run "bun run build" in packages/embedder-local (source checkouts), or `bun add`/`bun link` the published package once it exists — see "obsidian-tc doctor" for the full attempt list.',
            },
          );
        }
        return resolution.mod?.createEmbeddingProvider({
          model: c.model,
          quantized: c.quantized,
          threads: c.threads,
          modelsRoot,
        });
      })() as Promise<{ embed(texts: string[], opts?: unknown): Promise<number[][]> }>;
      // Don't memoize a rejection — a transient failure (package not yet built, model not yet
      // downloadable) must not permanently wedge the provider if the operator fixes it and the
      // process keeps running (e.g. `bun run build` completes mid-session, or network returns).
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
  return {
    id: `local:${c.model}`,
    provider: "local",
    model: c.model,
    dimensions: c.dimensions,
    embed: async (texts, opts) => {
      const s = await session();
      return s.embed(texts, opts);
    },
  };
}

/** doctor-facing probe: whether "local" is buildable right now, independent of whether it is
 *  actually configured (used both when `embeddings.provider === "local"` explicitly and, since it
 *  is also the SCHEMA default, whenever the block is absent). */
export function buildEmbeddingsDoctorProbes(opts: {
  embeddingsProvider?: string;
  configDir?: string;
  cacheDir?: string;
}): { probeLocalEmbedder?: () => Promise<{ ok: boolean; route?: string; attempts: string[] }> } {
  if (opts.embeddingsProvider !== "local") return {};
  const ctx = { configDir: opts.configDir, cacheDir: opts.cacheDir };
  return { probeLocalEmbedder: () => probeLocalEmbedderResolution(ctx) };
}
