// THE-1125 — the in-process half of opt-in telemetry: per-tool call counts, per-error-code
// counts, the facade mode of each call, and distinct client names seen (capped). Fed from the
// SAME hook point Prometheus's `obsidian_tc_tool_calls_total` already uses
// (MetricsRecorder.observeToolCall, metrics/registry.ts) — this module adds no second
// observation site in dispatch.ts; see registry.ts's `toolCallObserver` for the wiring.
//
// Security review (grok HIGH-1 + in-pool HIGH-A, 2026-09-25): `tool` used to be recorded VERBATIM
// as a Map key with no allowlist at all — `runDispatch` throws `not_found` for an unknown tool
// name and STILL calls `observeToolCall(..., name, ...)` with that same caller-supplied string
// (dispatch.ts), so a hostile `tools/call` (or `call_capability`) naming
// "/Users/alice/vault/Private/journal.md" landed that exact string in the document, unbounded.
// Every name/code recorded here is now checked against a CLOSED allowlist (registered tool names,
// the fixed ErrorCode enum) before it can become a key at all — anything else is bucketed into
// UNKNOWN_TOOL_NAME/UNKNOWN_ERROR_CODE, a single, unchanging, non-leaking key. This is enforced
// HERE, not merely at the call site, so a future caller of `recordToolCall` cannot bypass it by
// skipping some other check: the collector itself can never be made to hold an unbounded or
// caller-controlled key. See test/telemetry-document.test.ts's property test (dispatch.ts feeding
// this collector through the real `ToolRegistry.dispatch` path, not a hand-built call).
import { ERROR_CODES } from "@the-40-thieves/obsidian-tc-shared";
import { MAX_CLIENT_NAMES } from "./document";

export interface TelemetrySnapshot {
  toolCalls: Readonly<Record<string, number>>;
  errorCodes: Readonly<Record<string, number>>;
  clientNames: readonly string[];
  windowStart: number;
  windowEnd: number;
}

/** What an unregistered/unrecognized tool name collapses to. Never the caller-supplied string. */
export const UNKNOWN_TOOL_NAME = "unknown";
/** What a non-taxonomy error code collapses to (should be unreachable in practice — every thrown
 *  `ObsidianTcError` carries a code from the closed `ErrorCode` union — but the check is here
 *  regardless, on the same "trust nothing at this boundary" footing as the tool-name allowlist). */
export const UNKNOWN_ERROR_CODE = "unknown";
/** `other`, not `unknown`, for client names — an unrecognized MCP client is a normal, expected
 *  case (most clients are not in the small built-in table), not an anomaly worth a different
 *  word from the tool/error buckets above. */
export const OTHER_CLIENT_LABEL = "other";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** Defensive ceiling on DISTINCT keys per map, independent of the allowlists above — the
 *  allowlists already bound `toolCalls`/`errorCodes` to (registered tool count + 1) and
 *  (`ErrorCode` union size + 1) respectively, so this should never actually bind in practice; it
 *  exists so a pathologically large future registry cannot blow the document up either, the same
 *  "cap it anyway, don't rely solely on the allowlist" posture `clientNames`'s own cap takes. */
const MAX_MAP_KEYS = 256;

function incMap(map: Map<string, number>, key: string): void {
  if (!map.has(key) && map.size >= MAX_MAP_KEYS) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Substring-match a client name against `mcp/facade-auto.ts`'s own built-in table (the SAME
 *  matcher `toolFacade.mode: "auto"` uses to pick a facade), so telemetry never stores a client's
 *  raw, caller-controlled string — only ever one of the small set of canonical labels that table
 *  names, or `OTHER_CLIENT_LABEL`. Deliberately does NOT read `toolFacade.autoClients` (an
 *  operator's facade-mode override table, a different concern from telemetry's own labeling) —
 *  only the built-in table. Case-insensitive substring, first match wins, matching
 *  `resolveAutoFacadeMode`'s own semantics. */
