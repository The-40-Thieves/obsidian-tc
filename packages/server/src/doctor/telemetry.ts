// telemetry.doctor (THE-1125) — reports the opt-in usage-telemetry posture, offline. No `--probe`
// gate: like captureLocation/conflictCopies/toolFacade, this reads only already-resolved config
// plus the durable telemetry_state row (a single indexed SELECT) — cheap enough for every default
// doctor pass.
import type { Check, CheckStatus } from "./types";

export interface TelemetryView {
  enabled: boolean;
  /** Host only, never the full endpoint URL — mirrors server_health's `telemetry.endpoint`. */
  endpoint?: string;
  installId?: string;
  lastSendAt?: number;
  lastError?: string;
}

export function telemetryCheck(view: TelemetryView): Check {
  return {
    id: "telemetry.status",
    category: "config",
    run: () => {
      const details: Record<string, string | string[]> = { enabled: String(view.enabled) };
      if (view.endpoint !== undefined) details.endpoint = view.endpoint;
      if (view.installId !== undefined) details.installId = view.installId;
      if (view.lastSendAt !== undefined)
        details.lastSendAt = new Date(view.lastSendAt).toISOString();
      if (view.lastError !== undefined) details.lastError = view.lastError;

      if (!view.enabled) {
        return {
          status: "ok" as CheckStatus,
          summary: "telemetry: disabled (default) — no data ever leaves this process",
          details,
        };
      }
      if (view.lastError !== undefined) {
        return {
          status: "warning" as CheckStatus,
          summary: `telemetry: enabled, sending to ${view.endpoint ?? "?"}, but the last send failed: ${view.lastError}`,
          details,
          remediation:
            "Check the endpoint is reachable and accepts the telemetry document schema (obsidian-tc telemetry preview shows what is sent). Counters are never lost on a failed send — they accumulate into the next attempt.",
        };
      }
      return {
        status: "ok" as CheckStatus,
        summary: `telemetry: enabled, sending to ${view.endpoint ?? "?"}${view.lastSendAt !== undefined ? " — last send ok" : " — no send attempted yet"}`,
        details,
      };
    },
  };
}
