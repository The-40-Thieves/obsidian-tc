// The operator account and its login sessions in oauth.db (design v2 sections 4.5 and 4.8): the
// `users`, `setup_state` and `sessions` tables. Every secret is stored as a SHA-256 or a PHC string,
// never as itself. The claim is ONE write transaction shared by the CLI and `/oauth/setup`, so a
// first-run race has exactly one winner whichever door each contender used and however many
// processes share the file.
import { randomBytes } from "node:crypto";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { sha256Hex } from "../provenance/store";

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 3_600_000;

const USERNAME_RE = /^[a-z0-9._@-]{1,64}$/;

/** The canonical form of an operator name (trimmed, lower-cased), or undefined when it is not one. */
export function normalizeUsername(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  return USERNAME_RE.test(name) ? name : undefined;
}

export type ClaimResult =
  | { ok: true; sub: string }
  | { ok: false; reason: "already_claimed" | "token_used" | "username_taken" };

export interface ClaimInput {
  username: string;
  passwordHash: string;
  now: number;
  /** SHA-256 of the setup token that authorises this claim; absent for a claim from the CLI. */
  setupTokenHash?: string;
}

/**
 * Create the operator, if and only if the server is still unclaimed (no enabled user) and, for a
 * setup-token claim, the token has not been burned. Check and insert run in one `BEGIN IMMEDIATE`
 * transaction, so a second contender sees the first one's row (or waits for its lock) instead of
 * racing it. A used token's hash stays recorded in `setup_state` even if the user is later removed.
 */
