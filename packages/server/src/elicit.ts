import { randomBytes } from "node:crypto";
import { err, type ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "./db/types";
import { assertNoReplayDrift, type StateProbe } from "./elicit-drift";
import { createElicitCodec, type ElicitCodec } from "./elicit-request-state";
import type { CallerContext } from "./mcp/registry/types";

/** Built-in default elicit-token TTL: 5 minutes (G2.4 A.3). Overridable at startup from the
 *  resolved server config (`elicitTtlSeconds`) via setDefaultElicitTtlSeconds — cli.ts calls it once
 *  so the configured value governs every mint that does not pass an explicit ttlSeconds (THE-302). */
const FALLBACK_TTL_SECONDS = 300;
let defaultTtlSeconds = FALLBACK_TTL_SECONDS;

/** Set the process-wide default elicit-token TTL from config (THE-302). No-op on a non-positive or
 *  non-integer value, so a malformed override can never disable expiry. Called once at startup. */
export function setDefaultElicitTtlSeconds(seconds: number): void {
  if (Number.isInteger(seconds) && seconds > 0) defaultTtlSeconds = seconds;
}

/**
 * The effective confirmation TTL. Exported so THE-583's request-state codec expires a 2026-era
 * confirmation on exactly the same clock as the 2025 token it replaces — two eras of the same
 * mechanism disagreeing about how long an approval lasts is the kind of drift nobody notices until
 * one of them is wrong.
 */
export function getDefaultElicitTtlSeconds(): number {
  return defaultTtlSeconds;
}

/** THE-1106: stdio's own `requestState` codec (HTTP's is keyed off `auth.jwtSecret`, which stdio
 *  has none of — trusted local transport, no bearer auth). A per-process random secret is fine:
 *  the codec only needs to authenticate a state THIS process minted, never one from elsewhere, and
 *  restart invalidates every outstanding confirmation exactly like a token TTL would. Never logged
 *  — `createElicitCodec` only ever derives a hash from it. */
export function createStdioElicitCodec(): ElicitCodec {
  return createElicitCodec(randomBytes(32).toString("hex"), getDefaultElicitTtlSeconds());
}

export interface IssueElicitInput {
  vaultId: string;
  toolName: string;
  argsHash: string;
  caller: string | null;
  proposedChange?: unknown;
  ttlSeconds?: number;
  now?: () => number;
}

/** How long a raised request's state fingerprint stays available to bind a token to. Far longer than
 *  any token TTL: an operator may mint hours after the agent was blocked, and binding to that old
 *  fingerprint is exactly the point — state that moved since the request is drift. */
const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Record the state fingerprint a call's `elicit_required` was raised against, keyed the way a token
 *  is later minted for it (vault + args_hash + caller). Upsert: the newest request wins. An empty
 *  `stateFp` records that a request WAS raised with nothing to bind (a tool declaring
 *  `confirmationTargets: "none"`), which is what lets the headless mint tell it from no request. */
export function recordElicitRequest(
  db: Database,
  input: {
    vaultId: string;
    argsHash: string;
    caller: string | null;
    stateFp: string;
    now?: () => number;
  },
): void {
  const now = (input.now ?? Date.now)();
  db.prepare(
    `INSERT INTO elicit_requests (vault_id, args_hash, caller, state_fp, raised_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (vault_id, args_hash, caller)
     DO UPDATE SET state_fp = excluded.state_fp, raised_at = excluded.raised_at`,
  ).run(input.vaultId, input.argsHash, input.caller ?? "", input.stateFp, now);
  db.prepare("DELETE FROM elicit_requests WHERE raised_at < ?").run(now - REQUEST_RETENTION_MS);
}

function requestedRow(
  db: Database,
  vaultId: string,
  argsHash: string,
  caller: string | null,
): { state_fp: string } | undefined {
  return db
    .prepare(
      "SELECT state_fp FROM elicit_requests WHERE vault_id = ? AND args_hash = ? AND caller = ?",
    )
    .get(vaultId, argsHash, caller ?? "") as { state_fp: string } | undefined;
}

/** Whether `elicit_required` was raised for this (vault, args_hash, caller) within retention. */
export function hasRaisedElicitRequest(
  db: Database,
  vaultId: string,
  argsHash: string,
  caller: string | null,
): boolean {
  return requestedRow(db, vaultId, argsHash, caller) !== undefined;
}

/**
 * The `elicit_required` error for a gate that just refused a call, with its target-state
 * fingerprint attached (`details.state_fp`) and recorded for `issueElicitToken`. ONE constructor for
 * dispatch's gate and the handler-side `requireConfirmation`, so both raise the same shape and both
 * bind the request to the state it was raised against. No fingerprint (no probe, or it yields
 * null) leaves the request unbound, as before.
 */
export function elicitRequiredError(
  ctx: Pick<CallerContext, "db" | "vaultId" | "caller" | "now">,
  argsHash: string,
  probe: StateProbe | undefined,
  details: Record<string, unknown>,
): ObsidianTcError {
  const stateFp = probe?.() ?? null;
  const record = () =>
    recordElicitRequest(ctx.db, {
      vaultId: ctx.vaultId,
      argsHash,
      caller: ctx.caller,
      stateFp: stateFp ?? "",
      now: ctx.now,
    });
  if (stateFp !== null) record();
  else {
    // Only the headless mint reads an empty row (as "a request was raised"); losing it fails that
    // mint closed and must not turn this `elicit_required` into an internal error.
    try {
      record();
    } catch {}
  }
  return err.elicitRequired("human confirmation required", {
    ...details,
    ...(stateFp !== null ? { state_fp: stateFp } : {}),
    // The caller the request was raised for: redemption refuses a token minted for any other, and
    // the CLI mint defaults to "stdio", so the rendered mint command has to name it.
    ...(typeof ctx.caller === "string" ? { caller: ctx.caller } : {}),
  });
}

/**
 * Issue a single-use HITL elicit token bound to a specific tool + args_hash,
 * expiring after ttlSeconds (default 5 min). Returns the opaque 32-char token.
 *
 * The token is also bound to the target-state fingerprint recorded when the matching request was
 * raised (see recordElicitRequest), so `obsidian-tc elicit` — which knows only the args_hash —
 * still mints a token that redemption checks for drift. No recorded request means an unbound token.
 */
export function issueElicitToken(db: Database, input: IssueElicitInput): string {
  const now = (input.now ?? Date.now)();
  const ttlMs = (input.ttlSeconds ?? defaultTtlSeconds) * 1000;
  const token = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO elicit_tokens
       (token, vault_id, tool_name, args_hash, proposed_change_json, caller, created_at, expires_at, consumed_at, state_fp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    token,
    input.vaultId,
    input.toolName,
    input.argsHash,
    input.proposedChange === undefined ? null : JSON.stringify(input.proposedChange),
    input.caller,
    now,
    now + ttlMs,
    requestedRow(db, input.vaultId, input.argsHash, input.caller)?.state_fp || null,
  );
  return token;
}

/**
 * Verify and atomically consume an elicit token. It must exist, be unconsumed,
 * be unexpired, belong to the caller's vault, and match the args_hash it was
 * issued for. On success it is marked consumed (single-use) and true returned.
 * The UPDATE ... WHERE consumed_at IS NULL makes redemption race-safe.
 *
 * A token bound to a target-state fingerprint (issueElicitToken) is spent even when redemption
 * fails on it: the state it approved is gone, so it throws `replay_drift` rather than returning
 * false — a caller must be able to tell "never confirmed" from "confirmed, but stale".
 * `currentFp` recomputes the target's present state; absent, a bound token cannot be verified and
 * fails closed the same way.
 */
export function verifyAndConsumeElicit(
  db: Database,
  token: string,
  expectedHash: string,
  vaultId: string,
  expectedCaller: string | null,
  now: () => number = Date.now,
  currentFp?: StateProbe,
): boolean {
  const t = now();
  const row = db
    .prepare(
      "SELECT vault_id, tool_name, args_hash, caller, expires_at, consumed_at, state_fp FROM elicit_tokens WHERE token = ?",
    )
    .get(token) as
    | {
        vault_id: string;
        tool_name: string;
        args_hash: string;
        caller: string | null;
        expires_at: number;
        consumed_at: number | null;
        state_fp: string | null;
      }
    | undefined;
  if (!row) return false;
  if (row.consumed_at !== null) return false;
  if (row.expires_at < t) return false;
  if (row.vault_id !== vaultId) return false;
  // H-3: a token is redeemable only by the caller it was issued to. On a multi-caller HTTP
  // deployment this stops caller B from spending caller A's confirmation (same vault + args_hash).
  if (row.caller !== expectedCaller) return false;
  if (row.args_hash !== expectedHash) return false;
  const res = db
    .prepare("UPDATE elicit_tokens SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL")
    .run(t, token);
  if (res.changes !== 1) return false;
  assertNoReplayDrift(row.state_fp, currentFp, { tool: row.tool_name, args_hash: expectedHash });
  return true;
}

/** Adapter matching the registry's VerifyElicit hook; reads db/vault/now from ctx. */
export function elicitVerifier(
  token: string,
  expectedHash: string,
  ctx: CallerContext,
  currentFp?: StateProbe,
): boolean {
  return verifyAndConsumeElicit(
    ctx.db,
    token,
    expectedHash,
    ctx.vaultId,
    ctx.caller,
    ctx.now ?? Date.now,
    currentFp,
  );
}
