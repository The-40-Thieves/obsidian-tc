// Confirmation-outcome telemetry: what the human (or the headless `obsidian-tc elicit` mint)
// decided about a gated call, recorded as CODES in the existing `event_log` audit store.
//
// Why `event_log`, not the episode store: retention already sweeps it (db/maintenance.ts trims by
// `observability.retention.eventLogDays`), it carries no content column to leak into, and an
// episode is the experiential layer, which the confirmation gate must never depend on. An event
// pairs with its episode by (vault_id, tool_name, args_hash, caller) — the same key the episode's
// `elicit_required` error row carries — without either store referencing the other.
//
// Row shape (no migration; the columns are reused, documented here once):
//   event_type  `hitl_accept` | `hitl_decline` | `hitl_cancel` | `hitl_offered`
//   status      `ok` for an accept, `skipped` for everything else (the call did not proceed)
//   error_code  `<source>:<route>[:<client>]` — a TELEMETRY code for these rows, not an error
//   args_hash   the call's hash (a digest, never the arguments)
// `timeout` is not written: nothing in-process observes a client that never answered (the SDK's
// legacy shim swallows the leg timeout). It is derived at read time as an `hitl_offered` row older
// than the confirmation TTL with no answer after it (`readHitlConfirmationStats`).
import { writeEvent } from "./audit";
import type { Database } from "./db/types";
import type { CallerContext } from "./mcp/registry/types";

export const HITL_OUTCOMES = ["accept", "decline", "cancel", "offered"] as const;
export type HitlOutcome = (typeof HITL_OUTCOMES)[number];

/** `form`: the server-driven elicitation round trip (stdio legacy shim). `request_state`: the
 *  client-driven 2026-era echo of a minted requestState. `token`: a single-use token redeemed on
 *  the call; `obsidian-tc elicit` is the only in-tree minter, so this is the headless path. */
export const HITL_SOURCES = ["form", "request_state", "token"] as const;
export type HitlSource = (typeof HITL_SOURCES)[number];

/** How the call reached dispatch: directly, through `call_capability`, or a domain-verb tool. */
export type HitlRoute = "direct" | "facade" | "domain";

const EVENT_PREFIX = "hitl_";
const CLIENT_MAX = 48;

/** Client names are untrusted and reach a DB column: keep a closed character set so the `:`
 *  delimiter cannot be forged, and bound the length. Over-long names are dropped, not truncated. */
export function sanitizeClientName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0 || raw.length > CLIENT_MAX) return undefined;
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function encodeHitlDetail(source: HitlSource, route: HitlRoute, client?: string): string {
  const c = sanitizeClientName(client);
  return c === undefined ? `${source}:${route}` : `${source}:${route}:${c}`;
}

export function parseHitlDetail(
  code: string | null,
): { source: HitlSource; route: HitlRoute; client?: string } | null {
  const [source, route, client] = (code ?? "").split(":");
  if (!(HITL_SOURCES as readonly string[]).includes(source ?? "")) return null;
  if (route !== "direct" && route !== "facade" && route !== "domain") return null;
  return {
    source: source as HitlSource,
    route,
    ...(client !== undefined && client.length > 0 ? { client } : {}),
  };
}

type RecordCtx = Pick<CallerContext, "db" | "vaultId" | "caller" | "clientInfo" | "hitlRoute">;

/** Fail-open like every audit write: a locked DB must never turn a confirmed call into a failure. */
export function recordHitlOutcome(
  ctx: RecordCtx,
  e: { tool: string; argsHash: string | null; outcome: HitlOutcome; source: HitlSource },
  now: () => number = Date.now,
): void {
  try {
    writeEvent(ctx.db, {
      ts: now(),
      vault_id: ctx.vaultId,
      tool_name: e.tool,
      caller: ctx.caller,
      status: e.outcome === "accept" ? "ok" : "skipped",
      error_code: encodeHitlDetail(e.source, ctx.hitlRoute ?? "direct", ctx.clientInfo?.name),
      args_hash: e.argsHash,
      event_type: `${EVENT_PREFIX}${e.outcome}`,
    });
  } catch {
    /* audit stays fail-open */
  }
}

/** Records the human's verified answer carried on `ctx.hitlAnswer`, if any (mcp/server.ts sets it
 *  from a transport-verified requestState), whether or not the call then succeeds. */
