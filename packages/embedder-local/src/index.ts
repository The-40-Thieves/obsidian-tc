// THE-1122 item 1 — bundled local dense embedder for obsidian-tc's `embeddings.provider: "local"`.
//
// ZERO TOP-LEVEL IMPORT OF @huggingface/transformers. Same reasoning as
// packages/reranker-local/src/index.ts's header comment: obsidian-tc's cold-start perf gate
// measures module-evaluation cost, and packages/server's registry.ts dynamically imports THIS
// module even when embeddings.provider is "local" — so simply resolving the provider must not pay
// for loading the runtime or the model weights. Both are deferred to the first actual embed() call,
// memoized after that.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertVerified,
  fetchAndVerifyModel,
  modelDirFor,
  specFromModelInfo,
} from "./model-fetch.js";
import {
  catalogModelNames,
  DEFAULT_MODEL_NAME,
  dtypeFor,
  type EmbeddingModelInfo,
  modelInfoByName,
} from "./model-info.js";

export interface EmbedOptions {
  input?: "query" | "document";
  sourcePaths?: string[];
}

/** Structurally identical to packages/server/src/embeddings/provider.ts's `EmbeddingProvider` —
 *  NOT imported from there (would make packages/server -> embedder-local -> packages/server a
 *  cycle; TypeScript's structural typing means registry.ts's `local` entry is satisfied without
 *  either side importing the other's type). Dense-only: no `embedFull`. */
export interface EmbeddingProvider {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

export interface CreateEmbeddingProviderOpts {
  /** Catalog name — see model-info.ts's MODEL_CATALOG. Undefined -> DEFAULT_MODEL_NAME. */
  model?: string;
  /** Transformers.js dtype selection: true (default) -> the pinned q8 ONNX export, false -> the
   *  pinned fp32 export. Both variants are separately checksummed (model-info.ts). */
  quantized?: boolean;
  /** onnxruntime-node intra-op thread count. Undefined lets the runtime pick its own default. */
  threads?: number;
  /** Root directory the pinned weights are fetched/verified under
   *  (`<modelsRoot>/<modelId>/<revision>/`). Defaults to this package's own `models/` directory —
   *  packages/server's registry.ts always passes an explicit one under the server's `cacheDir`. */
  modelsRoot?: string;
}

export function defaultModelsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "models");
}

/** True when every pinned file for the given catalog entry (at the given precision) is present
 *  under `modelsRoot` — the presence-only signal doctor/preflight logic can use to decide
 *  "downloaded" vs "will fetch on first use", without importing @huggingface/transformers. */
export function weightsPresent(
  modelName: string = DEFAULT_MODEL_NAME,
  quantized = true,
  modelsRoot: string = defaultModelsDir(),
): boolean {
  const info = modelInfoByName(modelName);
  if (!info) return false;
  const spec = specFromModelInfo(info, quantized);
  const modelDir = modelDirFor(modelsRoot, spec);
  return spec.pinnedFiles.every((f) => existsSync(join(modelDir, f.path)));
}

// The dynamically-imported module's real types come from @huggingface/transformers, an OPTIONAL
// dependency this package's own TypeScript project does not require to be installed to typecheck.
// biome-ignore lint/suspicious/noExplicitAny: see reranker-local's index.ts for the same pattern.
type TransformersModule = any;

