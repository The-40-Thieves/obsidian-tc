// Refresh-token families in oauth.db (design v2 section 4.6). A family starts at the authorization-code
// exchange and rotates on every use; the absolute cap is fixed when it starts and rotation never
// extends it. Only the SHA-256 of a token is stored.
//
// The reuse policy is the design's: the immediately previous token is accepted again only until its
// successor is first used (a client that lost a refresh response retries), and any older token, or
// the previous one after its successor was used, is a reuse that revokes the whole family. The one
// exception is the reuse grace (`auth.as.refreshReuseGraceSeconds`): clients that refresh from several
// windows share one token, so a token the family left by exactly one used step is still answered with
// its successor for that many seconds after the step (the Auth0 reuse interval / Okta grace period).
//
// A retry has to return the successor the first request created, and only the hash is stored, so the
// successor of a token is DERIVED from it and the per-server secret (HMAC): the same parent always
// yields the same child. That makes two simultaneous refreshes of one token, and a retry of a
// response that was lost, the same operation: both get the one successor, and the family never
// holds two live tokens for one step. Knowing a token already lets the holder rotate it, so the
// derivation gives nothing a holder did not have; the secret never leaves the host.
//
// The window is IDEMPOTENT: the response that created a successor (its access token included) is kept
// sealed on the successor's row (as-refresh-replay.ts), so every retry of the parent gets that same
// response and mints nothing. And a row records the fingerprint of the server secret that minted it
// and is honoured only while that is still the secret: replacing the secret retires every family.
import { createHmac, randomBytes } from "node:crypto";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { sha256Hex } from "../provenance/store";
import { consumeCode } from "./as-grants";

export const DAY_MS = 86_400_000;
/** A refresh token as this server mints it: 32 random bytes, base64url. */
export const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const newRefreshToken = (): string => randomBytes(32).toString("base64url");

/** The one successor of `parent` (see the header). */
export const successorToken = (secret: string, parent: string): string =>
  createHmac("sha256", secret).update(`as-refresh-successor\0${parent}`).digest("base64url");

