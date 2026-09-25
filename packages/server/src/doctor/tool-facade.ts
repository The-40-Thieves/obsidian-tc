// toolFacade.doctor (THE-1123 part a) — reports `toolFacade.mode`, and for "auto" the merged
// per-client resolution table, offline.
//
// Deliberately does NOT report an "effective" mode or a "clientName" the way server_health's
// `toolFacade` block does: doctor is a CLI command, run offline from `config` alone (run_doctor,
// cli/commands/doctor.ts), with no live MCP connection to observe a `clientInfo` from — there is
// no PER-SESSION anything here to report. Inventing one (e.g. "the last client seen") would be a
// server-side value this process cannot see at all, not a diagnostic. What an offline command CAN
// usefully say is: here is the configured mode, and — since "auto" is a per-client decision —
// here is the exact table (config merged over the built-in one, same precedence
// resolveAutoFacadeMode uses) an operator can read to answer "what would client X get" by eye.
import type { FacadeMode } from "../mcp/facade";
import { BUILTIN_AUTO_FACADE_CLIENTS } from "../mcp/facade-auto";
import type { Check, CheckStatus } from "./types";

export interface ToolFacadeView {
  configured: FacadeMode | "auto";
  /** Mirrors config.toolFacade.autoClients. Only consulted when `configured` is "auto". */
  autoClients?: Readonly<Record<string, FacadeMode>>;
}

/**
 * The resolution table `resolveAutoFacadeMode` would actually use, rendered as
 * `"<substring> -> <mode> (configured|built-in)"` lines in match order: `autoClients` entries
 * first (their own key order — an override for a key the built-in table also has is listed ONCE,
 * tagged "configured", not twice), then the built-in entries it did not override, in the built-in
 * table's own order.
 */
function renderAutoClientsTable(
  autoClients: Readonly<Record<string, FacadeMode>> | undefined,
): string[] {
  const configured = Object.entries(autoClients ?? {});
  const configuredKeys = new Set(configured.map(([k]) => k.toLowerCase()));
  const lines = configured.map(([substr, mode]) => `${substr} -> ${mode} (configured)`);
  for (const [substr, mode] of BUILTIN_AUTO_FACADE_CLIENTS) {
    if (configuredKeys.has(substr.toLowerCase())) continue;
    lines.push(`${substr} -> ${mode} (built-in)`);
  }
  return lines;
}

export function toolFacadeCheck(view: ToolFacadeView): Check {
  return {
    id: "toolFacade.doctor",
    category: "config",
    run: () => {
      const details: Record<string, string | string[]> = { configured: view.configured };
      if (view.configured === "auto") {
        details.autoClients = renderAutoClientsTable(view.autoClients);
      }
      return {
        status: "ok" as CheckStatus,
        summary:
          view.configured === "auto"
            ? `toolFacade.mode is "auto" — resolved per connecting client (see details.autoClients)`
            : `toolFacade.mode is "${view.configured}"`,
        details,
      };
    },
  };
}
