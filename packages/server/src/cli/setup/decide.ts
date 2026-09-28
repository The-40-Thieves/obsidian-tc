// `obsidian-tc setup` (PR A of GH #995's two-part follow-up) — the ONE decision point for what an
// install's config should say, mirroring embeddings/sticky-provider.ts's own "one decision point"
// shape. Pure and synchronous: every input is already resolved by the command layer (cli/commands/
// setup.ts), which does the actual filesystem/network/DB probing — this module has no I/O of its
// own, so every branch is trivially unit-testable without a real vault, Ollama, or cache db.
//
// The root-cause principle GH #995 established: detect the environment ONCE, write the decision
// into the config EXPLICITLY, never re-detect silently at boot. This module is that one detection
// pass for embeddings — see embeddings/sticky-provider.ts's header for the boot-time half (keeping
// an EXISTING install's provider sticky) this module composes with, not duplicates: an existing
// index's provider is read via the SAME resolver (probeEmbeddingsProviderSource, called by
// cli/commands/setup.ts) and always wins here, so `setup` on an upgrade never contradicts what boot
// would have kept anyway.
import { LOCAL_CATALOG_DIMENSIONS } from "@the-40-thieves/obsidian-tc-shared";
import { ENV_KEY } from "../../embeddings/provider";
import {
  formatStickyEmbeddingsNotice,
  type StickyEmbeddingsResolution,
} from "../../embeddings/sticky-provider";

/** Below this, the smallest local catalog entry is picked instead of the default — see
 *  pickLocalModel's own comment for why 4096 (not some other number) is the line. */
export const LOW_RAM_THRESHOLD_MB = 4096;

/** The "local" catalog entry setup selects on a memory-constrained box — the smallest of the three
 *  pinned models (indexing-embeddings.schema.ts's LOCAL_CATALOG_DIMENSIONS), not the mid-sized
 *  bge-small-en-v1.5: both are 384-dim, but all-MiniLM-L6-v2 is the smaller download/runtime
 *  footprint of the pair, and this is a memory-tightness decision, not an accuracy one (that
 *  comparison — and why nomic-embed-text-v1.5 is the general default — already lives in
 *  indexing-embeddings.schema.ts's own header). */
const LOW_RAM_LOCAL_MODEL = "all-MiniLM-L6-v2";
const DEFAULT_LOCAL_MODEL = "nomic-embed-text-v1.5";

/** Ollama tags this repo knows how to pair with a real vector width — see
 *  embeddings/sticky-provider.ts's RECONSTRUCTABLE_PROVIDERS / PRE_1_31_4_DEFAULT_* for the same
 *  "never guess a width" rule applied to the boot-time sticky resolver. Ordered by preference:
 *  nomic-embed-text is this repo's own historical pre-1.31.4 default (PRE_1_31_4_DEFAULT_MODEL),
 *  so an Ollama install that already has it pulled is the closest match to "what this repo used to
 *  ship" and is preferred over any other embedding model that happens to also be pulled. */
const OLLAMA_KNOWN_EMBED_MODELS: ReadonlyArray<{ model: string; dimensions: number }> = [
  { model: "nomic-embed-text", dimensions: 768 },
  { model: "mxbai-embed-large", dimensions: 1024 },
  { model: "bge-m3", dimensions: 1024 },
  { model: "all-minilm", dimensions: 384 },
];

export interface SetupVaultInput {
  id: string;
  path: string;
}

export interface SetupOllamaProbe {
  reachable: boolean;
  /** Raw `models[].name` values from GET /api/tags (e.g. "nomic-embed-text:latest") — untouched,
   *  so decideSetup owns the tag-stripping/matching logic in one place, testably. */
  models: string[];
}

