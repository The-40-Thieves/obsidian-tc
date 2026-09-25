// THE-1122 — mirrors checks.ts's `rerankerBuildableCheck` for the embeddings slot's "local"
// provider. Simpler than the reranker version: "local" is now the SCHEMA DEFAULT rather than an
// auto-select fallback behind other precedence, so there is no "no block declared, would we have
// picked it" branch to report — `denseProvider === "local"` is either declared explicitly or IS
// the resolved default, and either way this check probes the SAME thing: can the optional
// @the-40-thieves/obsidian-tc-embedder-local package actually resolve on this deployment.
import { onnxNativePrebuildStatus } from "../providers/reranker-preflight";
import type { Check, CheckResult, CheckStatus } from "./types";

export interface LocalEmbedderProbeResult {
  ok: boolean;
  route?: string;
  attempts: string[];
  /** True when this process is running from inside a source checkout of the monorepo (the
   *  package's own directory was found, even though it isn't built) — see
   *  local-embedder-registry.ts's LocalEmbedderResolution.inSourceCheckout doc comment. Governs
   *  WARN vs FAIL below on an unsuccessful resolution. */
  inSourceCheckout: boolean;
}

export interface EmbeddingsBuildableView {
  denseProvider: string;
  /** THE-1122: `<cacheDir>/models/embedder-local` — where "local" fetches/verifies its pinned
   *  weights (registry.ts's buildLocalEmbeddingProvider computes the same path from
   *  ctx.cacheDir). Reported so an operator can find/clean/pre-stage the cache without reading
   *  source. Undefined when `denseProvider !== "local"`. */
  modelsCachePath?: string;
  /** Only consulted when `denseProvider === "local"`. Not gated behind `--probe`: resolving the
   *  small local JS module is fast, has no network/DB cost, and never imports
   *  @huggingface/transformers or loads a model (mirrors reranker.buildable's own reasoning for
   *  probing "local" by default — "no known build blocker" would otherwise be a lie for the
   *  provider this whole ticket makes the default). */
  probeLocalEmbedder?: () => Promise<LocalEmbedderProbeResult>;
  platformOverride?: Parameters<typeof onnxNativePrebuildStatus>[0];
}

function platformDetails(view: EmbeddingsBuildableView): Record<string, string> {
  const platform = onnxNativePrebuildStatus(view.platformOverride);
  return platform.supported
    ? {}
    : {
        platform:
          platform.note?.replace('"local" reranker', '"local" embedder') ?? "unsupported platform",
      };
}

export function embeddingsBuildableCheck(view: EmbeddingsBuildableView): Check {
  return {
    id: "embeddings.buildable",
    category: "retrieval",
    run: async (): Promise<CheckResult> => {
      if (view.denseProvider !== "local" || !view.probeLocalEmbedder) {
        return {
          status: "ok" as CheckStatus,
          summary: `embeddings: provider "${view.denseProvider}" is not "local" — nothing to resolve here (see retrieval.heads for its config/probe status)`,
        };
      }
      const probe = await view.probeLocalEmbedder();
      const platform = onnxNativePrebuildStatus(view.platformOverride);
      if (probe.ok) {
        return {
          status: (platform.supported ? "ok" : "warning") as CheckStatus,
          summary: platform.supported
            ? `embeddings: "local" resolved via ${probe.route ?? "an unknown route"}`
            : `embeddings: "local" resolved via ${probe.route ?? "an unknown route"} but cannot run on this platform — ${platform.note}`,
          details: {
            provider: "local",
            route: probe.route ?? "unknown",
            attempts: probe.attempts,
            ...(view.modelsCachePath ? { modelsCachePath: view.modelsCachePath } : {}),
            ...platformDetails(view),
          },
        };
      }
      // THE-1122 review round 3: three-way status, not two.
      //   - Platform genuinely unsupported (darwin-x64, musl): always WARN, never FAIL, even on a
      //     real (not source-checkout) install — no amount of installing/building the package can
      //     ever fix this; the honest remediation is "configure a different provider," which a
      //     scary FAIL would misrepresent as a fixable broken state.
      //   - Platform supported + this is a source checkout that simply hasn't run
      //     `bun run build` in packages/embedder-local yet: WARN — a normal, one-command-fixable
      //     dev-time state, not a broken install.
      //   - Platform supported + the package genuinely cannot resolve (a real npm install before
      //     the package's first publish, or a broken Docker image): FAIL, with remediation naming
      //     the exact fix — this reaches this branch only when `denseProvider === "local"` (the
      //     first branch above already returns "ok" for any other configured provider), so "no
      //     other provider is configured" always holds here by construction.
      const sourceCheckoutNotBuilt = probe.inSourceCheckout;
      const status: CheckStatus = !platform.supported
        ? "warning"
        : sourceCheckoutNotBuilt
          ? "warning"
          : "fail";
      return {
        status,
        summary: !platform.supported
          ? `embeddings: "local" could not resolve, and this platform cannot run it anyway — ${platform.note}`
          : sourceCheckoutNotBuilt
            ? 'embeddings: "local" is not yet built in this source checkout — run "bun run build" in packages/embedder-local'
            : 'embeddings: "local" could not resolve the optional @the-40-thieves/obsidian-tc-embedder-local package — indexing and semantic search will fail while this holds',
        details: {
          provider: "local",
          attempts: probe.attempts,
          ...(view.modelsCachePath ? { modelsCachePath: view.modelsCachePath } : {}),
          ...platformDetails(view),
        },
        issues: [
          sourceCheckoutNotBuilt
            ? 'embeddings.provider "local" (the default) is not built in this checkout yet — run "bun run build" in packages/embedder-local, or the boot reconcile will degrade to FTS-only, same as an unreachable hosted provider'
            : 'embeddings.provider "local" is configured (or is the unconfigured default) but the optional package does not resolve — dense retrieval and indexing will fail until this is fixed',
        ],
        remediation:
          'In a source checkout of this monorepo, run "bun run build" inside packages/embedder-local; once published, run "bun add @the-40-thieves/obsidian-tc-embedder-local"; or set an explicit hosted/hosted-compatible embeddings.provider instead (openai, voyage, cohere, bge-m3, openai-compatible, ollama).',
      };
    },
  };
}
