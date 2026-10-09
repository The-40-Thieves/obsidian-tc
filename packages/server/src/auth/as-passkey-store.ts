// The operator's passkeys and the pending WebAuthn challenges in oauth.db (design v2 section 4.11):
// the `webauthn_credentials` and `webauthn_challenges` tables. Nothing here verifies a ceremony
// (as-passkey.ts does); this is the state around it: a challenge is single-use and short-lived, a
// credential's sign count only ever moves forward, and a login completes only while the credential,
// the account and its counter are still what the ceremony verified.

import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { sha256Hex } from "../provenance/store";
import { drainRevocations, queueGrantRevocation } from "./as-grants";
import {
  createSession,
  deleteSession,
  type SessionGuard,
  sessionIsCurrent,
} from "./as-operator-store";
import type { AuthRegistry } from "./registry";

/** How long an unanswered challenge lives. */
export const CHALLENGE_TTL_MS = 5 * 60_000;
/**
 * Challenges outstanding at once, per purpose; past it, new ones of that purpose are refused until
 * some are answered or expire. Login challenges are handed to anyone who loads the login page, so
 * they get their own room: a flood of them can fill that, and only that, never enrolment's.
 */
export const MAX_PENDING_LOGIN_CHALLENGES = 400;
export const MAX_PENDING_REGISTER_CHALLENGES = 100;

export type ChallengePurpose = "register" | "login";

const CAP: Record<ChallengePurpose, number> = {
  login: MAX_PENDING_LOGIN_CHALLENGES,
  register: MAX_PENDING_REGISTER_CHALLENGES,
};

/**
 * Remember a challenge until it is answered. Returns false when the store already holds the cap for
 * this purpose in live ones (an unauthenticated caller can ask for login options, so the table is
 * bounded rather than trusting callers to be polite), or, for an enrolment challenge issued under a
 * `session`, when that session has ended by the time the row is written.
 */
export function storeChallenge(
  db: Database,
  input: {
    challenge: string;
    purpose: ChallengePurpose;
    sub: string | null;
    now: number;
    session?: SessionGuard;
  },
): boolean {
  return inWriteTransaction(db, "as_passkey", () => {
    if (input.session !== undefined && !sessionIsCurrent(db, input.session, input.now)) {
      return false;
    }
    db.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").run(input.now);
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = ?")
      .get(input.purpose) as { n: number };
    if (live.n >= CAP[input.purpose]) return false;
    db.prepare(
      "INSERT INTO webauthn_challenges (challenge_hash, purpose, sub, expires_at) VALUES (?, ?, ?, ?)",
    ).run(sha256Hex(input.challenge), input.purpose, input.sub, input.now + CHALLENGE_TTL_MS);
    return true;
  });
}

/**
 * Take a challenge out of the store: one statement deletes it and reports whom it was issued to, so
 * a challenge answers once however many requests race for it. Undefined when it was never issued, is
 * for another purpose, has expired, or was already answered.
 */
export function takeChallenge(
  db: Database,
  input: { challenge: string; purpose: ChallengePurpose; now: number },
): { sub: string | null } | undefined {
  return db
    .prepare(
      "DELETE FROM webauthn_challenges WHERE challenge_hash = ? AND purpose = ? AND expires_at > ? RETURNING sub",
    )
    .get(sha256Hex(input.challenge), input.purpose, input.now) as
    | { sub: string | null }
    | undefined;
}

