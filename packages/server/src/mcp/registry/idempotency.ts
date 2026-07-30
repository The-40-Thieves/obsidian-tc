import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { cachedPrepare, type Database } from "../../db/types";
import type { IdempotencyState } from "./types";

// WP4.2: the idempotency primitives pulled out of ToolRegistry, unchanged, plus one new function —
// claimOrReplay — that is the actual point of this slice. Before this, the claim path returned bare
// "claimed" | "exists" and runDispatch re-read the row and re-derived the outcome inline across
// ~100 lines: reclaim-and-retry (THE-293), corrupt-blob recovery, and a terminal-overflow replay
// branch all lived in that one block. claimOrReplay lifts that decision into a function returning
// an explicit discriminated state (claimed | mismatch | in_flight | replay), so runDispatch's
// idempotency gate becomes a switch over an already-resolved outcome instead of re-deriving it.
//
// Deliberately NOT lifted here: the ObsidianTcError construction, audit(), meter(), and
// memoizeSerialized() calls that runDispatch performs FOR each outcome — those are dispatch-shaped
// concerns (error codes/messages, metrics, the result-serialization memo that lives in registry.ts
// and would be a cycle to import from here) and stay in runDispatch, unchanged in behavior.

export type { IdempotencyState } from "./types";

/** Coerce a SQLite result column (string | Buffer | Uint8Array) to a UTF-8 string. */
function bufToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array)
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
  return String(v ?? "");
}

/** The whole-operation idempotency key for a call, if any (D3). Reads a top-level
 *  `idempotency_key`, the `bulk_idempotency_key` alias, or a nested
 *  `options.idempotency_key`; never a per-item `items[].idempotency_key`. */
export function extractIdempotencyKey(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  const top = o.idempotency_key ?? o.bulk_idempotency_key;
  if (typeof top === "string" && top.length > 0) return top;
  const opts = o.options;
  if (opts !== null && typeof opts === "object") {
    const nested = (opts as Record<string, unknown>).idempotency_key;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

export interface IdempotencyRow {
  tool_name: string;
  args_hash: string;
  started_at: number;
  completed_at: number | null;
  result: unknown;
  result_size: number | null;
  expires_at: number;
  state: IdempotencyState;
}

/** Try to atomically claim the in-flight idempotency slot for (vault, key). */
export function tryClaimIdempotency(
  db: Database,
  vaultId: string,
  key: string,
  tool: string,
  argsHashValue: string,
  nowMs: number,
  ttlMs: number,
): "claimed" | "exists" {
  try {
    cachedPrepare(
      db,
      "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
    ).run(vaultId, key, tool, argsHashValue, nowMs, nowMs + ttlMs);
    return "claimed";
  } catch (e) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test((e as Error).message)) return "exists";
    throw e;
  }
}

export function readIdempotency(
  db: Database,
  vaultId: string,
  key: string,
): IdempotencyRow | undefined {
  return cachedPrepare(
    db,
    "SELECT tool_name, args_hash, started_at, completed_at, result, result_size, expires_at, state FROM idempotency_keys WHERE vault_id = ? AND key = ?",
  ).get(vaultId, key) as IdempotencyRow | undefined;
}

export function finalizeIdempotency(
  db: Database,
  vaultId: string,
  key: string,
  json: string,
  size: number,
  nowMs: number,
): void {
  cachedPrepare(
    db,
    "UPDATE idempotency_keys SET completed_at = ?, result = ?, result_size = ?, state = 'completed' WHERE vault_id = ? AND key = ?",
  ).run(nowMs, json, size, vaultId, key);
}

/** #13: durable marker set the instant the handler returns — the effect may now be committed.
 *  A crash after this leaves a durable 'effect_committed' row that reclaim honors (never re-runs). */
export function markEffectCommitted(
  db: Database,
  vaultId: string,
  key: string,
  _nowMs: number,
): void {
  cachedPrepare(
    db,
    "UPDATE idempotency_keys SET state = 'effect_committed' WHERE vault_id = ? AND key = ? AND completed_at IS NULL",
  ).run(vaultId, key);
}

/** #13: a post-effect fault finalizes the claim as indeterminate (never deletes it), so a retry
 *  returns indeterminate_outcome instead of re-executing. result_size stays NULL so the overflow
 *  re-check never fires; the state='indeterminate' branch answers first. */
export function finalizeIndeterminate(
  db: Database,
  vaultId: string,
  key: string,
  nowMs: number,
): void {
  cachedPrepare(
    db,
    "UPDATE idempotency_keys SET completed_at = ?, result = 'null', result_size = NULL, state = 'indeterminate' WHERE vault_id = ? AND key = ?",
  ).run(nowMs, vaultId, key);
}

