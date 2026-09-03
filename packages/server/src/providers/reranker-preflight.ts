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

/**
 * THE-944: mirrors runtime/tool-wiring.ts's `wireGatewaySeams` ABSENT-block precedence
 * (model-tier ?? gateway ?? local) exactly, so cli/commands/doctor.ts can decide, from config +
 * env alone, whether the registry would actually ATTEMPT to auto-select "local" at boot — true only
 * when no reranker block is declared, `embeddings.modelTier.full` is unset (buildModelTierReranker's
 * own only gate), and no gateway URL is configured from either source. Getting this wrong in either
 * direction makes doctor disagree with what boot does: report a fallback that never fires, or stay
 * silent about one that does.
 */
export function autoSelectLocalRerankerApplies(
  rerankerProvider: string | undefined,
  embeddings: RerankerPreflightEmbeddings | undefined,
  opts: { gatewayBaseUrl?: string; gatewayUrlEnv?: string | undefined } = {},
): boolean {
  if (rerankerProvider !== undefined) return false;
  if (embeddings?.modelTier?.full !== undefined) return false;
  const url = opts.gatewayBaseUrl ?? opts.gatewayUrlEnv;
  return !(url !== undefined && url.length > 0);
}
