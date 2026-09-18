// THE-1078 — doctor probe for the opt-in TypeSafe Jev citation judge (experiential.citationInfer.
// judge.provider = "typesafe"). Same optional-probe shape as every other store/network-touching
// check in this directory (see notesFtsIntegrityCheck / experientialEvaluatorCheck): the default
// run stays offline, and only `doctor --probe` actually reaches the network.
import type { Check, CheckStatus } from "./types";

export interface CitationJudgeProbeResult {
  ok: boolean;
  /** HTTP status of the probe request, when one was received. */
  status?: number;
  latencyMs?: number;
  /** Never the API key — a message or a typed error's own message, at most. */
  reason?: string;
}

export interface CitationJudgeView {
  /** config.experiential.citationInfer.judge.provider, or "gateway" when the block is absent —
   *  mirrors buildCitationJudge's own default (citation-judge.ts). */
  provider: "gateway" | "typesafe";
  /** The configured model id, shown in the "not probed" summary so a doctor run without --probe
   *  still names what would be called. */
  model?: string;
  /** Attached ONLY under `doctor --probe` AND provider === "typesafe" — a default run must not
   *  reach the network, same contract as every other probe field in this directory. */
  probe?: () => Promise<CitationJudgeProbeResult>;
}

/**
 * experiential.citation-judge — is the configured stage-2 judge provider actually reachable?
 *
 * `provider: "gateway"` (the default, and every deployment before THE-1078) is always `ok` here:
 * the gateway's own reachability is doctor's `retrieval.probe` / `bridge.state` checks' business,
 * not this one's — this check exists only for the NEW opt-in provider. `provider: "typesafe"`
 * with no `--probe` reports the config as accepted but unverified, matching
 * `experientialEvaluatorCheck`'s "from CONFIG, not probed" wording exactly. Under `--probe`, an
 * unreachable TypeSafe endpoint is a WARNING, not a fail: citation-inference degrades to leaving
 * survivor rows unstamped (the existing judgeErrors/kill-switch path), not to a broken server.
 */
export function citationJudgeCheck(view: CitationJudgeView): Check {
  return {
    id: "experiential.citation-judge",
    category: "retrieval",
    run: async () => {
      if (view.provider !== "typesafe") {
        return {
          status: "ok" as CheckStatus,
          summary: "citation judge: gateway (default)",
          details: { judge: "gateway (roles.judge)" },
        };
      }
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: `citation judge (from CONFIG, not probed): typesafe (${view.model ?? "no model configured"})`,
          details: {
            judge: `typesafe, ${view.model ?? "no model configured"} — not probed (run doctor --probe)`,
          },
        };
      }
      const r = await view.probe();
      if (r.ok) {
        return {
          status: "ok" as CheckStatus,
          summary: `citation judge: typesafe reachable (${r.latencyMs ?? "?"}ms)`,
          details: {
            judge: `typesafe ok, ${r.latencyMs ?? "?"}ms${r.status !== undefined ? `, HTTP ${r.status}` : ""}`,
          },
        };
      }
      return {
        status: "warning" as CheckStatus,
        summary: `citation judge: typesafe unreachable${r.reason ? ` — ${r.reason}` : ""}`,
        details: {
          judge: `typesafe FAILED${r.status !== undefined ? ` (HTTP ${r.status})` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
        },
        issues: [
          `experiential.citationInfer.judge.provider is "typesafe" but the probe could not reach it${r.reason ? `: ${r.reason}` : ""}. The scheduled citation pass will count every judge call as a transport error until this is fixed — not a broken server, but citation verdicts stop being confirmed.`,
        ],
        remediation:
          "Check judge.apiKeyEnv names a set environment variable (or judge.apiKey is set inline), that judge.baseUrl and judge.model are correct, and that this host has network egress to the TypeSafe endpoint.",
      };
    },
  };
}
