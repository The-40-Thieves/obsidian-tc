// THE-521 / THE-837 — retrieval-head readiness, extracted from checks.ts.
//
// Split out because checks.ts crossed biome's 700-line ceiling (CLAUDE.md: "splitting is the fix,
// but a naive split creates a circular import -- lift the shared deps into a third module rather
// than having the new file import from the old one"). No third module was needed here: this check
// only ever depended on ./types, never on anything else in checks.ts, so the extraction is acyclic
// by construction. run.ts and index.ts import from here directly rather than through a re-export,
// which would have given `check:duplicate-exports` two modules exporting the same names.

import type { Check, CheckStatus } from "./types";

/** #16 (audit THE-562): the readiness inputs for the four retrieval heads, derived from
 *  config.embeddings + config.retrieval. The sparse/ColBERT streams only emit when the embeddings
 *  provider produces the multi-vector heads (bge-m3 or model-tier + modelTier.full). */
export interface RetrievalHeadsView {
  denseProvider: string;
  denseModel: string;
  denseDimensions: number;
  /** The embeddings provider emits the multi-vector (sparse/ColBERT) heads. */
  multiVector: boolean;
  sparseEnabled: boolean;
  colbertEnabled: boolean;
  /** config.reranker?.provider — a drop-in reranker slot is a name, not a member of a closed set, so
   *  this is reported as configured-or-not rather than inferred from denseProvider. */
  rerankerConfigured?: string;
  /** THE-837: the registry entry's `deprecated` notice for the configured dense provider, if it
   *  carries one. Reported as a NOTE, never an issue — a deprecated provider is working correctly
   *  and nothing is degraded, so promoting it to a warning would flip this check's status and make
   *  a healthy install read as faulty. That is precisely the misdirection THE-688 removed from the
   *  line above; re-adding it one field over would undo the lesson rather than apply it. */
  denseDeprecated?: string;
  /** THE-688 fix 2: OPT-IN liveness probe, supplied only under `doctor --probe`. Absent by default,
   *  which keeps this check offline by construction — diagnosing must never acquire a side effect
   *  just because someone ran it. When present, the check reports what it OBSERVED instead of what
   *  the config claims, and `ready` becomes a statement the check can actually support. */
  probe?: () => Promise<DenseProbeResult>;
}

/** Outcome of the opt-in dense probe. `ms` exists so an operator can distinguish "reachable" from
 *  "reachable but pathologically slow", which reads identically in a boolean. */
export type DenseProbeResult = { ok: true; ms: number } | { ok: false; reason: string };

/** Above this, a successful probe also earns a note. Deliberately generous — the point is to flag
 *  a provider that will bottleneck indexing, not to police a cold start. */
const SLOW_PROBE_MS = 5_000;

/** retrieval.heads — dense / sparse / ColBERT / reranker readiness, reported INDEPENDENTLY so an
 *  operator can see which streams are actually live vs enabled-but-inert. A stream enabled in
 *  config.retrieval but unbacked by the provider (no multi-vector head) is a no-op — surfaced as a
 *  warning rather than a silent nothing. */