export function canonicalizeClientName(
  name: string,
  knownClientSubstrings: ReadonlyArray<readonly [string, unknown]>,
): string {
  const lower = name.toLowerCase();
  for (const [substr] of knownClientSubstrings) {
    if (lower.includes(substr.toLowerCase())) return substr;
  }
  return OTHER_CLIENT_LABEL;
}

/** Process-wide counter set. One instance lives for the process lifetime; `reset()` is called by
 *  the sender after EITHER a successful POST or a document-build failure (never on an ordinary
 *  send failure — a failed send must not lose the window's counts, see sender.ts), and only ever
 *  from the scheduler's single-flight tick, so there is no concurrent-reset race to guard against
 *  here. */
export class TelemetryCollector {
  private toolCalls = new Map<string, number>();
  private errorCodes = new Map<string, number>();
  private clientNames = new Set<string>();
  private windowStart: number;

  constructor(
    /** The registered tool names to allowlist `recordToolCall`'s `tool` argument against, read
     *  LIVE at each call (not cached at construction) — this collector is built before the tool
     *  registry finishes registering (see runtime/server-runtime.ts's construction order), and
     *  the registry never changes after boot anyway, so a live read costs nothing extra. Defaults
     *  to an always-empty set — safe (everything buckets to UNKNOWN_TOOL_NAME) for a caller (the
     *  CLI `telemetry preview`/`status` commands, or a bare unit test) that never wires a live
     *  registry. */
    private readonly getKnownToolNames: () => ReadonlySet<string> = () => new Set(),
    now: () => number = Date.now,
  ) {
    this.windowStart = now();
  }

  /** Record one terminal tool call. `tool` is checked against the LIVE registered-tool-name set;
   *  `errorCode` (when present) against the closed `ErrorCode` enum. Neither can become a document
   *  key unless it is a member of its allowlist — see this file's header for why. */
  recordToolCall(tool: string, errorCode?: string): void {
    const known = this.getKnownToolNames();
    incMap(this.toolCalls, known.has(tool) ? tool : UNKNOWN_TOOL_NAME);
    if (errorCode !== undefined) {
      incMap(this.errorCodes, KNOWN_ERROR_CODES.has(errorCode) ? errorCode : UNKNOWN_ERROR_CODE);
    }
  }

  /** Record a client name seen this window, canonicalized against `knownClientSubstrings` (see
   *  `canonicalizeClientName`) and capped at MAX_CLIENT_NAMES DISTINCT canonical labels — since
   *  the canonicalization already collapses the caller-controlled string to one of a handful of
   *  fixed labels, this cap in practice only ever bounds `OTHER_CLIENT_LABEL` plus the built-in
   *  table's own (small, fixed) size; it stays as an explicit belt-and-suspenders ceiling rather
   *  than relying on that being obviously true forever. */
  recordClientName(
    name: string | undefined,
    knownClientSubstrings: ReadonlyArray<readonly [string, unknown]> = [],
  ): void {
    if (name === undefined) return;
    const canonical = canonicalizeClientName(name, knownClientSubstrings);
    if (this.clientNames.size >= MAX_CLIENT_NAMES && !this.clientNames.has(canonical)) return;
    this.clientNames.add(canonical);
  }

  /** Read the current window without clearing it — used by `telemetry preview` and by the sender
   *  to build the document it is about to POST. */
  snapshot(now: () => number = Date.now): TelemetrySnapshot {
    return {
      toolCalls: Object.fromEntries(this.toolCalls),
      errorCodes: Object.fromEntries(this.errorCodes),
      clientNames: [...this.clientNames],
      windowStart: this.windowStart,
      windowEnd: now(),
    };
  }

  /** Clear all counters and open a new window. Called after a successful send, or after a
   *  document-build failure (see sender.ts) — never after an ordinary send failure. */
  reset(now: () => number = Date.now): void {
    this.toolCalls.clear();
    this.errorCodes.clear();
    this.clientNames.clear();
    this.windowStart = now();
  }
}
