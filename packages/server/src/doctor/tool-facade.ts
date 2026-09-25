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
import { NON_CORE_TOOL_NAMES } from "../mcp/tool-profiles";
import type { Check, CheckStatus } from "./types";

/** THE-1131 review round 2: one allowlist (the static config's own, or a named persona's) that
 *  names at least one tool `toolFacade.profile: "core"` hides — an allowlist entry naming a
 *  hidden tool can never actually widen access to it (profile wins), so it is dead config an
 *  operator almost certainly did not intend. */
export interface HiddenAllowlistEntry {
  /** e.g. "toolVisibility.allowed" or "personas.alice.toolVisibility.allowed". */
  source: string;
  names: string[];
}

export interface ToolFacadeView {
  configured: FacadeMode | "auto";
  /** Mirrors config.toolFacade.autoClients. Only consulted when `configured` is "auto". */
  autoClients?: Readonly<Record<string, FacadeMode>>;
  /** THE-1131: mirrors config.toolFacade.profile. Deployment-level, not per-session — unlike
   *  `configured` above, this needs no live client to report; it is exactly what the running
   *  process resolved. */
  profile: "full" | "core";
  /** THE-1131 review round 2: every allowlist (static or per-persona) that names a tool `profile`
   *  currently hides. Empty under `"full"` (nothing is hidden to name) or when no allowlist names
   *  a hidden tool. */
  hiddenAllowlistEntries?: HiddenAllowlistEntry[];
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

/** THE-1131 review round 2: given a candidate `allowed` list and the resolved profile, the subset
 *  that `toolFacade.profile` hides — an entry naming a tool the profile ALSO hides is dead config,
 *  since profile wins the precedence race (see visibility.ts's explainAgainstConfig ordering). */
export function hiddenNamesInAllowlist(
  allowed: readonly string[] | undefined,
  profile: "full" | "core",
): string[] {
  if (!allowed || profile !== "core") return [];
  const hidden = new Set(NON_CORE_TOOL_NAMES);
  return allowed.filter((n) => hidden.has(n));
}

export function toolFacadeCheck(view: ToolFacadeView): Check {
  return {
    id: "toolFacade.doctor",
    category: "config",
    run: () => {
      // THE-1131: the total (163) lives only in test/registered-tool-count.ts — a test-only
      // module doctor cannot import — so this reports the non-core count directly rather than a
      // total minus it. server_health (which runs against the live registry) reports both
      // absolute counts; see mcp/tool-wiring.ts's toolFacade health block.
      const nonCoreToolCount = NON_CORE_TOOL_NAMES.length;
      const details: Record<string, string | string[]> = {
        configured: view.configured,
        profile: view.profile,
        nonCoreToolCount: String(nonCoreToolCount),
      };
      if (view.configured === "auto") {
        details.autoClients = renderAutoClientsTable(view.autoClients);
      }
      const hiddenEntries = (view.hiddenAllowlistEntries ?? []).filter((e) => e.names.length > 0);
      if (hiddenEntries.length > 0) {
        details.hiddenAllowlistEntries = hiddenEntries.map(
          (e) =>
            `${e.source} names ${e.names.length} tool(s) hidden by toolFacade.profile: ${e.names.join(", ")}`,
        );
      }
      // THE-1123 review fix (LOW #9): `autoClients` is only ever consulted when `mode` is "auto"
      // (mcp/server.ts's `resolveFacadeMode` short-circuits before touching it for any other
      // mode) — a config that sets it under a concrete mode is silently inert, which is exactly
      // the shape a doctor check exists to surface rather than stay quiet about.
      const ignoredAutoClients =
        view.configured !== "auto" &&
        view.autoClients !== undefined &&
        Object.keys(view.autoClients).length > 0;
      if (ignoredAutoClients) {
        return {
          status: "warning" as CheckStatus,
          summary: `toolFacade.autoClients is configured but toolFacade.mode is "${view.configured}", not "auto" — autoClients is silently ignored`,
          details,
          remediation: 'Set toolFacade.mode to "auto", or remove toolFacade.autoClients.',
        };
      }
      const modeSummary =
        view.configured === "auto"
          ? `toolFacade.mode is "auto" — resolved per connecting client (see details.autoClients)`
          : `toolFacade.mode is "${view.configured}"`;
      const profileSummary =
        view.profile === "core"
          ? `toolFacade.profile is "core" (${nonCoreToolCount} tool(s) hidden and dispatch-rejected; registration itself is unaffected)`
          : `toolFacade.profile is "full" (every tool visible/callable, unchanged from today)`;
      if (hiddenEntries.length > 0) {
        return {
          status: "warning" as CheckStatus,
          summary: `${modeSummary}; ${profileSummary}; ${hiddenEntries.length} allowlist(s) name a tool toolFacade.profile hides`,
          details,
          remediation:
            'Remove the hidden name(s) from the allowlist, or set toolFacade.profile: "full" — an allowlist entry naming a profile-hidden tool can never restore it.',
        };
      }
      return {
        status: "ok" as CheckStatus,
        summary: `${modeSummary}; ${profileSummary}`,
        details,
      };
    },
  };
}