export function retrievalHeadsCheck(view: RetrievalHeadsView): Check {
  return {
    id: "retrieval.heads",
    category: "retrieval",
    run: async () => {
      // THE-688: says `configured`, NOT `ready`. Every field on RetrievalHeadsView is derived from
      // config.embeddings + config.retrieval — there is no liveness input here and this check is
      // offline by construction (see rerankerBuildableCheck below), so it cannot know whether the
      // provider answers. `ready` was a literal in this template with no branch, which made it
      // structurally impossible for the check to report anything else.
      //
      // That is not hypothetical. Ollama was removed from a deployment on 2026-07-31 while the
      // config still named it; for two days every semantic query returned embedding_provider_error
      // while doctor printed `dense: ready (ollama, nomic-embed-text, dim 768)` and exited 0 —
      // actively pointing an operator AWAY from the cause. The same is true on a fresh install,
      // where the zero-config default names a provider most new users are not running.
      //
      // Reporting what the config SAYS is genuinely useful; claiming it works is what was wrong.
      // A probe would be a different feature and needs an opt-in flag — it must not become a
      // side effect of diagnosing (THE-688 fix 2).
      const denseId = `${view.denseProvider}, ${view.denseModel}, dim ${view.denseDimensions}`;
      const details: Record<string, string> = {
        dense: `configured (${denseId}) — not probed`,
      };
      const issues: string[] = [];
      const notes: string[] = [];

      // THE-837. Advisory, and deliberately ahead of the probe branch so it is reported whether or
      // not anyone passed --probe: the notice is about the CONFIG naming a provider on its way out,
      // which is true regardless of whether that provider currently answers.
      if (view.denseDeprecated)
        notes.push(`embeddings.provider '${view.denseProvider}': ${view.denseDeprecated}`);

      // THE-688 fix 2: only under `doctor --probe`. This is the ONLY branch permitted to say
      // "ready", because it is the only one that has looked. An unreachable provider is a WARNING,
      // not a fail: the config is still valid and the server will still boot — what has changed is
      // that retrieval will degrade, which is exactly the two-day-silent condition this closes.
      let probeFailed = false;
      if (view.probe) {
        const probed = await view.probe();
        if (probed.ok) {
          details.dense = `READY — probed ok in ${probed.ms}ms (${denseId})`;
          // Measured on a real gateway: a cold bge-m3 answered in 89,475ms. It IS reachable, so
          // reporting UNREACHABLE would be a false negative — a true-but-slow provider failed by a
          // stopwatch is worse than the ambiguity this ticket set out to remove. But "reachable"
          // and "reachable, and every index batch will crawl" read identically in a boolean, so
          // call it out rather than leaving a large number for someone to notice. Not an issue:
          // nothing is broken, and promoting it to a warning would make a cold start look like a
          // fault.
          if (probed.ms >= SLOW_PROBE_MS)
            notes.push(
              `the embeddings provider answered, but took ${probed.ms}ms — a cold start, or a genuinely slow endpoint. Indexing throughput is bounded by this.`,
            );
        } else {
          probeFailed = true;
          details.dense = `UNREACHABLE — ${probed.reason} (${denseId})`;
          issues.push(
            `the '${view.denseProvider}' embeddings provider did not answer a probe: ${probed.reason}. Dense retrieval and indexing will fail while this holds.`,
          );
        }
      }

      const streamStatus = (enabled: boolean, name: string): string => {
        if (!enabled) return `off (opt-in via retrieval.${name})`;
        // THE-688: `configured`, for the same reason as dense above — `multiVector` is inferred
        // from the PROVIDER NAME, not from anything observed. Left as `ready` it would have read
        // as a stronger claim than the dense line right beside it, which is worse than either
        // wording used consistently.
        if (view.multiVector) return `configured (${view.denseProvider} multi-vector head)`;
        issues.push(
          `retrieval.${name} is enabled but the '${view.denseProvider}' embeddings provider emits no multi-vector head — the ${name} stream is a no-op`,
        );
        return `INERT — enabled, but '${view.denseProvider}' emits no multi-vector head`;
      };
      details.sparse = streamStatus(view.sparseEnabled, "sparse");
      details.colbert = streamStatus(view.colbertEnabled, "colbert");

      // THE-681: rerankerConfigured is checked FIRST, ahead of the name-derived multiVector
      // branch. A declared `reranker` block WINS at runtime — tool-wiring.ts uses it instead of the
      // model-tier fallback — so with `embeddings.provider: "model-tier"` + modelTier.full AND a
      // declared cohere-compatible reranker, the old order printed "model-tier / ColBERT rerank
      // capable" and never named the backend actually wired. Reporting an inference over an
      // explicit declaration is wrong precisely when the operator has taken an override.
      if (view.rerankerConfigured) {
        details.reranker = `reranker configured: ${view.rerankerConfigured}`;
        notes.push(`reranker configured (${view.rerankerConfigured}) — a declared block wins`);
      } else if (view.multiVector) {
        details.reranker = `model-tier / ColBERT rerank capable (${view.denseProvider}); or the inference gateway /rerank passthrough when configured`;
      } else {
        // This branch's wording changed too, not just the rerankerConfigured-present one above: the
        // old text ("reranking depends on the inference gateway (env-configured)") predated
        // config.reranker and wrongly implied env-configured gateway passthrough was the ONLY path
        // to reranking. Since Task 5, a `reranker` config block is a second, equally valid path —
        // so even the true "nothing is configured" case can no longer claim gateway-only.
        details.reranker = `RRF-only — no reranker configured, and multi-vector capability could not be determined from the '${view.denseProvider}' provider name`;
        notes.push(
          `no reranker configured, and multi-vector capability could not be determined from the '${view.denseProvider}' provider name`,
        );
      }

      const status: CheckStatus = issues.length > 0 ? "warning" : "ok";
      // THE-688: the summary must name the RIGHT failure. Both a probe miss and an inert stream
      // land as `warning`, and before this the single warning string said "a retrieval stream is
      // enabled but inert" — which for an unreachable provider is both wrong and misdirecting,
      // the same class of error as the `ready` literal this ticket started from. Tracked as a flag
      // set where the failure happens, NOT re-derived by sniffing the rendered detail string —
      // rewording the detail must not silently change which summary an operator sees.
      const okSummary = view.probe
        ? "retrieval heads: dense PROBED ok; sparse/ColBERT/reranker per config"
        : "retrieval heads (from CONFIG, not probed): dense configured; sparse/ColBERT/reranker per config";
      return {
        status,
        summary: probeFailed
          ? "the dense embeddings provider did not answer a probe — retrieval and indexing will fail"
          : status === "ok"
            ? okSummary
            : "a retrieval stream is enabled but inert (provider emits no multi-vector head)",
        details,
        ...(issues.length ? { issues } : {}),
        ...(notes.length ? { notes } : {}),
        // Remediation follows the SAME split as the summary — telling an operator whose provider is
        // unreachable to "set embeddings.provider to bge-m3" would send them to reconfigure a
        // perfectly good config while the endpoint stays down.
        ...(issues.length
          ? {
              remediation: probeFailed
                ? "Check that the configured embeddings endpoint is reachable from THIS process (baseUrl, container network, and the provider's API-key env var). The config itself parses; nothing answered it."
                : "Set embeddings.provider to bge-m3 or model-tier (with modelTier.full) to activate the sparse/ColBERT streams, or disable retrieval.sparse / retrieval.colbert.",
            }
          : {}),
      };
    },
  };
}