const INSERT_TOKEN = `INSERT INTO refresh_tokens
  (token_hash, family_id, grant_id, parent_hash, scope, issued_at, family_expires_at, secret_gen, replay)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export interface NewFamily {
  codeHash: string;
  grantId: string;
  /** The first refresh token of the family; absent for a client that did not register for refresh tokens. */
  token: string | undefined;
  scope: string;
  now: number;
  days: number;
  /** `secretGeneration` of the server secret that minted the token. */
  secretGen: string;
}

/**
 * Consume the code AND start its family, as one transaction: a code is spent only if its refresh
 * token exists (when it gets one), and no refresh token exists for a code that was not spent. False when the code was
 * already used or the grant was revoked meanwhile (the caller treats it as a replay).
 */
export function consumeCodeAndStartFamily(db: Database, f: NewFamily): boolean {
  return inWriteTransaction(db, "as_grants", () => {
    const grant = db.prepare("SELECT revoked_at FROM grants WHERE id = ?").get(f.grantId) as
      | { revoked_at: number | null }
      | undefined;
    if (grant === undefined || grant.revoked_at !== null) return false;
    if (!consumeCode(db, f.codeHash, f.now)) return false;
    // No refresh token: the code is spent and the family is just its access tokens.
    if (f.token === undefined) return true;
    db.prepare(INSERT_TOKEN).run(
      sha256Hex(f.token),
      f.codeHash,
      f.grantId,
      null,
      f.scope,
      f.now,
      f.now + f.days * DAY_MS,
      f.secretGen,
      null,
    );
    return true;
  });
}

export interface RefreshRecord {
  tokenHash: string;
  familyId: string;
  grantId: string;
  parentHash: string | null;
  scope: string;
  familyExpiresAt: number;
  successorFirstUsedAt: number | null;
  revokedAt: number | null;
  secretGen: string | null;
  clientId: string;
  sub: string;
  persona: string | null;
  vault: string | null;
  /** The resource the grant was consented for: every access token of the family carries it as `aud`. */
  resource: string;
  grantRevoked: boolean;
}

export function loadRefresh(db: Database, token: string): RefreshRecord | undefined {
  const row = db
    .prepare(
      `SELECT r.token_hash AS tokenHash, r.family_id AS familyId, r.grant_id AS grantId,
              r.parent_hash AS parentHash, r.scope, r.family_expires_at AS familyExpiresAt,
              r.successor_first_used_at AS successorFirstUsedAt, r.revoked_at AS revokedAt,
              r.secret_gen AS secretGen,
              g.client_id AS clientId, g.sub, g.persona, g.vault, g.resource,
              g.revoked_at IS NOT NULL AS grantRevoked
         FROM refresh_tokens r JOIN grants g ON g.id = r.grant_id WHERE r.token_hash = ?`,
    )
    .get(sha256Hex(token)) as
    | (Omit<RefreshRecord, "grantRevoked"> & { grantRevoked: number })
    | undefined;
  return row === undefined ? undefined : { ...row, grantRevoked: row.grantRevoked === 1 };
}

/**
 * The stored response that created the successor of `parentHash`, still sealed (null: none, or the
 * window already closed).
 */
export function loadReplay(db: Database, parentHash: string): string | null {
  const row = db
    .prepare("SELECT replay FROM refresh_tokens WHERE parent_hash = ? LIMIT 1")
    .get(parentHash) as { replay: string | null } | undefined;
  return row?.replay ?? null;
}

/**
 * What presenting `cur` means right now: `rotate` (no successor yet: the normal case), `retry` (its
 * successor exists and has not been used: the window), `reuse` (its successor was used: revoke the
 * family), `foreign` (minted under a server secret that is no longer this server's, or before rows
 * recorded one: the family is retired, revoke it) or `dead` (revoked, expired, its grant revoked, or
 * a successor this server cannot hand out again; refuse, revoke nothing more).
 */
export type Standing = "rotate" | "retry" | "reuse" | "foreign" | "dead";

export interface StandingInput {
  successor: string;
  secretGen: string;
  now: number;
  /** `auth.as.refreshReuseGraceSeconds` in ms; 0 is no grace (see `standing`). */
  graceMs: number;
}

export function standing(db: Database, cur: RefreshRecord, at: StandingInput): Standing {
  const { successor, secretGen, now, graceMs } = at;
  if (cur.revokedAt !== null || cur.grantRevoked || cur.familyExpiresAt <= now) return "dead";
  if (cur.secretGen !== secretGen) return "foreign";
  const child = db
    .prepare(
      "SELECT token_hash, successor_first_used_at AS childUsedAt FROM refresh_tokens WHERE parent_hash = ? LIMIT 1",
    )
    .get(cur.tokenHash) as { token_hash: string; childUsedAt: number | null } | undefined;
  if (child === undefined) return "rotate";
  // The grace: the family moved past `cur` (its successor was used) at most `graceMs` ago and by that
  // one step only, so a second window still holding the token the family just left is answered with
  // the successor again. A token older than that, or presented later, is a reuse.
  const age = cur.successorFirstUsedAt === null ? -1 : now - cur.successorFirstUsedAt;
  const graced = graceMs > 0 && child.childUsedAt === null && age >= 0 && age < graceMs;
  if (cur.successorFirstUsedAt !== null && !graced) return "reuse";
  return child.token_hash === sha256Hex(successor) ? "retry" : "dead";
}

/**
 * Apply a use of `token`: re-decide under the write lock (a revocation or another use may have won
 * since the caller looked), create the successor on `rotate` (with `replay`, the sealed response that
 * carries it), record that the PARENT's successor has now been used, which is what closes the
 * parent's window, and drop the stored response this row itself carried. Returns the standing it
 * acted on.
 */
export function useRefresh(
  db: Database,
  a: {
    token: string;
    successor: string;
    secretGen: string;
    replay: string;
    now: number;
    graceMs: number;
  },
): Standing {
  return inWriteTransaction(db, "as_grants", () => {
    const cur = loadRefresh(db, a.token);
    if (cur === undefined) return "dead";
    const st = standing(db, cur, a);
    if (st !== "rotate") return st;
    db.prepare(INSERT_TOKEN).run(
      sha256Hex(a.successor),
      cur.familyId,
      cur.grantId,
      cur.tokenHash,
      cur.scope,
      a.now,
      cur.familyExpiresAt,
      a.secretGen,
      a.replay,
    );
    // The stored response of `cur` answers a retry of its parent. Without a grace it goes now (the
    // parent's window closes with this use); with one it stays, still sealed, until `cur`'s own
    // successor is used, and it is the PARENT's stored response that is no longer reachable.
    const spent = a.graceMs > 0 ? cur.parentHash : cur.tokenHash;
    if (spent !== null) {
      db.prepare("UPDATE refresh_tokens SET replay = NULL WHERE token_hash = ?").run(spent);
    }
    if (cur.parentHash !== null) {
      db.prepare(
        "UPDATE refresh_tokens SET successor_first_used_at = COALESCE(successor_first_used_at, ?) WHERE token_hash = ?",
      ).run(a.now, cur.parentHash);
    }
    return st;
  });
}
