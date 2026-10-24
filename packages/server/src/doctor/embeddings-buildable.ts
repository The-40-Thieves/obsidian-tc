// THE-1122 — mirrors checks.ts's `rerankerBuildableCheck` for the embeddings slot's "local"
// provider. Simpler than the reranker version: "local" is now the SCHEMA DEFAULT rather than an
// auto-select fallback behind other precedence, so there is no "no block declared, would we have
// picked it" branch to report — `denseProvider === "local"` is either declared explicitly or IS
// the resolved default, and either way this check probes the SAME thing: can the optional
// @the-40-thieves/obsidian-tc-embedder-local package actually resolve on this deployment.
import type { EmbedderInstallSite } from "../providers/embedder-install-plan";
import {
  embedderVersionSkew,
  localEmbedderInstallHint,
} from "../providers/local-embedder-registry";
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
  /** The resolved embedder's own version, when it resolved. Compared with obsidian-tc's version. */
  embedderVersion?: string;
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
  /** Where this obsidian-tc is installed, for the skew remediation's install command. Default: the
   *  running process's own layout (currentInstallSite). */
  installSite?: EmbedderInstallSite;
  /** #1231: true under `doctor --probe`, which runs the dense execution probe (retrieval.heads).
   *  Without it a resolved "local" has only been resolved, never run, so it is not a pass. */
  probeRequested?: boolean;
  platformOverride?: Parameters<typeof onnxNativePrebuildStatus>[0];
}

function platformDetails(view: EmbeddingsBuildableView): Record<string, string> {
  const platform = onnxNativePrebuildStatus(view.platformOverride);
  return platform.supported && !platform.route
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
          details: { warmup: "not-applicable" },
        };
      }
      const probe = await view.probeLocalEmbedder();
      const platform = onnxNativePrebuildStatus(view.platformOverride);
      if (probe.ok) {
        // #1231: resolving the package is not running it. A plain run never loads the model (the
        // default run stays offline), so on a supported platform a resolved "local" is not a pass
        // until `doctor --probe` has run the dense probe.
        const notProbed = platform.supported && view.probeRequested !== true;
        // A stale pair loads, but it is not the build that was tested alongside this obsidian-tc.
        const skew = embedderVersionSkew(probe.embedderVersion, view.installSite);
        return {
          status: (skew === undefined && platform.supported && !notProbed
            ? "ok"
            : "warning") as CheckStatus,
          summary:
            skew !== undefined
              ? `embeddings: "local" resolved, but ${skew}`
              : notProbed
                ? `embeddings: "local" resolved via ${probe.route ?? "an unknown route"}; dense search not probed; run \`doctor --probe\``
                : platform.supported
                  ? `embeddings: "local" resolved via ${probe.route ?? "an unknown route"}`
                  : `embeddings: "local" resolved via ${probe.route ?? "an unknown route"} but cannot run on this platform — ${platform.note}`,
          details: {
            provider: "local",
            route: probe.route ?? "unknown",
            attempts: probe.attempts,
            // What a server on this config will report once running: the model loads in the
            // background after the first initialize (server_health.embedder_warmup is the live state).
            warmup: "pending",
            ...(view.modelsCachePath ? { modelsCachePath: view.modelsCachePath } : {}),
            ...platformDetails(view),
          },
          ...(skew !== undefined
            ? {
                remediation: `Install the embedder that matches this obsidian-tc: ${localEmbedderInstallHint(view.installSite)}`,
              }
            : notProbed
              ? {
                  remediation:
                    'Run "obsidian-tc doctor --probe" to embed one probe string through the configured dense provider. Until then a resolved "local" embedder is unverified.',
                }
              : {}),
        };
      }
      // THE-1122 review round 3: three-way status, not two.
      //   - Platform genuinely unsupported (currently musl): always WARN, never FAIL, even on a
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
          warmup: "failed",
          warmupError: "the optional local embedder package does not resolve",
          ...(view.modelsCachePath ? { modelsCachePath: view.modelsCachePath } : {}),
          ...platformDetails(view),
        },
        issues: [
          sourceCheckoutNotBuilt
            ? 'embeddings.provider "local" (the default) is not built in this checkout yet — run "bun run build" in packages/embedder-local, or the boot reconcile will degrade to FTS-only, same as an unreachable hosted provider'
            : 'embeddings.provider "local" is configured (or is the unconfigured default) but the optional package does not resolve — dense retrieval and indexing will fail until this is fixed',
        ],
        remediation: `In a source checkout, run "bun run build" inside packages/embedder-local. For an npm install, run ${localEmbedderInstallHint()}; otherwise pick ollama or a hosted provider.`,
      };
    },
  };
}