export function recordHitlAnswer(ctx: RecordCtx & Pick<CallerContext, "hitlAnswer">): void {
  const a = ctx.hitlAnswer;
  if (a)
    recordHitlOutcome(
      { ...ctx, vaultId: a.vaultId },
      { tool: a.tool, argsHash: a.argsHash, outcome: a.action, source: a.source },
    );
}

/** Records that a confirmation round trip was offered for `error`'s call (an `elicit_required`). */
export function recordHitlOffer(
  ctx: RecordCtx,
  tool: string,
  error: { details?: unknown },
  source: HitlSource,
): void {
  const hash = (error.details as { args_hash?: unknown } | undefined)?.args_hash;
  if (typeof hash === "string")
    recordHitlOutcome(ctx, { tool, argsHash: hash, outcome: "offered", source });
}

export interface HitlToolStats {
  tool: string;
  accept: number;
  decline: number;
  cancel: number;
  /** `hitl_offered` rows past the confirmation TTL with no answer after them. */
  timeout: number;
  /** Subset of `accept` that arrived as a redeemed token (the headless path). */
  tokenAccept: number;
  /** Token accepts per sanitized client name. */
  tokenClients: Record<string, number>;
}

/** Per-tool confirmation counts since `sinceMs`. Content-free by construction: it reads only the
 *  code columns written above. `ttlMs` is the confirmation TTL (an offer younger than it may still
 *  be answered, so it is not yet a timeout). */
export function readHitlConfirmationStats(
  db: Database,
  opts: { sinceMs: number; nowMs: number; ttlMs: number },
): HitlToolStats[] {
  const byTool = new Map<string, HitlToolStats>();
  const row = (tool: string): HitlToolStats => {
    let s = byTool.get(tool);
    if (!s) {
      s = { tool, accept: 0, decline: 0, cancel: 0, timeout: 0, tokenAccept: 0, tokenClients: {} };
      byTool.set(tool, s);
    }
    return s;
  };
  const answered = db
    .prepare(
      `SELECT tool_name, event_type, error_code, COUNT(*) AS n FROM event_log
       WHERE event_type IN ('hitl_accept','hitl_decline','hitl_cancel') AND ts >= ?
       GROUP BY tool_name, event_type, error_code`,
    )
    .all(opts.sinceMs) as Array<{
    tool_name: string | null;
    event_type: string;
    error_code: string | null;
    n: number;
  }>;
  for (const r of answered) {
    const s = row(r.tool_name ?? "(unknown)");
    const outcome = r.event_type.slice(EVENT_PREFIX.length) as "accept" | "decline" | "cancel";
    s[outcome] += r.n;
    const d = parseHitlDetail(r.error_code);
    if (outcome === "accept" && d?.source === "token") {
      s.tokenAccept += r.n;
      const client = d.client ?? "(unknown)";
      s.tokenClients[client] = (s.tokenClients[client] ?? 0) + r.n;
    }
  }
  // An answer is a form/requestState one; a token redeemed after a timed-out form does not undo it.
  const timedOut = db
    .prepare(
      `SELECT o.tool_name AS tool_name, COUNT(*) AS n FROM event_log o
       WHERE o.event_type = 'hitl_offered' AND o.ts >= ? AND o.ts < ?
         AND NOT EXISTS (
           SELECT 1 FROM event_log a
           WHERE a.event_type IN ('hitl_accept','hitl_decline','hitl_cancel')
             AND a.error_code NOT LIKE 'token:%'
             AND a.vault_id IS o.vault_id AND a.tool_name IS o.tool_name
             AND a.args_hash IS o.args_hash AND a.caller IS o.caller AND a.ts >= o.ts)
       GROUP BY o.tool_name`,
    )
    .all(opts.sinceMs, opts.nowMs - opts.ttlMs) as Array<{ tool_name: string | null; n: number }>;
  for (const r of timedOut) row(r.tool_name ?? "(unknown)").timeout += r.n;
  return [...byTool.values()].sort((a, b) => total(b) - total(a) || a.tool.localeCompare(b.tool));
}

export function total(s: HitlToolStats): number {
  return s.accept + s.decline + s.cancel + s.timeout;
}
