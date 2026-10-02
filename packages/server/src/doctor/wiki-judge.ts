// wiki.judge (doctor) — status of the LLM judge behind find_existing_page / lint_wiki: is a gateway
// configured, is the judge on by default, which model last ruled, and how much of today's call
// allowance is spent. Offline and read-only: config plus two indexed reads of cache.db, so it runs
// on every default pass (no `--probe` gate), like telemetry.status.
import type { Check, CheckStatus } from "./types";

export interface WikiJudgeView {
  /** A gateway URL is configured (config or OBSIDIAN_TC_GATEWAY_URL): the judge role exists. */
  gatewayConfigured: boolean;
  /** `wikiJudge.enabled`: find_existing_page / lint_wiki judge when their `judge` argument is omitted. */
  enabled: boolean;
  /** `maintenance.wikiLint.judge`: the scheduled pass judges near-duplicate pairs. */
  sweepJudges: boolean;
  maxCallsPerDay: number;
  maxCallsPerRequest: number;
  timeoutMs: number;
  /** Resolved model of the most recent stored verdict; null before any call has been made. */
  model: string | null;
  callsToday: number;
  failuresToday: number;
  cachedVerdicts: number;
  /** Why cache.db could not be read, when it could not. */
  unreadable?: string;
}

export function wikiJudgeCheck(view: WikiJudgeView): Check {
  return {
    id: "wiki.judge",
    category: "config",
    run: () => {
      const details: Record<string, string | string[]> = {
        configured: String(view.gatewayConfigured),
        defaultOn: String(view.enabled && view.gatewayConfigured && view.maxCallsPerDay > 0),
        scheduledPassJudges: String(view.sweepJudges),
        model: view.model ?? "none yet",
        callsToday: `${view.callsToday}/${view.maxCallsPerDay}`,
        failuresToday: String(view.failuresToday),
        cachedVerdicts: String(view.cachedVerdicts),
        maxCallsPerRequest: String(view.maxCallsPerRequest),
        timeoutMs: String(view.timeoutMs),
      };
      if (!view.gatewayConfigured) {
        return {
          status: "ok" as CheckStatus,
          summary: "wiki judge: not configured (no gateway); page matches stay ambiguous",
          details,
          notes: view.enabled
            ? [
                "wikiJudge.enabled is set but needs a gateway (gateway.baseUrl or OBSIDIAN_TC_GATEWAY_URL).",
              ]
            : [],
        };
      }
      if (view.unreadable !== undefined) {
        return {
          status: "warning" as CheckStatus,
          summary: "wiki judge: cache.db could not be read, so today's use is unknown",
          details,
          issues: [view.unreadable],
        };
      }
      if (view.maxCallsPerDay <= 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "wiki judge: disabled (wikiJudge.maxCallsPerDay is 0)",
          details,
        };
      }
      const state = view.enabled
        ? "on by default"
        : "available (off by default; judge=true opts in)";
      const use = `${view.callsToday}/${view.maxCallsPerDay} calls today, model ${view.model ?? "none yet"}`;
      if (view.callsToday >= view.maxCallsPerDay) {
        return {
          status: "warning" as CheckStatus,
          summary: `wiki judge: ${state}, daily cap reached (${use}); later matches stay ambiguous until UTC midnight`,
          details,
          remediation: "Raise wikiJudge.maxCallsPerDay if the spend is acceptable.",
        };
      }
      if (view.callsToday >= 5 && view.failuresToday * 2 > view.callsToday) {
        return {
          status: "warning" as CheckStatus,
          summary: `wiki judge: ${state}, but ${view.failuresToday} of ${view.callsToday} calls failed today (timeouts, gateway errors or unusable replies)`,
          details,
          remediation:
            "Check the gateway's judge alias is up, or raise wikiJudge.timeoutMs. Failures leave verdicts ambiguous; nothing else breaks.",
        };
      }
      return { status: "ok" as CheckStatus, summary: `wiki judge: ${state}, ${use}`, details };
    },
  };
}
