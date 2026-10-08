// `<cacheDir>/oauth.db`: the bundled authorization server's own store (design v2 section 4.8).
//
// A fourth database file, beside cache.db, experiential.db and auth.db, with its own migration chain
// (OAUTH_MIGRATION_FILES) and WAL like every database opened through the shared adapter. It differs
// from auth.db in the one way that matters here: losing it is FAIL-SAFE. Grants, refresh tokens,
// dynamically registered clients and the operator password vanish, so clients sign in again after
// the account is re-claimed; access tokens already issued expire on their own and revocations live
// in auth.db. So there is no lost-registry marker and nothing refuses: a missing file is simply
// created fresh, unclaimed. Back it up beside auth.db and auth-keys/ all the same.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../package.json";
import { openConfiguredDatabase } from "../db/open";
import { provisionOauthDb } from "../db/provision";
import type { Database } from "../db/types";
import { type AuthRegistry, summarizeScopes } from "./registry";
import { AS_KEY_SKEW_SECONDS } from "./signing-keys";

type OauthCfg = Pick<ServerConfig, "cacheDir" | "db">;

const DAY_MS = 86_400_000;
/** Year 5138 in seconds; any epoch-milliseconds value of this century is far above it. */
const MAX_EPOCH_SECONDS = 1e11;

/**
 * How long past a token's `exp` its `issued_access` row survives the sweep: the 60 s skew the design
 * allows when sizing an `as` key's rotation window (section 4.2). A verifier whose clock lags still
 * accepts the token for that long, and the row is what lets a code or refresh-token replay find the
 * jti and revoke it, so deleting it at `exp` exactly would orphan a token that is still live.
 */
export const ISSUED_ACCESS_GC_GRACE_MS = AS_KEY_SKEW_SECONDS * 1000;

export const oauthDbPath = (cacheDir: string): string => join(cacheDir, "oauth.db");

export interface OpenedOauthDb {
  db: Database;
  /** Release the handle. */
  close(): void;
}

/** Open (creating on first use) and provision oauth.db. Never refuses for a missing file. */
export async function openOauthDb(cfg: OauthCfg): Promise<OpenedOauthDb> {
  const db = await openConfiguredDatabase(cfg, "oauth.db", { ownerOnly: true });
  try {
    provisionOauthDb(db, { version: VERSION });
  } catch (e) {
    db.close?.();
    throw e;
  }
  return { db, close: () => db.close?.() };
}

/**
 * Has the authorization server been claimed: does at least one ENABLED operator exist? This is the
 * one definition `doctor` and (in later slices) the authorize, token and register routes share, so
 * "unclaimed" means the same thing everywhere: the routes refuse until it is false.
 */
export function isClaimed(db: Database): boolean {
  const row = db.prepare("SELECT 1 AS present FROM users WHERE disabled_at IS NULL LIMIT 1").get();
  return row !== undefined;
}

export interface OauthGcCounts {
  sessions: number;
  authRequests: number;
  cimdCache: number;
  dcrClients: number;
  authCodes: number;
  refreshTokens: number;
  issuedAccess: number;
  total: number;
}

/**
 * Housekeeping for oauth.db, run on the maintenance sweep and at boot: deletes expired pending
 * requests, authorization codes, sessions and metadata-document cache rows; dynamically registered
 * clients unused for `dcrUnusedDays` (a client never used counts from its creation); refresh-token
 * rows past their family's absolute cap; and access-token jtis once `ISSUED_ACCESS_GC_GRACE_MS` has
 * passed their expiry (nothing can accept the token, or need the jti to revoke it, after that). Deliberately NOT deleted: users, setup state and grants, since a grant is
 * the operator's remembered consent. Statements are independent and idempotent, so a crash between
 * two of them only leaves the rest for the next pass.
 */