export interface StoredCredential {
  credentialId: string;
  sub: string;
  /** The COSE public key, base64url. */
  publicKey: string;
  signCount: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

interface CredentialRow {
  credentialId: string;
  sub: string;
  publicKey: string;
  signCount: number;
  transports: string | null;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: number;
  createdAt: number;
  lastUsedAt: number | null;
}

const COLUMNS = `credential_id AS credentialId, sub, public_key AS publicKey, sign_count AS signCount,
  transports, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt,
  last_used_at AS lastUsedAt`;

function parseTransports(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const toCredential = (r: CredentialRow): StoredCredential => ({
  ...r,
  transports: parseTransports(r.transports),
  backedUp: r.backedUp !== 0,
});

/** One operator's credentials, oldest first. */
export function listCredentials(db: Database, sub: string): StoredCredential[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM webauthn_credentials WHERE sub = ? ORDER BY created_at, rowid`)
    .all(sub) as CredentialRow[];
  return rows.map(toCredential);
}

/** The credential with this id, whoever owns it. */
export function findCredential(db: Database, credentialId: string): StoredCredential | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM webauthn_credentials WHERE credential_id = ?`)
    .get(credentialId) as CredentialRow | undefined;
  return row === undefined ? undefined : toCredential(row);
}

export type AddCredentialResult =
  | { ok: true }
  | { ok: false; reason: "duplicate" | "no_account" | "session_ended" };

/**
 * Store a freshly registered credential, if the account is still enabled, the id is new and the
 * `session` the registration was made under is still current: a reset or password change that landed
 * while the (unsigned, so forgeable) attestation was being checked ended it, and nothing is stored.
 */
export function addCredential(
  db: Database,
  input: Omit<StoredCredential, "lastUsedAt"> & { session: SessionGuard },
): AddCredentialResult {
  return inWriteTransaction(db, "as_passkey", (): AddCredentialResult => {
    const account = db
      .prepare("SELECT 1 AS present FROM users WHERE sub = ? AND disabled_at IS NULL")
      .get(input.sub);
    if (account === undefined) return { ok: false, reason: "no_account" };
    if (input.session.sub !== input.sub || !sessionIsCurrent(db, input.session, input.createdAt)) {
      return { ok: false, reason: "session_ended" };
    }
    if (findCredential(db, input.credentialId) !== undefined) {
      return { ok: false, reason: "duplicate" };
    }
    db.prepare(
      `INSERT INTO webauthn_credentials
         (credential_id, sub, public_key, sign_count, transports, device_type, backed_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.credentialId,
      input.sub,
      input.publicKey,
      input.signCount,
      JSON.stringify(input.transports),
      input.deviceType,
      input.backedUp ? 1 : 0,
      input.createdAt,
    );
    return { ok: true };
  });
}

/** Remove one of an operator's credentials. True when it existed and was theirs. */
export function removeCredential(db: Database, sub: string, credentialId: string): boolean {
  return (
    db
      .prepare("DELETE FROM webauthn_credentials WHERE credential_id = ? AND sub = ?")
      .run(credentialId, sub).changes > 0
  );
}

export interface PasskeyLogin {
  credentialId: string;
  sub: string;
  /** The counter the authenticator reported in the verified assertion. */
  newCounter: number;
  backedUp: boolean;
  /** The session id the browser presented, retired in the same step. */
  replaces?: string;
  now: number;
}

/**
 * Complete a passkey login the instant it is still true: the account is enabled, the credential is
 * still the operator's (a reset that landed while the ceremony ran deleted it), and its stored
 * counter still lets this one through (`0` then `0`, or strictly greater). The counter update, the
 * retirement of the presented session and the new session are ONE `BEGIN IMMEDIATE` transaction, so
 * two assertions that report the same counter cannot both win. Returns the new session id, or
 * undefined when the login must be refused.
 */
export function finalizePasskeyLogin(db: Database, input: PasskeyLogin): string | undefined {
  return inWriteTransaction(db, "as_passkey", () => {
    const account = db
      .prepare("SELECT 1 AS present FROM users WHERE sub = ? AND disabled_at IS NULL")
      .get(input.sub);
    if (account === undefined) return undefined;
    const moved = db
      .prepare(
        `UPDATE webauthn_credentials
            SET sign_count = ?, last_used_at = ?, backed_up = ?
          WHERE credential_id = ? AND sub = ?
            AND (sign_count < ? OR (sign_count = 0 AND ? = 0))`,
      )
      .run(
        input.newCounter,
        input.now,
        input.backedUp ? 1 : 0,
        input.credentialId,
        input.sub,
        input.newCounter,
        input.newCounter,
      );
    if (moved.changes === 0) return undefined;
    if (input.replaces !== undefined) deleteSession(db, input.replaces);
    return createSession(db, input.sub, input.now);
  });
}

export interface CredentialsReset {
  credentials: number;
  sessions: number;
  /** Present when the reset also revoked the operator's grants. */
  grants?: { revoked: number; families: number; accessTokens: number };
}

/**
 * The reset (design v2 section 4.11.5, item 2) in ONE transaction: the new password hash, the user's
 * credential generation moved on, every session ended, every passkey deleted, every pending challenge
 * issued to the operator dropped and, with `revoke`, every live grant of the operator revoked with its
 * refresh families and the access-token jtis queued in the revocation outbox. Anything that was
 * already running on one of the ended sessions re-checks the session inside its own write transaction
 * (`sessionIsCurrent`), so it either committed before this transaction (and the grant it made is
 * revoked here) or finds the session gone. A login that began before the reset cannot finish after
 * it: it needs the credential row, and the sessions it would join are gone. The outbox is drained
 * into the registry after the commit, as for `revokeGrant`.
 */
export function resetOperatorCredentials(
  db: Database,
  sub: string,
  passwordHash: string,
  opts: {
    revoke?: { registry: Pick<AuthRegistry, "revoke">; reason: string; now: number };
  } = {},
): CredentialsReset {
  const out = inWriteTransaction(db, "as_passkey", (): CredentialsReset => {
    db.prepare(
      "UPDATE users SET password_hash = ?, credential_gen = credential_gen + 1 WHERE sub = ?",
    ).run(passwordHash, sub);
    const sessions = db.prepare("DELETE FROM sessions WHERE sub = ?").run(sub).changes;
    const credentials = db
      .prepare("DELETE FROM webauthn_credentials WHERE sub = ?")
      .run(sub).changes;
    db.prepare("DELETE FROM webauthn_challenges WHERE sub = ?").run(sub);
    if (opts.revoke === undefined) return { credentials, sessions };
    const { reason, now } = opts.revoke;
    const grants = { revoked: 0, families: 0, accessTokens: 0 };
    const live = db
      .prepare("SELECT id FROM grants WHERE sub = ? AND revoked_at IS NULL")
      .all(sub) as Array<{ id: string }>;
    for (const { id } of live) {
      const r = queueGrantRevocation(db, id, reason, now);
      if (r.status === "revoked") grants.revoked++;
      grants.families += r.families;
      grants.accessTokens += r.accessTokens;
    }
    return { credentials, sessions, grants };
  });
  if (opts.revoke !== undefined) drainRevocations(db, opts.revoke.registry);
  return out;
}
