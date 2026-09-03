// THE-679: the one place that knows why a DECLARED reranker block cannot be built.
//
// Two consumers, and they must never disagree:
//   * runtime/tool-wiring.ts turns this into the boot-time throw.
//   * doctor/checks.ts turns it into a pre-boot failing check.
//
// Before this existed, only boot knew. A config naming a provider that cannot build hard-failed
// startup while `obsidian-tc doctor` reported ok and exited 0 — because doctor's providers.registered
// check validates NAMES only, and both "model-tier" and "gateway" are perfectly valid names. Doctor
// was silent about the one configuration that would refuse to start.
//
// DELIBERATELY PURE AND OFFLINE. It answers only from config: no network, no filesystem, no dynamic
// import. That is what lets doctor run it safely — doctor must never execute a `module` provider's
// code as a side effect of diagnosing, which is exactly why `module` returns null here rather than
// being probed. An unbuildable module is caught at boot by the loader's own five refusals.

/** The subset of the embeddings config this preflight reads. */
export interface RerankerPreflightEmbeddings {
  modelTier?: { full?: unknown };
}

export interface RerankerBlocker {
  /** Short reason, suitable as the failing check's summary. */
  reason: string;
  /** What to actually do about it. */
  hint: string;
}

/**
 * Why the declared reranker `provider` provably cannot be built, or null when it can be — or when
 * it cannot be determined without executing something (`module`).
 *
 * `null` is therefore "no KNOWN blocker", not "guaranteed to build". Callers must treat it that
 * way: boot still throws if the registry entry returns null for a reason listed here, and doctor
 * says nothing rather than claiming success.
 */
export function rerankerBuildBlocker(
  provider: string,
  embeddings: RerankerPreflightEmbeddings | undefined,
  opts: { baseUrl?: string; gatewayUrlEnv?: string | undefined } = {},
): RerankerBlocker | null {
  if (provider === "model-tier") {
    if (embeddings?.modelTier?.full !== undefined) return null;
    return {
      reason:
        'reranker.provider "model-tier" cannot be built: embeddings.modelTier.full is not configured',
      hint: "set embeddings.modelTier.full (baseUrl, ...) so the model-tier reranker has an endpoint to call, or remove the reranker block entirely to fall back to the default precedence.",
    };
  }
  if (provider === "gateway") {
    const url = opts.baseUrl ?? opts.gatewayUrlEnv;
    if (url !== undefined && url.length > 0) return null;
    return {
      reason: 'reranker.provider "gateway" cannot be built: no gateway base URL is configured',
      hint: "set reranker.baseUrl or the OBSIDIAN_TC_GATEWAY_URL environment variable so the gateway reranker has an endpoint to call, or remove the reranker block entirely to fall back to the default precedence.",
    };
  }
  return null;
}

/** THE-944 review round 2 (G3): moved here from doctor/checks.ts, which is where it lived through
 *  round 1. It now has THREE consumers that must never disagree — the doctor check (as before),
 *  `autoSelectLocalRerankerApplies` below (new in round 2), and `runtime/tool-wiring.ts`'s
 *  boot-time auto-select skip (new in round 2) — and putting it in doctor/checks.ts would have
 *  made `autoSelectLocalRerankerApplies` import FROM checks.ts while checks.ts already imports
 *  `rerankerBuildBlocker` FROM this file, a circular import. This file is the natural, cycle-free
 *  home: it is already "the one place that knows why a reranker block cannot be built," shared by
 *  boot and doctor, and platform support is exactly that kind of fact.
 *
 *  Whether onnxruntime-node (a transitive dependency of the optional
 *  @the-40-thieves/obsidian-tc-reranker-local package, via @huggingface/transformers) ships a
 *  native prebuilt binary for THIS process's platform/arch/libc — confirmed against onnxruntime-node
 *  4.x's published npm platform packages: linux x64 + arm64 (glibc only), darwin arm64, win32 x64 +
 *  arm64. musl libc (Alpine and similar) and darwin x64 (Intel Mac) ship NONE.
 *
 *  Deliberately independent of whether `resolveLocalRerankerModule` actually resolved the JS
 *  package: that resolution only proves reranker-local's own small dist/index.js is importable — it
 *  never imports @huggingface/transformers itself (see that package's own header comment), so it
 *  cannot detect a missing NATIVE binary. A musl/darwin-x64 deployment can resolve the package via
 *  route (i)/(iii) and still hard-fail the moment a real rerank() call tries to load onnxruntime-node
 *  — this function is what lets doctor say so up front, on either verdict, rather than only after
 *  that first real failure in production, and what lets boot skip auto-selecting it at all (G3)
 *  instead of wiring a reranker guaranteed to throw on first use.
 *
 *  musl detection: `process.report`'s own header carries `glibcVersionRuntime` on a glibc build and
 *  omits it on musl (Node's own diagnostic report already draws this distinction) — a known,
 *  dependency-free technique; not 100% infallible against an unusual custom Node build, but accurate
 *  for every Node distribution this repo ships or tests against.
 *
 *  `platform`/`arch`/`isMuslRuntime` are injectable (defaulting to the REAL `process.platform` /
 *  `process.arch` / the report heuristic above) purely for test determinism — this repo's CI and
 *  every contributor's machine is glibc, so a test asserting the musl/darwin-x64 CASE cannot rely on
 *  ambient `process.platform` and must be able to fake it. Production callers never pass these. */
