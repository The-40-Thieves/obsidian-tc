// The authorization state in oauth.db that /oauth/authorize, /oauth/consent and /oauth/token share
// (design v2 sections 4.3 and 4.8): pending requests, grants, authorization codes, and the
// family revocation a replayed code triggers. Every secret (request handle, code) is stored as its
// SHA-256 only. Each function that must be all-or-nothing or single-use is ONE write transaction,
// so two processes sharing the file cannot both win a race.
import { randomBytes } from "node:crypto";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { sha256Hex } from "../provenance/store";
import { splitScope } from "./as-clients";
import type { AuthRegistry } from "./registry";

export const PENDING_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
/**
 * Unauthenticated GETs create pending rows, so admission is bounded three ways: a TCP peer holds at
 * most `perSource` live rows, a client at most `perClient`, and the table at most `global`, of which
 * the last `reserved` slots go only to a source that holds nothing, so no mix of sources and clients
 * that each stay under their own quota can lock a newcomer out. A peer that is unknown or loopback
 * (a proxy or tunnel on the same host) is not blamed on anyone: only the client quota binds it.
 */
export interface AdmissionLimits {
  global: number;
  reserved: number;
  perClient: number;
  perSource: number;
}
export const MAX_PENDING_REQUESTS = 1000;
export const RESERVED_PENDING_SLOTS = 100;
export const MAX_PENDING_PER_CLIENT = 250;
export const MAX_PENDING_PER_SOURCE = 20;
const DEFAULT_LIMITS: AdmissionLimits = {
  global: MAX_PENDING_REQUESTS,
  reserved: RESERVED_PENDING_SLOTS,
  perClient: MAX_PENDING_PER_CLIENT,
  perSource: MAX_PENDING_PER_SOURCE,
};
/** A first grant for a client needs a sign-in at most this old. */
export const FRESH_LOGIN_MS = 5 * 60_000;

const random = (): string => randomBytes(32).toString("base64url");

export interface PendingRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  codeChallenge: string;
  state: string | null;
}

interface PendingRow {
  client_id: string;
  redirect_uri: string;
  scope: string;
  resource: string;
  code_challenge: string;
  state: string | null;
}

const pendingOf = (r: PendingRow): PendingRequest => ({
  clientId: r.client_id,
  redirectUri: r.redirect_uri,
  scopes: splitScope(r.scope),
  resource: r.resource,
  codeChallenge: r.code_challenge,
  state: r.state,
});

/**
 * Store a validated request and return its handle (the only time it exists outside the browser), or
 * undefined when admission is refused. `source` is the TCP peer address. The purge of expired rows, the
 * quota counts and the insert are ONE `BEGIN IMMEDIATE` transaction, so two processes sharing the file
 * cannot both pass a count the other is about to invalidate, and the table never carries expired rows
 * for longer than the next admission.
 */
export function createPending(
  db: Database,
  p: PendingRequest,
  now: number,
  source?: string,
  limits: AdmissionLimits = DEFAULT_LIMITS,
): string | undefined {
  const sourceHash = source === undefined ? null : sha256Hex(`as-source:${source}`);
  return inWriteTransaction(db, "as_grants", () => {
    db.prepare("DELETE FROM auth_requests WHERE expires_at <= ?").run(now);
    const n = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(client_id = ?), 0) AS client,
                COALESCE(SUM(source_hash IS ?), 0) AS source
           FROM auth_requests`,
      )
      .get(p.clientId, sourceHash) as { total: number; client: number; source: number };
    if (n.total >= limits.global) return undefined;
    if (n.client >= limits.perClient) return undefined;
    if (sourceHash !== null && n.source >= limits.perSource) return undefined;
    if (n.total >= limits.global - limits.reserved && n.source > 0) return undefined;
    const handle = random();
    db.prepare(
      `INSERT INTO auth_requests
         (handle_hash, client_id, redirect_uri, scope, resource, code_challenge, state, created_at, expires_at, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha256Hex(handle),
      p.clientId,
      p.redirectUri,
      p.scopes.join(" "),
      p.resource,
      p.codeChallenge,
      p.state,
      now,
      now + PENDING_TTL_MS,
      sourceHash,
    );
    return handle;
  });
}

export function loadPending(db: Database, handle: string, now: number): PendingRequest | undefined {
  const row = db
    .prepare(
      "SELECT client_id, redirect_uri, scope, resource, code_challenge, state FROM auth_requests WHERE handle_hash = ? AND expires_at > ?",
    )
    .get(sha256Hex(handle), now) as PendingRow | undefined;
  return row === undefined ? undefined : pendingOf(row);
}