export interface SetupInputs {
  vaults: SetupVaultInput[];
  cacheDir: string;
  /** node:os totalmem(), in MB — capability/hardware.ts's own unit. */
  totalMemMb: number;
  /** The SAME resolver boot uses (embeddings/sticky-provider.ts's resolveStickyEmbeddings, via
   *  cli/commands/doctor-probes.ts's probeEmbeddingsProviderSource) — undefined only when the
   *  cache db does not exist yet (a genuinely fresh install with nothing to probe) OR the caller's
   *  own resolution came back with `source: "default"` (nothing to keep). Any OTHER source
   *  (`kept-from-index`, `ambiguous-orphaned-index` with an identity) always wins over every branch
   *  below, so `setup` can never choose a provider boot would then silently override. */
  existingIndex?: StickyEmbeddingsResolution;
  /** Whether `@the-40-thieves/obsidian-tc-embedder-local` resolves AND this platform's onnxruntime-
   *  node has a native prebuild — see providers/local-embedder-registry.ts's
   *  probeLocalEmbedderResolution + providers/reranker-preflight.ts's onnxNativePrebuildStatus
   *  (shared by the reranker ladder; embeddings-buildable.ts already composes the same two checks
   *  for `doctor --probe`). */
  localEmbedderAvailable: boolean;
  /** Why localEmbedderAvailable is false — folded into the "local anyway" notice so an operator
   *  reads a REASON, not just a bare refusal. Undefined when localEmbedderAvailable is true. */
  localUnavailableReason?: string;
  ollama?: SetupOllamaProbe;
  env: Record<string, string | undefined>;
}

export interface SetupEmbeddingsDecision {
  provider: string;
  model: string;
  dimensions: number;
  /** One-line, printed alongside the decision — "why this, not something else". */
  reason: string;
  /** Set only on the last-resort "local anyway" branch: a known problem exists (the package does
   *  not resolve, or the platform cannot run it) but there is nothing better to fall back to. */
  notice?: string;
  /** Carried from `existingIndex.revision` (Codex review round 1, finding 3) — a kept identity's
   *  model revision must survive into the written config, or the provider id / vec fingerprint
   *  (embeddings/index.ts's withRevision) changes on the next `serve`, defeating "keep the
   *  existing identity" and potentially triggering an unwanted rebuild/re-embed. */
  revision?: string;
}

/** A hosted provider whose API key is present in the environment — SURFACED, never auto-chosen.
 *  See this module's header and decideSetup's own comment on why: sending note content to a third
 *  party must always be an explicit opt-in, and "a key happens to be set" is not consent. */
export interface HostedProviderSuggestion {
  provider: string;
  envVar: string;
}

export interface SetupDecision {
  vaults: SetupVaultInput[];
  cacheDir: string;
  /** Undefined exactly when `refusal` is set — see `refusal`'s own doc comment. Every other path
   *  through decideEmbeddings sets this. */
  embeddings?: SetupEmbeddingsDecision;
  /** Codex review round 1, findings 1 + 5: set instead of `embeddings` when writing a guessed
   *  provider would be worse than writing nothing — an existing index's stored identity could not
   *  be mapped to a known provider (`unmappableFallback`), or the only identity found belongs to
   *  an AMBIGUOUS orphaned vault id that may not even be this vault's own index. Both cases print
   *  what was found and tell the operator to set `embeddings` explicitly rather than have setup
   *  cement a guess as "the operator's own choice" (which boot would then never question again).
   *  The command layer (cli/commands/setup.ts) must refuse to write when this is set. */
  refusal?: string;
  hostedSuggestions: HostedProviderSuggestion[];
}

function pickLocalModel(totalMemMb: number): { model: string; dimensions: number } {
  const model =
    totalMemMb > 0 && totalMemMb < LOW_RAM_THRESHOLD_MB ? LOW_RAM_LOCAL_MODEL : DEFAULT_LOCAL_MODEL;
  // Both branches are literal keys of LOCAL_CATALOG_DIMENSIONS (asserted, not a guess) — the
  // `?? 0` only satisfies noUncheckedIndexedAccess and is unreachable for these two constants.
  return { model, dimensions: LOCAL_CATALOG_DIMENSIONS[model] ?? 0 };
}

function pickOllamaModel(
  models: readonly string[],
): { model: string; dimensions: number } | undefined {
  const present = new Set(models.map((m) => m.split(":")[0]));
  return OLLAMA_KNOWN_EMBED_MODELS.find((c) => present.has(c.model));
}

/** NEVER reads a hosted API key's mere presence as a choice — see this module's header. Only the
 *  three built-in hosted vendors (embeddings/provider.ts's ENV_KEY) are checked; a generic
 *  `openai-compatible`/`module` provider has no fixed env var to scan for. */
