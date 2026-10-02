// wiki.judge (doctor) — status of the LLM judge behind find_existing_page / lint_wiki: is a judge
// (a gateway, or TypeSafe Jev) configured, which tools judge by default, which model last ruled, and how much of today's call
// allowance is spent. Offline and read-only: config plus two indexed reads of cache.db, so it runs
// on every default pass (no `--probe` gate), like telemetry.status.
import type { Check, CheckStatus } from "./types";

export interface WikiJudgeView {
  /** A gateway URL is configured (config or OBSIDIAN_TC_GATEWAY_URL): the judge role exists. */
  gatewayConfigured: boolean;
  /** `wikiJudge.provider`; absent reads as "gateway". */
  provider?: "gateway" | "typesafe";
  /** Provider "typesafe": the API key resolves (never its value) and a model and threshold are set. */
  typesafeUsable?: boolean;
  /** `wikiJudge.enabled`: find_existing_page judges when its `judge` argument is omitted. */
  enabled: boolean;
  /** `wikiJudge.lintEnabled`: lint_wiki judges near-duplicate pairs when its `judge` argument is omitted. */
  lintEnabled?: boolean;
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
  const typesafe = view.provider === "typesafe";
  const configured = typesafe ? view.typesafeUsable === true : view.gatewayConfigured;
  const lintEnabled = view.lintEnabled ?? false;
  return {
    id: "wiki.judge",
    category: "config",
    run: () => {
      const live = configured && view.maxCallsPerDay > 0;
      const details: Record<string, string | string[]> = {
        provider: typesafe ? "typesafe" : "gateway",
        configured: String(configured),
        defaultOn: String(view.enabled && live),
        lintDefaultOn: String(lintEnabled && live),
        scheduledPassJudges: String(view.sweepJudges),
        model: view.model ?? "none yet",
        callsToday: `${view.callsToday}/${view.maxCallsPerDay}`,
        failuresToday: String(view.failuresToday),
        cachedVerdicts: String(view.cachedVerdicts),
        maxCallsPerRequest: String(view.maxCallsPerRequest),
        timeoutMs: String(view.timeoutMs),
      };
      if (typesafe && !configured) {
        return {
          status: "warning" as CheckStatus,
          summary:
            "wiki judge: provider typesafe is not usable, so the judge is off (it does not fall back to the gateway)",
          details,
          remediation:
            "Set wikiJudge.model (pinned, e.g. jev-1.13.0), wikiJudge.threshold and the API key variable named by wikiJudge.apiKeyEnv, or set wikiJudge.provider back to gateway.",
        };
      }
      if (!configured) {
        return {
          status: "ok" as CheckStatus,
          summary: "wiki judge: not configured (no gateway); page matches stay ambiguous",
          details,
          notes:
            view.enabled || lintEnabled
              ? [
                  "The wiki judge is switched on but needs a gateway (gateway.baseUrl or OBSIDIAN_TC_GATEWAY_URL) or wikiJudge.provider typesafe.",
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
      const which = typesafe ? " (typesafe)" : "";
      const onBy = [view.enabled ? "find_existing_page" : "", lintEnabled ? "lint_wiki" : ""]
        .filter(Boolean)
        .join(" and ");
      const state = `${onBy ? `${onBy} on by default` : "available (off by default; judge=true opts in)"}${which}`;
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
            "Check the judge (the gateway's judge alias, or TypeSafe) is up, or raise wikiJudge.timeoutMs. Failures leave verdicts ambiguous; nothing else breaks.",
        };
      }
      return { status: "ok" as CheckStatus, summary: `wiki judge: ${state}, ${use}`, details };
    },
  };
}