export interface Session {
  // biome-ignore lint/suspicious/noExplicitAny: Transformers.js's own tensor/output shape.
  extractor: (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<any>;
}

/** One memoized session per (modelsRoot, model, quantized, threads) tuple — a process only ever
 *  configures one in practice, but keying this way keeps tests (which construct several sessions
 *  with different options in one process) correct. A rejected load is NOT memoized — a transient
 *  failure (weights not yet downloadable, package not yet built) must not permanently wedge the
 *  embedder if the operator fixes it and retries without a process restart. */
const sessions = new Map<string, Promise<Session>>();

function sessionKey(
  opts: Required<Pick<CreateEmbeddingProviderOpts, "modelsRoot">> & {
    info: EmbeddingModelInfo;
    quantized: boolean;
    threads?: number;
  },
): string {
  return `${opts.modelsRoot}::${opts.info.name}::${opts.quantized}::${opts.threads ?? ""}`;
}

async function loadSession(
  info: EmbeddingModelInfo,
  modelsRoot: string,
  quantized: boolean,
  threads: number | undefined,
): Promise<Session> {
  const key = sessionKey({ modelsRoot, info, quantized, threads });
  let pending = sessions.get(key);
  if (!pending) {
    pending = (async (): Promise<Session> => {
      const spec = specFromModelInfo(info, quantized);
      // THE-1122 (mirrors THE-944): fetch-and-verify BEFORE importing @huggingface/transformers,
      // not after — a failed download/checksum must never reach the runtime import at all.
      const modelDir = await fetchAndVerifyModel(modelsRoot, spec);
      // Re-verify the FINAL directory immediately before use — closes the TOCTOU window between
      // fetchAndVerifyModel's own check and the pipeline() call below.
      await assertVerified(modelDir, spec);
      const transformersPackage = "@huggingface/transformers";
      // eslint-disable-next-line no-unsanitized/method -- transformersPackage is a variable, not a literal, so tsc need not resolve this optional dependency.
      const { pipeline, env } = (await import(transformersPackage)) as TransformersModule;
      env.allowRemoteModels = false;
      const sessionOptions =
        threads !== undefined
          ? { intraOpNumThreads: threads, interOpNumThreads: threads }
          : undefined;
      // `modelDir` is passed as `path_or_repo_id` directly, NOT env.localModelPath + a bare model
      // id — same reasoning as reranker-local's index.ts: Transformers.js treats a multi-slash
      // path_or_repo_id as a literal directory, which is what keeps this REVISION-scoped.
      const extractor = await pipeline("feature-extraction", modelDir, {
        dtype: dtypeFor(info, quantized),
        local_files_only: true,
        ...(sessionOptions ? { session_options: sessionOptions } : {}),
      });
      return { extractor };
    })();
    sessions.set(key, pending);
    pending.catch(() => sessions.delete(key));
  }
  return pending;
}

/** The one export packages/server/src/providers/registry.ts's `local` embeddings entry calls,
 *  from inside its own lazily-resolved closure. Returns the EmbeddingProvider synchronously — the
 *  package resolution already happened by the time this runs (registry.ts's dynamic `import()`);
 *  the model download/load still happens lazily, on the first real `embed()` call, memoized after.
 *
 *  `loadSessionFn` defaults to the real (memoized, transformers-backed) `loadSession` and exists so
 *  tests can inject a stubbed extractor — exercising batching, the offline-after-cache contract,
 *  and mean-pooling/normalization wiring without @huggingface/transformers or real weights ever
 *  being present. */
export function createEmbeddingProvider(
  opts: CreateEmbeddingProviderOpts = {},
  loadSessionFn: (
    info: EmbeddingModelInfo,
    modelsRoot: string,
    quantized: boolean,
    threads: number | undefined,
  ) => Promise<Session> = loadSession,
): EmbeddingProvider {
  const modelName = opts.model ?? DEFAULT_MODEL_NAME;
  const info = modelInfoByName(modelName);
  if (!info) {
    throw new Error(
      `embedder-local: unknown model "${modelName}" — embeddings.provider "local" only supports: ` +
        `${catalogModelNames().join(", ")}.`,
    );
  }
  const quantized = opts.quantized ?? true;
  const modelsRoot = opts.modelsRoot ?? defaultModelsDir();
  const threads = opts.threads;
  return {
    id: `local:${info.name}:${quantized ? "q8" : "fp32"}`,
    provider: "local",
    model: info.name,
    dimensions: info.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const { extractor } = await loadSessionFn(info, modelsRoot, quantized, threads);
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const vectors = output.tolist() as number[][];
      if (vectors.length !== texts.length) {
        throw new Error(
          `embedder-local: expected ${texts.length} vectors, got ${vectors.length} from "${info.name}"`,
        );
      }
      return vectors;
    },
  };
}

export { unsupportedPlatformReason } from "./model-fetch.js";
export { catalogModelNames, DEFAULT_MODEL_NAME, modelInfoByName } from "./model-info.js";