export function deleteIdempotency(db: Database, vaultId: string, key: string): void {
  cachedPrepare(db, "DELETE FROM idempotency_keys WHERE vault_id = ? AND key = ?").run(
    vaultId,
    key,
  );
}

/** The resolved outcome of claiming (or failing to claim) an idempotency key — see claimOrReplay. */
export type IdempotencyClaimResult =
  | { kind: "claimed" }
  /** Same key, different tool or args (D3). */
  | { kind: "mismatch" }
  /** No claimable/replayable row was found — either genuinely in-flight (not yet reclaimable) or a
   *  transient race where the failed claim and the read disagreed. Both throw the identical
   *  `idempotency_in_flight` error at the call site, so they are not distinguished further. */
  | { kind: "in_flight" }
  /** #13: a prior attempt faulted after its effect may have committed (state 'indeterminate' or
   *  'effect_committed') — replay must never re-execute, only report indeterminate_outcome. */
  | { kind: "replay"; outcome: "indeterminate" }
  /** The original call committed its effect but its response exceeded the byte budget. Replay the
   *  SAME overflow error rather than re-executing or returning an absent/oversized payload. */
  | { kind: "replay"; outcome: "overflow"; resultSize: number }
  /** A normal completed call within budget — replay its cached result verbatim. */
  | { kind: "replay"; outcome: "ok"; data: unknown; json: string; resultSize: number };

/**
 * Claim the in-flight slot for (vaultId, key), or resolve what a caller who lost the race should
 * see — as one explicit discriminated state instead of the ~100-line inline re-derivation this
 * replaces in runDispatch. Preserves, byte-for-byte:
 *  - the expired/crashed-row reclaim window (`reclaimMs`, THE-293) and its single retry;
 *  - `indeterminate` and `effect_committed` both resolving to `replay`/`indeterminate`;
 *  - the terminal-overflow replay (a completed row whose result_size exceeds `maxResponseBytes`);
 *  - tool-name/args-hash mismatch resolving to `mismatch`;
 *  - a corrupt cached blob deleting the row and THROWING `internal` (not a returned state) so the
 *    next call re-executes — this is the one path that still throws, matching the original.
 */
export function claimOrReplay(
  db: Database,
  vaultId: string,
  key: string,
  tool: string,
  argsHashValue: string,
  nowMs: number,
  ttlMs: number,
  reclaimMs: number,
  maxResponseBytes: number,
): IdempotencyClaimResult {
  if (tryClaimIdempotency(db, vaultId, key, tool, argsHashValue, nowMs, ttlMs) === "claimed") {
    return { kind: "claimed" };
  }

  let row = readIdempotency(db, vaultId, key);
  // Reclaim an expired or crashed (in-flight past the configured reclaim window) row, then retry
  // once (idempotencyReclaimSeconds, THE-293).
  if (
    row &&
    (row.expires_at <= nowMs ||
      (row.state === "in_flight" &&
        row.completed_at == null &&
        row.started_at + reclaimMs <= nowMs))
  ) {
    deleteIdempotency(db, vaultId, key);
    if (tryClaimIdempotency(db, vaultId, key, tool, argsHashValue, nowMs, ttlMs) === "claimed") {
      return { kind: "claimed" };
    }
    row = readIdempotency(db, vaultId, key);
  }

  if (!row) return { kind: "in_flight" };
  if (row.tool_name !== tool || row.args_hash !== argsHashValue) return { kind: "mismatch" };
  if (row.state === "indeterminate" || row.state === "effect_committed")
    return { kind: "replay", outcome: "indeterminate" };
  if (row.completed_at != null) {
    // Terminal-overflow replay: the original call committed its side effect but its response
    // exceeded the byte budget, so the claim was finalized with the real over-limit size and no
    // payload. A normal success always finalizes with size <= the budget, so this never fires on a
    // legitimate cached result.
    if (row.result_size != null && row.result_size > maxResponseBytes) {
      return { kind: "replay", outcome: "overflow", resultSize: row.result_size };
    }
    try {
      const cachedStr = bufToString(row.result);
      const cached = JSON.parse(cachedStr) as unknown;
      const resultSize = row.result_size ?? Buffer.byteLength(cachedStr, "utf8");
      return { kind: "replay", outcome: "ok", data: cached, json: cachedStr, resultSize };
    } catch {
      // Corrupt cached blob: drop it (so the next call re-executes) and fail this one cleanly.
      deleteIdempotency(db, vaultId, key);
      throw new ObsidianTcError("internal", "cached idempotent result was unreadable; retry");
    }
  }
  return { kind: "in_flight" };
}
