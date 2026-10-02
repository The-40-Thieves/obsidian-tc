// THE-1123's built-in client -> facade-mode table, split out of facade-auto.ts (THE-1125 fix
// round) so it can be a dependency-free LEAF module: facade-auto.ts needs it for
// `resolveAutoFacadeMode`, and telemetry/wiring.ts needs the same substring table for
// `collector.ts`'s client-name canonicalization (never storing a caller's raw client name) — but
// facade-auto.ts already imports `TelemetryStatusInfo` (type-only) from telemetry/wiring.ts, so
// wiring.ts importing FROM facade-auto.ts would be a real cycle at the module-dependency-graph
// level (`check:boundaries`'s `no-circular` rule catches this even for a type-only edge — see
// `reference-obsidian-tc-adding-a-tool-trips-four-gates`'s THE-658 precedent). This module has no
// imports of its own beyond the pure `FacadeMode` type, so either side can depend on it with no
// cycle possible.
import type { FacadeMode } from "./facade-mode";

/**
 * Checked AFTER `toolFacade.autoClients` (the operator's own config) and only when nothing there
 * matched. Order is significant: read top to bottom, first substring match wins.
 *
 * `toolFacade.mode: "auto"` is DEPRECATED: it resolves to "triad" for every client, because a
 * per-client measurement (Claude Code, tool search on: triad 32/32 trials at the lowest token cost;
 * domain produced a validation error in every trial) found no mode that beats the triad. The keys
 * stay because telemetry/wiring.ts reuses them as its canonical client labels; every value is the
 * triad. See facade-auto.ts's header comment.
 */
export const BUILTIN_AUTO_FACADE_CLIENTS: ReadonlyArray<readonly [string, FacadeMode]> = [
  ["claude-code", "triad"],
  ["cursor", "triad"],
];
