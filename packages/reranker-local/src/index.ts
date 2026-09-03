// THE-705 item 1 — bundled local cross-encoder reranker, reachable with no
// OBSIDIAN_TC_GATEWAY_URL and no bge-m3-service.
//
// ZERO TOP-LEVEL IMPORT OF @huggingface/transformers. That is not a style preference: obsidian-tc's
// cold-start perf gate (boot.* keys) measures module-evaluation cost, and this package's consumer
// (packages/server/src/providers/registry.ts) dynamically imports THIS module even when
// reranker.provider is "local" — so if @huggingface/transformers were imported at THIS file's top
// level, simply resolving the "local" provider would pay for it. Loading the runtime AND the model
// weights is deferred all the way to the first actual rerank() call, memoized after that (the
// singleton pattern Transformers.js documents for Node servers). A provider that is configured but
// whose gatedRerank hardness gate never fires must never pay this cost.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVerified, fetchAndVerifyModel, modelDirFor } from "./model-fetch.js";
import { MODEL_DTYPE, PINNED_FILES } from "./model-info.js";

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

/** Structurally identical to packages/server/src/search/rerank.ts's `Reranker` — NOT imported from
 *  there. Importing a server type would make packages/server -> reranker-local -> packages/server a
 *  cycle; TypeScript's structural typing means registry.ts's `RERANKERS.local` entry satisfies
 *  `RerankerEntry.build(): Promise<Reranker | null>` without either side importing the other's type. */
export type Reranker = (query: string, documents: string[], topN: number) => Promise<RerankHit[]>;

export interface LocalRerankerOptions {
  /** Absolute path to the ROOT directory under which `<MODEL_ID>/<MODEL_REVISION>/...` lives
   *  (config.json, tokenizer.json, onnx/model_int8.onnx — see model-fetch.ts's `modelDirFor`).
   *  THE-944: no longer required to be pre-populated — `loadSession` fetches and checksum-verifies
   *  into this root on first use if the pinned files are not already there (or an explicit
   *  `bun run fetch-model` run, still supported — see README.md). Defaults to this package's own
   *  `models/` directory. */
  localModelPath?: string;
}

/** This package's own `models/` directory — NOT read via `readFileSync(new URL(...))` (the
 *  ast-grep rule `no-compiled-runtime-asset-read` forbids that pattern for a reason: `bun --compile`
 *  freezes `import.meta.url` to the build machine's path). This directory is the ROOT `loadSession`
 *  resolves `<MODEL_ID>/<MODEL_REVISION>/` under (see model-fetch.ts) — moot for the compiled-binary
 *  case specifically, since @huggingface/transformers cannot survive `bun --compile` at all
 *  (onnxruntime-node dlopens a sidecar .node/.so next to itself) — the provider is absent-by-default
 *  there regardless of this path. */
export function defaultModelsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "models");
}

/** True when every pinned file for MODEL_ID@MODEL_REVISION is present under `localModelPath` — the
 *  signal both this package's own tests and a consumer's doctor/preflight logic can use to decide
 *  "downloaded" vs "needs `bun run fetch-model`" (or will be fetched on first use — see
 *  fetchAndVerifyModel in model-fetch.ts) without importing @huggingface/transformers at all.
 *  Presence-only (no checksum): a cheap, offline-safe signal, not the verification gate itself —
 *  that lives in model-fetch.ts's verifyModelDir, which the lazy loader actually calls. */
