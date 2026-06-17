import { randomBytes } from "node:crypto";
import type { Database } from "./db/types";
import type { CallerContext } from "./mcp/registry";

/** 5 minutes (G2.4 A.3). */
const DEFAULT_TTL_SECONDS = 300;

export interface IssueElicitInput {
  vaultId: string;
  toolName: string;
  argsHash: string;
  caller: string | null;
  proposedChange?: unknown;
  ttlSeconds?: number;
  now?: () => number;
}

/**
 * Issue a single-use HITL elicit token bound to a specific tool + args_hash,
 * expiring after ttlSeconds (default 5 min). Returns the opaque 32-char token.
 */
export function issueElicitToken(db: Database, input: IssueElicitInput): string {
  const now = (input.now ?? Date.now)();
  const ttlMs = (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const token = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO elicit_tokens
       (token, vault_id, tool_name, args_hash, proposed_change_json, caller, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    token,
    input.vaultId,
    input.toolName,
    input.argsHash,
    input.proposedChange === undefined ? null : JSON.stringify(input.proposedChange),
    input.caller,
    now,
    now + ttlMs,
  );
  return token;
}

/**
 * Verify and atomically consume an elicit token. It must exist, be unconsumed,
 * be unexpired, belong to the caller's vault, and match the args_hash it was
 * issued for. On success it is marked consumed (single-use) and true returned.
 * The UPDATE ... WHERE consumed_at IS NULL makes redemption race-safe.
 */
export function verifyAndConsumeElicit(
  db: Database,
  token: string,
  expectedHash: string,
  vaultId: string,
  now: () => number = Date.now,
): boolean {
  const t = now();
  const row = db
    .prepare(
      "SELECT vault_id, args_hash, expires_at, consumed_at FROM elicit_tokens WHERE token = ?",
    )
    .get(token) as
    | { vault_id: string; args_hash: string; expires_at: number; consumed_at: number | null }
    | undefined;
  if (!row) return false;
  if (row.consumed_at !== null) return false;
  if (row.expires_at < t) return false;
  if (row.vault_id !== vaultId) return false;
  if (row.args_hash !== expectedHash) return false;
  const res = db
    .prepare("UPDATE elicit_tokens SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL")
    .run(t, token);
  return res.changes === 1;
}

/** Adapter matching the registry's VerifyElicit hook; reads db/vault/now from ctx. */
export function elicitVerifier(token: string, expectedHash: string, ctx: CallerContext): boolean {
  return verifyAndConsumeElicit(ctx.db, token, expectedHash, ctx.vaultId, ctx.now ?? Date.now);
}