export function onnxNativePrebuildStatus(
  opts: { platform?: NodeJS.Platform; arch?: string; isMuslRuntime?: () => boolean } = {},
): { supported: boolean; note?: string } {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === "darwin" && arch === "x64") {
    return {
      supported: false,
      note:
        "this platform (darwin-x64 / Intel Mac) has NO onnxruntime-node prebuilt binary — the " +
        '"local" reranker cannot run here regardless of whether the package resolves; it is not a ' +
        "configuration gap.",
    };
  }
  const isMuslRuntime =
    opts.isMuslRuntime ??
    (() => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: process.report's type is loosely typed upstream.
        const header = (process.report?.getReport() as any)?.header;
        return header !== undefined && header.glibcVersionRuntime === undefined;
      } catch {
        return false;
      }
    });
  if (platform === "linux" && isMuslRuntime()) {
    return {
      supported: false,
      note:
        "this platform (linux musl libc, e.g. Alpine) has NO onnxruntime-node prebuilt binary — the " +
        '"local" reranker cannot run here regardless of whether the package resolves; it is not a ' +
        "configuration gap.",
    };
  }
  return { supported: true };
}

/** THE-944: the CONFIG-ONLY half of "would auto-select apply" — no reranker block declared,
 *  `embeddings.modelTier.full` unset, no gateway URL from either source. This is exactly what
 *  `autoSelectLocalRerankerApplies` checked before review round 2 folded platform support into its
 *  final answer (see that function's own comment for why). Kept as its OWN exported function,
 *  rather than inlined, so `cli/commands/doctor.ts` can still show a PLATFORM-SPECIFIC reason when
 *  config alone would have auto-selected "local" but the platform is what actually blocks it —
 *  without this, the moment platform became part of the final boolean, doctor would have had no way
 *  to distinguish "config says no" (an ordinary, silent precedence outcome) from "config says yes,
 *  platform says no" (worth a specific message) short of re-deriving these same three conditions a
 *  second time. */
export function autoSelectLocalRerankerConfigAllows(
  rerankerProvider: string | undefined,
  embeddings: RerankerPreflightEmbeddings | undefined,
  opts: { gatewayBaseUrl?: string; gatewayUrlEnv?: string | undefined } = {},
): boolean {
  if (rerankerProvider !== undefined) return false;
  if (embeddings?.modelTier?.full !== undefined) return false;
  const url = opts.gatewayBaseUrl ?? opts.gatewayUrlEnv;
  return !(url !== undefined && url.length > 0);
}

/**
 * THE-944: mirrors runtime/tool-wiring.ts's `wireGatewaySeams` ABSENT-block precedence
 * (model-tier ?? gateway ?? local) exactly, so cli/commands/doctor.ts can decide, from config +
 * env alone, whether the registry would actually ATTEMPT to auto-select "local" at boot — true only
 * when no reranker block is declared, `embeddings.modelTier.full` is unset (buildModelTierReranker's
 * own only gate), and no gateway URL is configured from either source. Getting this wrong in either
 * direction makes doctor disagree with what boot does: report a fallback that never fires, or stay
 * silent about one that does.
 *
 * THE-944 review round 2 (G3): now ALSO requires `onnxNativePrebuildStatus(...).supported` — a
 * platform with no onnxruntime-node native prebuild can never actually serve inference regardless
 * of whether the small JS package resolves, so auto-selecting there would wire a reranker
 * guaranteed to throw on its first real call. Extending THIS function (rather than adding a
 * parallel platform-aware wrapper) is what keeps "doctor and boot must agree" a property of ONE
 * shared rule instead of two rules a future edit could silently desync — see
 * `autoSelectLocalRerankerConfigAllows` above for the config-only half doctor still needs for its
 * OWN richer "why not" reporting.
 */
export function autoSelectLocalRerankerApplies(
  rerankerProvider: string | undefined,
  embeddings: RerankerPreflightEmbeddings | undefined,
  opts: {
    gatewayBaseUrl?: string;
    gatewayUrlEnv?: string | undefined;
    platformOverride?: Parameters<typeof onnxNativePrebuildStatus>[0];
  } = {},
): boolean {
  if (!autoSelectLocalRerankerConfigAllows(rerankerProvider, embeddings, opts)) return false;
  return onnxNativePrebuildStatus(opts.platformOverride).supported;
}
