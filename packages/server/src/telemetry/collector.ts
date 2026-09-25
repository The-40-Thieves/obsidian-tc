// THE-1125 — the in-process half of opt-in telemetry: per-tool call counts, per-error-code
// counts, the facade mode of each call, and distinct client names seen (capped). Fed from the
// SAME hook point Prometheus's `obsidian_tc_tool_calls_total` already uses
// (MetricsRecorder.observeToolCall, metrics/registry.ts) — this module adds no second
// observation site in dispatch.ts; see registry.ts's `toolCallObserver` for the wiring.
//
// Deliberately holds only bounded-cardinality labels (tool names and error codes are both a fixed
// set the registry/error-taxonomy define — see tools/registry and shared/errors.ts) plus a capped
// set of client-supplied strings (client names, MAX_CLIENT_NAMES-bounded). Nothing here ever
// stores a path, note content, a query, a vault id, a caller/principal, a token, or a hostname —
// see document.ts's closed schema for the enforcement mechanism, and
// telemetry-forbidden-fields.test.ts for the property test.
import { MAX_CLIENT_NAMES } from "./document";

export interface TelemetrySnapshot {
  toolCalls: Readonly<Record<string, number>>;
  errorCodes: Readonly<Record<string, number>>;
  clientNames: readonly string[];
  windowStart: number;
  windowEnd: number;
}

function incMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Process-wide counter set. One instance lives for the process lifetime; `reset()` is called
 *  ONLY by the sender after a successful POST (never on failure — a failed send must not lose the
 *  window's counts, see sender.ts), and only ever from the scheduler's single-flight tick, so
 *  there is no concurrent-reset race to guard against here. */
export class TelemetryCollector {
  private toolCalls = new Map<string, number>();
  private errorCodes = new Map<string, number>();
  private clientNames = new Set<string>();
  private windowStart: number;

  constructor(now: () => number = Date.now) {
    this.windowStart = now();
  }

  /** Record one terminal tool call. `tool`/`errorCode` are both bounded-cardinality identifiers
   *  from this server's own registry/error taxonomy — never caller-supplied free text. `status`
   *  itself is not stored (the ticket's document carries per-tool and per-error-code counts, not
   *  a third ok/denied/error breakdown) — errorCode presence already implies non-ok. */
  recordToolCall(tool: string, errorCode?: string): void {
    incMap(this.toolCalls, tool);
    if (errorCode !== undefined) incMap(this.errorCodes, errorCode);
  }

  /** Record a client name seen this window, capped at MAX_CLIENT_NAMES DISTINCT names — a client
   *  past the cap is simply not added (not evicted, not counted specially): the document reports
   *  "up to 32 distinct clients connected", not a ranked or complete list. `name` is
   *  `ctx.clientInfo?.name` (mcp/client-info.ts), already bounded to 128 chars and type-checked as
   *  a string there — this module trusts that bound rather than re-deriving it. */
  recordClientName(name: string | undefined): void {
    if (name === undefined) return;
    if (this.clientNames.size >= MAX_CLIENT_NAMES && !this.clientNames.has(name)) return;
    this.clientNames.add(name);
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

  /** Clear all counters and open a new window. Called ONLY after a successful send. */
  reset(now: () => number = Date.now): void {
    this.toolCalls.clear();
    this.errorCodes.clear();
    this.clientNames.clear();
    this.windowStart = now();
  }
}