export function weightsPresent(localModelPath: string = defaultModelsDir()): boolean {
  const modelDir = modelDirFor(localModelPath);
  return PINNED_FILES.every((f) => existsSync(join(modelDir, f.path)));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Pure — no Transformers.js involved. Turns raw cross-encoder logits (one per document, in
 *  input order) into `RerankHit[]` sorted by descending relevance, sigmoid-squashed to (0, 1),
 *  truncated to `topN` when positive. Exported so it is unit-testable with a stubbed score array,
 *  independent of whether the model runtime or weights are available on this machine. */
export function rankLogits(logits: readonly number[], topN: number): RerankHit[] {
  const hits = logits
    .map((logit, index) => ({ index, relevanceScore: sigmoid(logit) }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
  return topN > 0 ? hits.slice(0, topN) : hits;
}

// The dynamically-imported module's real types come from @huggingface/transformers, an OPTIONAL
// dependency this package's own TypeScript project does not require to be installed to typecheck.
// A structural `any` here is the load-bearing point: it is what makes the import genuinely optional
// at the type level, not just at the module-resolution level.
// biome-ignore lint/suspicious/noExplicitAny: see above.
type TransformersModule = any;

export interface Session {
  tokenizer: (
    text: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
    // biome-ignore lint/suspicious/noExplicitAny: tokenizer output shape is Transformers.js's own.
  ) => any;
  // biome-ignore lint/suspicious/noExplicitAny: model output shape is Transformers.js's own.
  model: (inputs: any) => Promise<{ logits: { data: ArrayLike<number> } }>;
}

/** query+doc pairs are truncated to this many combined tokens — standard for MS MARCO
 *  cross-encoders (trained at 512, effective and much faster at short lengths); see the THE-705
 *  research brief §2. */
const MAX_PAIR_TOKENS = 256;

/** One memoized session PER localModelPath — a process only ever configures one, but keying on the
 *  path (rather than a single module-level singleton) keeps this correct if a test or a future
 *  multi-vault deployment ever builds two rerankers with different paths in one process. A rejected
 *  load is NOT memoized: a transient failure (e.g. weights not yet downloaded when this was first
 *  called) must not permanently wedge the reranker if the operator fixes it and retries without a
 *  process restart. */
const sessions = new Map<string, Promise<Session>>();

async function loadSession(localModelPath: string): Promise<Session> {
  let pending = sessions.get(localModelPath);
  if (!pending) {
    pending = (async (): Promise<Session> => {
      // THE-944: fetch-and-verify BEFORE importing @huggingface/transformers, not after — a failed
      // download/checksum must never reach the runtime import at all, so the error an operator sees
      // names model-fetch.ts's own actionable message (which points at `bun run fetch-model`), not
      // an opaque "file not found" from deep inside Transformers.js. Already-verified files short
      // -circuit this with zero network calls — the common case after the first successful call.
      const modelDir = await fetchAndVerifyModel(localModelPath);
      // THE-944 review round 2 (G2): re-verify the FINAL directory immediately before use, as a
      // step DISTINCT from whatever fetchAndVerifyModel itself just checked — closes the TOCTOU
      // window between that verification and the from_pretrained calls below: a byte swapped on
      // disk in that gap (or a symlink planted after the fact) is caught here, before the runtime
      // import even happens, rather than silently loaded. Cheap (a handful of small files plus one
      // ~23 MB sha256, no network) — see model-fetch.ts's assertVerified for the full contract.
      await assertVerified(modelDir);
      // The dynamic import target is a VARIABLE, not a string literal — TypeScript only attempts to
      // resolve a literal specifier's module/type declarations for a dynamic import, so this line
      // typechecks whether or not @huggingface/transformers is installed. That is deliberate: this
      // package's own `tsc` must not require the optional runtime dependency to be present.
      const transformersPackage = "@huggingface/transformers";
      const { AutoModelForSequenceClassification, AutoTokenizer, env } = (await import(
        transformersPackage
      )) as TransformersModule;
      env.allowRemoteModels = false;
      // `modelDir` (MODEL_ID@MODEL_REVISION, already fetched+verified above) is passed as
      // `path_or_repo_id` directly, NOT `env.localModelPath` + the bare MODEL_ID — see
      // model-fetch.ts's modelDirFor doc comment for why: Transformers.js's own path-join contract
      // treats a `path_or_repo_id` with more than one `/` as a literal directory, reading
      // `<path_or_repo_id>/<filename>` and never consulting env.localModelPath for it at all. That
      // is what lets the on-disk layout be REVISION-scoped without env.localModelPath's single
      // `<root>/<MODEL_ID>/<filename>` join getting in the way.
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(modelDir),
        AutoModelForSequenceClassification.from_pretrained(modelDir, { dtype: MODEL_DTYPE }),
      ]);
      return { tokenizer, model };
    })();
    sessions.set(localModelPath, pending);
    // Don't memoize a rejection — see the comment above.
    pending.catch(() => sessions.delete(localModelPath));
  }
  return pending;
}

/** The one export packages/server/src/providers/registry.ts's `local` entry calls. Returns the
 *  Reranker SYNCHRONOUSLY — no await, no I/O, no import of @huggingface/transformers — so resolving
 *  `reranker.provider: "local"` at boot costs nothing beyond this dynamic `import()` of this small
 *  package itself. The heavy work happens inside the returned closure, on its first invocation.
 *
 *  `loadSessionFn` defaults to the real (memoized, transformers-backed) `loadSession` and exists so
 *  tests can inject a stub tokenizer/model pair — exercising the tokenize -> model -> rankLogits
 *  orchestration, batching, and text_pair wiring without @huggingface/transformers or real weights
 *  ever being present. Not part of the public contract consumers should rely on beyond tests. */
export function createReranker(
  opts: LocalRerankerOptions = {},
  loadSessionFn: (localModelPath: string) => Promise<Session> = loadSession,
): Reranker {
  const localModelPath = opts.localModelPath ?? defaultModelsDir();
  return async (query, documents, topN) => {
    if (documents.length === 0) return [];
    const { tokenizer, model } = await loadSessionFn(localModelPath);
    const queries: string[] = documents.map(() => query);
    const inputs = tokenizer(queries, {
      text_pair: documents,
      padding: true,
      truncation: true,
      max_length: MAX_PAIR_TOKENS,
    });
    const { logits } = await model(inputs);
    return rankLogits(Array.from(logits.data), topN);
  };
}