export function gcOauthDb(
  db: Database,
  opts: { now: number; dcrUnusedDays: number },
): OauthGcCounts {
  const { now } = opts;
  const dcrCutoff = now - opts.dcrUnusedDays * DAY_MS;
  const del = (sql: string, ...params: unknown[]): number => db.prepare(sql).run(...params).changes;
  const counts = {
    sessions: del("DELETE FROM sessions WHERE expires_at <= ?", now),
    authRequests: del("DELETE FROM auth_requests WHERE expires_at <= ?", now),
    cimdCache: del("DELETE FROM cimd_cache WHERE expires_at <= ?", now),
    dcrClients: del(
      "DELETE FROM oauth_clients WHERE kind = 'dcr' AND (COALESCE(last_used_at, created_at) < ? OR (expires_at IS NOT NULL AND expires_at <= ?))",
      dcrCutoff,
      now,
    ),
    authCodes: del("DELETE FROM auth_codes WHERE expires_at <= ?", now),
    refreshTokens: del("DELETE FROM refresh_tokens WHERE family_expires_at <= ?", now),
    issuedAccess: del(
      "DELETE FROM issued_access WHERE expires_at <= ?",
      now - ISSUED_ACCESS_GC_GRACE_MS,
    ),
  };
  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/** An access token the authorization server has just signed. `iat`/`exp` are the JWT claims as
 *  issued: NumericDate, SECONDS since the epoch (the tables below hold milliseconds). */
export interface IssuedAccessToken {
  jti: string;
  /** The `as` key's kid the token was signed with. */
  kid: string;
  sub: string;
  /** The token's `scope` claim (space-separated). */
  scope: string;
  /** The refresh-token family (or the code's, for the first token) it was issued from. */
  familyId: string;
  grantId: string;
  iat: number;
  exp: number;
}

/**
 * Record an access token BEFORE it is returned to the client; the token endpoint must not hand the
 * token out if this throws. Two records, in this order: the registry (auth.db), so `token list` and
 * `token revoke` and the verifier's revoked-set see the jti, then `issued_access` (oauth.db), which
 * maps family to jtis so a replayed code or refresh token can revoke every token already out. A
 * crash between the two leaves a registry row for a token that was never issued, which is harmless.
 *
 * `exp` is stored as milliseconds, and the sweep (`gcOauthDb`) keeps the row for
 * `ISSUED_ACCESS_GC_GRACE_MS` past it, so housekeeping cannot orphan a live token. An `exp` that is
 * not an integer number of seconds (the usual mistake is milliseconds) is refused outright: stored as
 * given it would look expired 1000x too late, or in the other direction too early.
 */
export function recordIssuedAccess(
  db: Database,
  registry: Pick<AuthRegistry, "recordToken">,
  t: IssuedAccessToken,
): void {
  const seconds = (n: number): boolean => Number.isSafeInteger(n) && n > 0 && n < MAX_EPOCH_SECONDS;
  if (!seconds(t.exp) || !seconds(t.iat)) {
    throw new Error(
      `recordIssuedAccess: iat and exp are JWT NumericDates in whole seconds, got iat=${t.iat} exp=${t.exp}`,
    );
  }
  registry.recordToken({
    jti: t.jti,
    kid: t.kid,
    sub: t.sub,
    scopesSummary: summarizeScopes(t.scope.split(" ").filter(Boolean)),
    issuedAt: t.iat * 1000,
    expiresAt: t.exp * 1000,
  });
  db.prepare(
    "INSERT INTO issued_access (jti, family_id, grant_id, expires_at) VALUES (?, ?, ?, ?)",
  ).run(t.jti, t.familyId, t.grantId, t.exp * 1000);
}

/** What `doctor` shows about oauth.db. Read-only: creates and changes nothing. */
export interface OauthDbProbe {
  path: string;
  exists: boolean;
  claimed: boolean;
  /** Why the file cannot be read although it exists (not a SQLite file, a malformed image). */
  unreadable?: string;
}

export async function probeOauthDb(cfg: OauthCfg): Promise<OauthDbProbe> {
  const path = oauthDbPath(cfg.cacheDir);
  if (!existsSync(path)) return { path, exists: false, claimed: false };
  let db: Database | undefined;
  try {
    db = await openConfiguredDatabase(cfg, "oauth.db", { readonly: true });
    return { path, exists: true, claimed: isClaimed(db) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A database that simply has no tables yet (never provisioned) is unclaimed, not unreadable.
    if (/no such table/i.test(msg)) return { path, exists: true, claimed: false };
    return { path, exists: true, claimed: false, unreadable: msg };
  } finally {
    db?.close?.();
  }
}
