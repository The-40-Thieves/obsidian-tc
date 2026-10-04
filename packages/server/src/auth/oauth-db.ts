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

type OauthCfg = Pick<ServerConfig, "cacheDir" | "db">;

const DAY_MS = 86_400_000;

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
 * rows past their family's absolute cap; and access-token jtis past their own expiry (nothing can
 * need them after that). Deliberately NOT deleted: users, setup state and grants, since a grant is
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
    issuedAccess: del("DELETE FROM issued_access WHERE expires_at <= ?", now),
  };
  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
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
