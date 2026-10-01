// The declared-reranker resolver `wireGatewaySeams` boots through, split out of tool-wiring.ts to
// keep that file under the per-file line cap.

import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { resolveReranker } from "../providers/registry";
import { rerankerBuildBlocker } from "../providers/reranker-preflight";
import type { Reranker } from "../search/rerank";

/**
 * A DECLARED `reranker` block must never resolve to a silent `null` — only an ABSENT block may
 * (the zero-config-migration guarantee `buildModelTierReranker(embeddings) ?? gatewayReranker`
 * relies on). `resolveReranker` itself legitimately returns `null` for entries whose prerequisite
 * is missing (`model-tier` without `embeddings.modelTier.full`; `gateway` without a base URL) —
 * that is the right contract for a resolver primitive other callers may share. This wrapper is the
 * DECLARED-block-only enforcement point: it turns that null into a boot-time failure naming the
 * provider and what it needed, matching the actionable-hint idiom used throughout
 * providers/registry.ts.
 *
 * `provider: "local"` is a DELIBERATE exception: unlike model-tier/gateway (a config-correctness
 * defect), a `null` here is an environment-availability question — the optional
 * @the-40-thieves/obsidian-tc-reranker-local package may simply not be resolvable on this exact
 * deployment. It degrades like an ABSENT block instead of crashing boot. `doctor/checks.ts`'s
 * `rerankerBuildableCheck` keeps this loud rather than silently identical to "nothing configured".
 * Full rationale (THE-705 round 2, #806): docs/design/runtime-gateway-seams.md.
 */
export async function resolveDeclaredReranker(
  cfg: NonNullable<ServerConfig["reranker"]>,
  ctx: Parameters<typeof resolveReranker>[1],
): Promise<Reranker | null> {
  const reranker = await resolveReranker(cfg, ctx);
  if (reranker) return reranker;
  if (cfg.provider === "local") return null;
  // THE-679: the REASON comes from providers/reranker-preflight.ts, which doctor also reads, so a
  // pre-boot check and this boot-time throw can never disagree about why a block cannot build.
  const blocker = rerankerBuildBlocker(cfg.provider, ctx?.embeddings, {
    baseUrl: cfg.baseUrl,
    gatewayUrlEnv: process.env.OBSIDIAN_TC_GATEWAY_URL,
  });
  if (blocker) {
    throw err.invalidInput(blocker.reason, { provider: cfg.provider, hint: blocker.hint });
  }
  throw err.invalidInput(`reranker.provider "${cfg.provider}" resolved to no reranker`, {
    provider: cfg.provider,
    hint: "this provider's registry entry returned null instead of a reranker (or throwing) for a declared reranker block; that is a bug in the registry entry.",
  });
}