/** Consume a request without approving it (the operator pressed Deny). Single use. */
export function discardPending(
  db: Database,
  handle: string,
  now: number,
): PendingRequest | undefined {
  const row = db
    .prepare(
      "DELETE FROM auth_requests WHERE handle_hash = ? AND expires_at > ? RETURNING client_id, redirect_uri, scope, resource, code_challenge, state",
    )
    .get(sha256Hex(handle), now) as PendingRow | undefined;
  return row === undefined ? undefined : pendingOf(row);
}

export interface Grant {
  id: string;
  scopes: string[];
  persona: string | null;
  vault: string | null;
}

interface GrantRow {
  id: string;
  scope: string;
  persona: string | null;
  vault: string | null;
}
const grantOf = (r: GrantRow): Grant => ({
  id: r.id,
  scopes: splitScope(r.scope),
  persona: r.persona,
  vault: r.vault,
});

export interface GrantKey {
  sub: string;
  clientId: string;
  /** `redirectKey` of the redirect URI: a loopback port is not part of a remembered consent. */
  redirectKey: string;
  resource: string;
}

/** Every live grant of this client and redirect for this user, newest first. */
export function liveGrants(db: Database, k: GrantKey): Grant[] {
  return (
    db
      .prepare(
        `SELECT id, scope, persona, vault FROM grants
          WHERE sub = ? AND client_id = ? AND redirect_uri = ? AND resource = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .all(k.sub, k.clientId, k.redirectKey, k.resource) as GrantRow[]
  ).map(grantOf);
}

export interface Approval {
  handle: string;
  key: GrantKey;
  scopes: string[];
  persona: string | null;
  vault: string | null;
  now: number;
  /** A remembered grant that already covers the request: used as is, never widened. */
  reuse?: Grant;
}

export interface Approved {
  code: string;
  pending: PendingRequest;
  grantId: string;
}

/**
 * Turn a pending request into an authorization code, atomically: take the request (so a handle
 * approves once), create the grant or extend the one with the same persona and vault, and store a
 * 60 s code bound to the request's redirect URI, resource and challenge. Undefined when the request
 * is gone or expired.
 */
export function approveRequest(db: Database, a: Approval): Approved | undefined {
  return inWriteTransaction(db, "as_grants", () => {
    const taken = discardPending(db, a.handle, a.now);
    if (taken === undefined) return undefined;
    let grantId = a.reuse?.id;
    if (grantId === undefined) {
      const same = liveGrants(db, a.key).find(
        (g) => g.persona === a.persona && g.vault === a.vault,
      );
      if (same !== undefined) {
        grantId = same.id;
        const union = [...new Set([...same.scopes, ...a.scopes])].join(" ");
        db.prepare("UPDATE grants SET scope = ? WHERE id = ?").run(union, same.id);
      } else {
        grantId = random();
        db.prepare(
          `INSERT INTO grants (id, sub, client_id, redirect_uri, scope, resource, persona, vault, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          grantId,
          a.key.sub,
          a.key.clientId,
          a.key.redirectKey,
          a.scopes.join(" "),
          a.key.resource,
          a.persona,
          a.vault,
          a.now,
        );
      }
    }
    const code = random();
    db.prepare(
      `INSERT INTO auth_codes (code_hash, grant_id, request_scope, redirect_uri, resource, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha256Hex(code),
      grantId,
      a.scopes.join(" "),
      taken.redirectUri,
      taken.resource,
      taken.codeChallenge,
      a.now + CODE_TTL_MS,
    );
    return { code, pending: taken, grantId };
  });
}

export interface CodeRecord {
  codeHash: string;
  grantId: string;
  clientId: string;
  sub: string;
  persona: string | null;
  vault: string | null;
  scope: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  expiresAt: number;
  usedAt: number | null;
  grantRevoked: boolean;
}

export function loadCode(db: Database, code: string): CodeRecord | undefined {
  const row = db
    .prepare(
      `SELECT c.code_hash AS codeHash, c.grant_id AS grantId, g.client_id AS clientId, g.sub, g.persona,
              g.vault, c.request_scope AS scope, c.redirect_uri AS redirectUri, c.resource,
              c.code_challenge AS codeChallenge, c.expires_at AS expiresAt, c.used_at AS usedAt,
              g.revoked_at IS NOT NULL AS grantRevoked
         FROM auth_codes c JOIN grants g ON g.id = c.grant_id WHERE c.code_hash = ?`,
    )
    .get(sha256Hex(code)) as
    | (Omit<CodeRecord, "grantRevoked"> & { grantRevoked: number })
    | undefined;
  return row === undefined ? undefined : { ...row, grantRevoked: row.grantRevoked === 1 };
}

/** Mark the code used if, and only if, it is still unused and unexpired: the single-use gate. */
export function consumeCode(db: Database, codeHash: string, now: number): boolean {
  return (
    db
      .prepare(
        "UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      )
      .run(now, codeHash, now).changes === 1
  );
}

/**
 * Revoke everything issued from a code or a refresh-token family (RFC 6749 section 4.1.2, RFC 9700
 * section 4.14): the family's refresh tokens die and each access token's `jti` goes to the registry's
 * revoked set. The family id is the code's hash. The tokens are marked FIRST and the jtis read after:
 * an exchange or refresh in flight records its jti before it commits, so either it commits before the
 * marking (and its jti is read below) or it finds its token revoked at commit, refuses, and revokes
 * the jti it recorded itself. Neither order leaves a live access token behind.
 */
export function revokeFamily(
  db: Database,
  registry: Pick<AuthRegistry, "revoke">,
  familyId: string,
  reason: string,
  now: number,
): number {
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
  ).run(now, familyId);
  const jtis = db
    .prepare("SELECT jti FROM issued_access WHERE family_id = ?")
    .all(familyId) as Array<{ jti: string }>;
  for (const { jti } of jtis) registry.revoke(jti, reason);
  return jtis.length;
}

export interface GrantSummary {
  id: string;
  sub: string;
  username: string | null;
  clientId: string;
  redirectUri: string;
  scope: string;
  persona: string | null;
  vault: string | null;
  createdAt: number;
  revokedAt: number | null;
  /** Refresh-token families of this grant that are neither revoked nor past their cap. */
  liveFamilies: number;
}

/** The grants (newest first): live ones, or every one with `all`. */
export function listGrants(db: Database, opts: { now: number; all?: boolean }): GrantSummary[] {
  return db
    .prepare(
      `SELECT g.id, g.sub, u.username, g.client_id AS clientId, g.redirect_uri AS redirectUri,
              g.scope, g.persona, g.vault, g.created_at AS createdAt, g.revoked_at AS revokedAt,
              (SELECT COUNT(DISTINCT r.family_id) FROM refresh_tokens r
                WHERE r.grant_id = g.id AND r.revoked_at IS NULL AND r.family_expires_at > ?) AS liveFamilies
         FROM grants g LEFT JOIN users u ON u.sub = g.sub
        ${opts.all === true ? "" : "WHERE g.revoked_at IS NULL"}
        ORDER BY g.created_at DESC, g.rowid DESC`,
    )
    .all(opts.now) as GrantSummary[];
}

export interface GrantRevocation {
  status: "revoked" | "already_revoked" | "not_found";
  /** Refresh-token families revoked. */
  families: number;
  /** Access-token jtis revoked (the ones still recorded; expired ones have been swept). */
  accessTokens: number;
}

/**
 * Revoke a grant: it can issue no more (its codes and refresh tokens are refused), and every family
 * issued under it is revoked with its access tokens. Safe to repeat: a second call re-sweeps and
 * reports `already_revoked`. The grant is marked first, so a refresh in flight refuses at commit.
 */
export function revokeGrant(
  db: Database,
  registry: Pick<AuthRegistry, "revoke">,
  grantId: string,
  reason: string,
  now: number,
): GrantRevocation {
  const row = db.prepare("SELECT revoked_at FROM grants WHERE id = ?").get(grantId) as
    | { revoked_at: number | null }
    | undefined;
  if (row === undefined) return { status: "not_found", families: 0, accessTokens: 0 };
  db.prepare("UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(
    now,
    grantId,
  );
  const families = db
    .prepare(
      `SELECT family_id FROM refresh_tokens WHERE grant_id = ?
       UNION SELECT family_id FROM issued_access WHERE grant_id = ?`,
    )
    .all(grantId, grantId) as Array<{ family_id: string }>;
  let accessTokens = 0;
  for (const { family_id } of families) {
    accessTokens += revokeFamily(db, registry, family_id, reason, now);
  }
  return {
    status: row.revoked_at === null ? "revoked" : "already_revoked",
    families: families.length,
    accessTokens,
  };
}