function hostedSuggestions(env: Record<string, string | undefined>): HostedProviderSuggestion[] {
  return Object.entries(ENV_KEY)
    .filter(([, envVar]) => (env[envVar]?.length ?? 0) > 0)
    .map(([provider, envVar]) => ({ provider, envVar }));
}

/**
 * The ONE decision point for `obsidian-tc setup`'s embeddings choice. Precedence, closest match to
 * GH #995's own resolution order:
 *   1. an existing index's provider (never overridden — see `existingIndex`'s own doc comment)
 *   2. the bundled local embedder, when it can actually run here (model picked by RAM)
 *   3. Ollama, when it is running AND has a recognizable embedding model already pulled
 *   4. the bundled local embedder anyway, with a notice — it will fail to embed until the
 *      underlying problem (an unbuilt/unpublished package, or an unsupported platform) is fixed,
 *      but "local" is still the right schema-consistent default to write: it is what a fresh
 *      config would resolve to unconfigured, and this makes that explicit instead of silent.
 * A hosted hosted provider is NEVER chosen automatically at any point in this order, regardless of
 * whether its API key is present in the environment — only surfaced as a suggestion.
 */
export function decideSetup(input: SetupInputs): SetupDecision {
  const { embeddings, refusal } = decideEmbeddings(input);
  return {
    vaults: input.vaults,
    cacheDir: input.cacheDir,
    ...(embeddings !== undefined ? { embeddings } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
    hostedSuggestions: hostedSuggestions(input.env),
  };
}

/** Refusal text for `unmappableFallback` (finding 1): prints the STORED identity (model id +
 *  width) rather than the substitute pre-1.31.4 default `existing` itself carries — an operator
 *  fixing this needs to know what is actually on disk, not the fallback identity setup refused to
 *  guess past. */
function unmappableRefusal(existing: StickyEmbeddingsResolution): string {
  return (
    `this vault's existing index uses a stored provider id ("${existing.keptFromStoredModel}") ` +
    "that obsidian-tc cannot map back to a known, reconstructable provider — refusing to guess " +
    `one. The index is currently stored at dimensions=${existing.dimensions}. Set ` +
    "embeddings.provider (and .model/.dimensions, matching that width) explicitly in your config " +
    "to match the existing index, then re-run setup, or edit the written config by hand."
  );
}

/** Both `decideEmbeddings` return branches that decline to guess route their user-facing text
 *  through this pair so the CLI layer only ever needs to print `decision.refusal` and exit
 *  non-zero. */
function decideEmbeddings(input: SetupInputs): {
  embeddings?: SetupEmbeddingsDecision;
  refusal?: string;
} {
  const existing = input.existingIndex;
  if (existing) {
    // Finding 4 (MEDIUM, fix round 2): `ambiguous-orphaned-index` must ALWAYS refuse — sticky's
    // "the orphaned rows already belong to the default family, nothing to keep" result also
    // carries this source but with NO `keptFromStoredModel` (sticky-provider.ts's own
    // resolveStickyEmbeddings). Checking source FIRST, before `keptFromStoredModel`, catches BOTH
    // shapes: cementing either as this vault's own explicit config is the same "--force cements an
    // ambiguous unrelated index" failure the review named. formatStickyEmbeddingsNotice returns a
    // defined string for either sub-case of this source.
    if (existing.source === "ambiguous-orphaned-index") {
      return { refusal: formatStickyEmbeddingsNotice(existing) ?? "ambiguous orphaned index" };
    }
    if (existing.keptFromStoredModel !== undefined) {
      // Finding 1 (HIGH): an unmappable stored identity must never become a guessed, explicit
      // provider — that guess would then be read as "the operator's own choice" forever.
      if (existing.unmappableFallback) {
        return { refusal: unmappableRefusal(existing) };
      }
      return {
        embeddings: {
          provider: existing.provider,
          model: existing.model,
          dimensions: existing.dimensions,
          reason: `kept from this vault's existing index (stored as "${existing.keptFromStoredModel}") — never silently switched`,
          // Finding 3 (HIGH, round 1): carry the stored revision through so the written config
          // reconstructs the SAME provider id (embeddings/index.ts's withRevision) as the index
          // was built with.
          ...(existing.revision !== undefined ? { revision: existing.revision } : {}),
        },
      };
    }
    // Finding 3 (HIGH, fix round 2): `source === "default"` still means a cache.db EXISTS for this
    // vault (SetupInputs.existingIndex's own doc comment: probeEmbeddingsProviderSource returns
    // undefined outright when there is no cache.db at all) — either nothing has been indexed yet,
    // or every active row already belongs to the local family. Either way, a provider that merely
    // happens to be REACHABLE on this box (Ollama) is never reason enough to write something
    // different from what boot itself would keep sticky to on the very next run — that IS the
    // silent-switch failure GH #995 fixed. Ollama auto-selection (decideFreshEmbeddings) stays
    // reserved for a genuinely fresh install: no existingIndex probed at all (no cache.db).
    return { embeddings: decideStayLocal(input) };
  }
  return { embeddings: decideFreshEmbeddings(input) };
}

/** Finding 3 (HIGH, fix round 2) — see decideEmbeddings' own comment on when this runs. Never
 *  considers Ollama: an existing cache directory (even one with nothing to keep) only ever resolves
 *  to `local`, on the RAM-appropriate catalog model, with the same "could not be confirmed working"
 *  notice decideFreshEmbeddings' own last resort gives when the local embedder isn't actually
 *  available here. */
function decideStayLocal(input: SetupInputs): SetupEmbeddingsDecision {
  const { model, dimensions } = pickLocalModel(input.totalMemMb);
  if (input.localEmbedderAvailable) {
    return {
      provider: "local",
      model,
      dimensions,
      reason:
        model === LOW_RAM_LOCAL_MODEL
          ? `the bundled local embedder is available; ${model} was picked over the default nomic-embed-text-v1.5 because this machine has under ${LOW_RAM_THRESHOLD_MB}MB RAM (${input.totalMemMb}MB)`
          : "an existing cache directory was found with nothing to keep as a different provider, and the bundled local embedder is available — staying on local",
    };
  }
  return {
    provider: "local",
    model,
    dimensions,
    reason:
      "an existing cache directory was found with nothing to keep as a different provider — " +
      "staying on local rather than switching to a provider that merely happens to be reachable " +
      "(e.g. Ollama)",
    notice: localUnavailableNotice(input),
  };
}

/** Shared by `decideFreshEmbeddings`' own last-resort branch and `decideStayLocal` above, so the
 *  "local was picked despite not being confirmed working" warning text can't drift between the
 *  two callers. */
function localUnavailableNotice(input: SetupInputs): string {
  return (
    `the bundled local embedder could not be confirmed working here` +
    (input.localUnavailableReason ? ` (${input.localUnavailableReason})` : "") +
    " — indexing will fail until this is fixed (build/install the package, run Ollama with an embedding model pulled, or set embeddings.provider to a hosted provider yourself)."
  );
}

function decideFreshEmbeddings(input: SetupInputs): SetupEmbeddingsDecision {
  if (input.localEmbedderAvailable) {
    const { model, dimensions } = pickLocalModel(input.totalMemMb);
    return {
      provider: "local",
      model,
      dimensions,
      reason:
        model === LOW_RAM_LOCAL_MODEL
          ? `the bundled local embedder is available; ${model} was picked over the default nomic-embed-text-v1.5 because this machine has under ${LOW_RAM_THRESHOLD_MB}MB RAM (${input.totalMemMb}MB)`
          : "the bundled local embedder is available; no existing index and no memory constraint found — using the default catalog model",
    };
  }
  if (input.ollama?.reachable) {
    const picked = pickOllamaModel(input.ollama.models);
    if (picked) {
      return {
        provider: "ollama",
        model: picked.model,
        dimensions: picked.dimensions,
        reason: `Ollama is running at 127.0.0.1:11434 and already has "${picked.model}" pulled`,
      };
    }
  }
  const { model, dimensions } = pickLocalModel(input.totalMemMb);
  return {
    provider: "local",
    model,
    dimensions,
    reason:
      "no existing index, no working local embedder, and no Ollama with a known embedding model — defaulting to local anyway",
    notice: localUnavailableNotice(input),
  };
}
