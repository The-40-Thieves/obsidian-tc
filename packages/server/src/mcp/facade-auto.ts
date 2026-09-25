// THE-1123 (part a) — the pure matcher behind `toolFacade.mode: "auto"`.
//
// `mcp/server.ts` owns WHEN this gets called (see its `resolveFacadeMode`): once per session
// (stdio: this instance IS the whole connection, so the first clientInfo-bearing request decides
// it for every later `tools/list`/`tools/call`; HTTP: `createMcpServer` is constructed fresh per
// request — see transports/http.ts's own comment on that — so "per session" collapses to "per
// request" there, which this module does not need to know about). This file is only the pure
// name -> mode decision, independent of how or when clientInfo was observed.
//
// BUILT-IN TABLE IS PROVISIONAL. It encodes a judgment call, not a measurement: this ticket (part
// a) wires the MECHANISM only. Part (b) — measuring actual tool-SELECTION accuracy per connecting
// client — has not run yet (see the memory note this ticket cites: nothing in this repo has ever
// measured selection accuracy by client, only by raw tool count). Replace these entries once that
// data exists; until then:
//   - "claude-code" -> "domain": Claude Code ships its own client-side tool SEARCH
//     (`ENABLE_TOOL_SEARCH`, on by default), so the triad's find_capability/describe_capability
//     layer duplicates a search the client already runs; domain's ~13 grouped meta-tools give it
//     real verbs to search over instead of a second search layer on top of its own.
//   - "cursor" -> "triad": a 40-tool cap has been REPORTED for Cursor in community discussion but
//     is UNVERIFIED against Cursor's own docs — kept at the existing default rather than acted on.
//   - everything else, and any client with no observable `clientInfo.name`, -> "triad"
//     (FALLBACK_FACADE_MODE), the existing ADR-anchored default
//     (docs/adr/0006-the-default-surface-is-the-triad.md) — auto mode never changes that default
//     for an unrecognized or silent client.
import type { TelemetryStatusInfo } from "../telemetry/wiring";
import type { FacadeMode } from "./facade";

/**
 * Checked AFTER `toolFacade.autoClients` (the operator's own config) and only when nothing there
 * matched. Order is significant: read top to bottom, first substring match wins.
 */
export const BUILTIN_AUTO_FACADE_CLIENTS: ReadonlyArray<readonly [string, FacadeMode]> = [
  ["claude-code", "domain"],
  ["cursor", "triad"],
];

/** What an unmatched client — or one with no observable `clientInfo.name` at all — gets. */
export const FALLBACK_FACADE_MODE: FacadeMode = "triad";

/**
 * Resolve `toolFacade.mode: "auto"` for one connecting client.
 *
 * Matching is a case-insensitive SUBSTRING of `clientName` against each table key (never the
 * reverse — a key is never a substring test against the whole recorded string the other way).
 * `configured` (`toolFacade.autoClients`, in the CONFIG FILE'S own key order — JSON object key
 * order is preserved end to end, see config/load.ts) is tried first, so a key there for a
 * substring the built-in table also matches OVERRIDES it. First match wins either way, so ordering
 * within each table matters and is never re-sorted.
 *
 * `clientName` absent (no `clientInfo.name` observed for this connection — most callers today send
 * none at all) skips straight to {@link FALLBACK_FACADE_MODE}; there is nothing to match against.
 */
/** THE-1123: `config.toolFacade` -> the `toolFacade` shape `createHealthTool` (tools/admin/
 *  health.ts) and `run_doctor` (cli/commands/doctor.ts) both want — one place so the two call
 *  sites (and server-runtime.ts's own wiring of the first) stay a single line each. */
export function toolFacadeHealthView(cfg: {
  mode: FacadeMode | "auto";
  autoClients?: Readonly<Record<string, FacadeMode>>;
}): { configured: FacadeMode | "auto"; autoClients?: Readonly<Record<string, FacadeMode>> } {
  return { configured: cfg.mode, autoClients: cfg.autoClients };
}

/** THE-1123 review fix (LOW #8), extended THE-1125: bundles `config`-derived `wireHealthTools`
 *  deps — server-runtime.ts has no per-field line budget for them individually. Named + imported,
 *  called via a spread at the call site, rather than an unnamed inline object literal.
 *  `telemetry` is optional so a caller that never wires telemetry (a harness/test) keeps
 *  compiling; server-runtime.ts's own call site always passes it. */
export function healthToolsWiringFields<V extends readonly { id: string }[]>(
  cfg: {
    vaults: V;
    toolFacade: { mode: FacadeMode | "auto"; autoClients?: Readonly<Record<string, FacadeMode>> };
  },
  telemetry?: { getStatus: () => TelemetryStatusInfo },
): {
  vaults: V;
  toolFacade: typeof cfg.toolFacade;
  getTelemetryStatus?: () => TelemetryStatusInfo;
} {
  return {
    vaults: cfg.vaults,
    toolFacade: cfg.toolFacade,
    ...(telemetry ? { getTelemetryStatus: telemetry.getStatus } : {}),
  };
}

/** THE-1123 review fix (LOW #8): `config.toolFacade` -> `createMcpServer`'s own two option names
 *  (`facadeMode`, not `mode`). Same reasoning as `healthToolsWiringFields` above. */
export function mcpServerFacadeOptions(cfg: {
  mode: FacadeMode | "auto";
  autoClients?: Readonly<Record<string, FacadeMode>>;
}): { facadeMode: FacadeMode | "auto"; autoClients?: Readonly<Record<string, FacadeMode>> } {
  return { facadeMode: cfg.mode, autoClients: cfg.autoClients };
}

export function resolveAutoFacadeMode(
  clientName: string | undefined,
  configured?: Readonly<Record<string, FacadeMode>>,
): FacadeMode {
  // `clientName` is typed `string | undefined`, but every caller ultimately derives it from
  // untrusted wire data (a client's own declared `clientInfo.name`) threaded through several
  // optional-chain hops; a `typeof` guard (not just the type declaration) is what actually stops
  // a non-string reaching `.toLowerCase()` and throwing out of what is meant to be a pure,
  // never-fails matcher.
  if (typeof clientName !== "string" || clientName.length === 0) return FALLBACK_FACADE_MODE;
  const lower = clientName.toLowerCase();
  for (const [substr, mode] of Object.entries(configured ?? {})) {
    if (lower.includes(substr.toLowerCase())) return mode;
  }
  for (const [substr, mode] of BUILTIN_AUTO_FACADE_CLIENTS) {
    if (lower.includes(substr.toLowerCase())) return mode;
  }
  return FALLBACK_FACADE_MODE;
}