export function claimOperator(db: Database, input: ClaimInput): ClaimResult {
  return inWriteTransaction(db, "as_operator", (): ClaimResult => {
    if (db.prepare("SELECT 1 AS present FROM users WHERE disabled_at IS NULL LIMIT 1").get()) {
      return { ok: false, reason: "already_claimed" };
    }
    if (input.setupTokenHash !== undefined && tokenBurned(db, input.setupTokenHash)) {
      return { ok: false, reason: "token_used" };
    }
    if (db.prepare("SELECT 1 AS present FROM users WHERE username = ?").get(input.username)) {
      return { ok: false, reason: "username_taken" };
    }
    const sub = `usr_${randomBytes(16).toString("base64url")}`;
    db.prepare(
      "INSERT INTO users (sub, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run(sub, input.username, input.passwordHash, input.now);
    db.prepare(
      `INSERT INTO setup_state (id, claimed_at, setup_token_hash_used) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET claimed_at = excluded.claimed_at,
         setup_token_hash_used = COALESCE(excluded.setup_token_hash_used, setup_token_hash_used)`,
    ).run(input.now, input.setupTokenHash ?? null);
    return { ok: true, sub };
  });
}

/** Has a setup token with this SHA-256 already claimed the server (and so is burned for good)? */
export function tokenBurned(db: Database, tokenHash: string): boolean {
  const row = db
    .prepare("SELECT setup_token_hash_used AS used FROM setup_state WHERE id = 1")
    .get() as { used: string | null } | undefined;
  return row?.used === tokenHash;
}

export interface Operator {
  sub: string;
  username: string;
  passwordHash: string;
}

/** The ENABLED user with this canonical name. A disabled one is, to every caller, no user at all. */
export function findOperator(db: Database, username: string): Operator | undefined {
  const row = db
    .prepare(
      "SELECT sub, username, password_hash AS passwordHash FROM users WHERE username = ? AND disabled_at IS NULL",
    )
    .get(username) as Operator | undefined;
  return row;
}

/** The only enabled user, or undefined when none or more than one exists (a later slice adds users). */
export function soleOperator(db: Database): Operator | undefined {
  const rows = db
    .prepare(
      "SELECT sub, username, password_hash AS passwordHash FROM users WHERE disabled_at IS NULL LIMIT 2",
    )
    .all() as Operator[];
  return rows.length === 1 ? rows[0] : undefined;
}

/** Replace a user's password hash and end every session they hold, in one transaction. */
export function setOperatorPassword(db: Database, sub: string, passwordHash: string): void {
  inWriteTransaction(db, "as_operator", () => {
    db.prepare("UPDATE users SET password_hash = ? WHERE sub = ?").run(passwordHash, sub);
    db.prepare("DELETE FROM sessions WHERE sub = ?").run(sub);
  });
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const isSessionId = (v: string | undefined): v is string =>
  v !== undefined && SESSION_ID_RE.test(v);

/** Open a session for `sub` and return its id, the only time the id exists outside the browser. */
export function createSession(db: Database, sub: string, now: number): string {
  const id = randomBytes(32).toString("base64url");
  db.prepare(
    "INSERT INTO sessions (id_hash, sub, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sha256Hex(id), sub, now, now, now + SESSION_ABSOLUTE_MS);
  return id;
}

export interface LoginFinalization {
  sub: string;
  /** The exact stored hash the presented password was verified against. */
  verifiedHash: string;
  /** A stronger hash of that same password, stored in the same step when the old one is weak. */
  upgradedHash?: string;
  /** The session id the browser presented, retired in the same step. */
  replaces?: string;
  now: number;
}

/**
 * Complete a login the instant it is still true: the user is enabled and still holds exactly the
 * hash that was verified. A password reset or a disable that landed while the (slow) verification
 * ran changes one of those, so the login yields nothing: no session, and the new password is not
 * overwritten by a rehash of the old one. The check, the optional rehash, the retirement of the
 * presented session and the new session are one `BEGIN IMMEDIATE` transaction. Returns the new
 * session id, or undefined when the account moved on.
 */
export function finalizeLogin(db: Database, input: LoginFinalization): string | undefined {
  return inWriteTransaction(db, "as_operator", () => {
    const current = db
      .prepare(
        "SELECT 1 AS present FROM users WHERE sub = ? AND password_hash = ? AND disabled_at IS NULL",
      )
      .get(input.sub, input.verifiedHash);
    if (current === undefined) return undefined;
    if (input.upgradedHash !== undefined) {
      db.prepare("UPDATE users SET password_hash = ? WHERE sub = ?").run(
        input.upgradedHash,
        input.sub,
      );
    }
    if (input.replaces !== undefined) deleteSession(db, input.replaces);
    return createSession(db, input.sub, input.now);
  });
}

export interface SessionInfo {
  sub: string;
  username: string;
  idHash: string;
  /** When this session was opened, i.e. when the operator last typed the password. */
  createdAt: number;
}

/**
 * The live session behind a presented id, sliding its idle clock; or undefined. Validation and the
 * touch are ONE statement, so a session revoked (deleted, its user disabled or its password reset)
 * by another connection can never be returned: either the row was live when the touch landed, or
 * nothing is. A session past its idle or absolute limit, or whose user is gone or disabled, is
 * deleted on the spot.
 */
export function lookupSession(db: Database, id: string, now: number): SessionInfo | undefined {
  const idHash = sha256Hex(id);
  // An id nobody holds is answered from a read, so a forged cookie never takes the write lock.
  if (db.prepare("SELECT 1 AS present FROM sessions WHERE id_hash = ?").get(idHash) === undefined) {
    return undefined;
  }
  const row = db
    .prepare(
      `UPDATE sessions SET last_seen_at = ?
        WHERE id_hash = ? AND expires_at > ? AND last_seen_at > ?
          AND EXISTS (SELECT 1 FROM users u WHERE u.sub = sessions.sub AND u.disabled_at IS NULL)
        RETURNING sub, created_at AS createdAt, (SELECT username FROM users u WHERE u.sub = sessions.sub) AS username`,
    )
    .get(now, idHash, now, now - SESSION_IDLE_MS) as
    | { sub: string; username: string; createdAt: number }
    | undefined;
  if (row === undefined) {
    db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    return undefined;
  }
  return { sub: row.sub, username: row.username, idHash, createdAt: row.createdAt };
}

export function deleteSession(db: Database, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256Hex(id));
}
