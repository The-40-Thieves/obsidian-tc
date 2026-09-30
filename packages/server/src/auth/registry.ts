// Signing-key and issued-token (jti) registry, backed by the `auth_keys` and `auth_tokens` tables in
// cache.db. It is what lets a minted token be revoked before it expires, and what lets more than one
// signing key be valid at once.
//
// Two lookups happen on EVERY authenticated request, both primary-key reads on the shared cache.db:
// the token's `kid` (which key verifies it) and its `jti` (is it revoked). Nothing is cached in
// process, so a revocation written by one process is visible to every other process sharing the
// database on their next request: max staleness is zero, bounded only by SQLite's commit visibility.
// (The key SECRET is cached per kid, but a kid's secret never changes once written.)
//
// No key material lives in the database. See the `auth_keys` migration header.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inTransaction } from "../db/txn";
import { cachedPrepare, type Database } from "../db/types";
import { AuthRejection } from "./jwt";

/** Reserved kid for the deployment's configured `auth.jwtSecret`. */
export const CONFIG_KID = "config";
const CONFIG_REF = "config";
const FILE_REF = /^file:([A-Za-z0-9_-]+\.key)$/;

export type KeyState = "active" | "retiring" | "retired";

export interface AuthKey {
  kid: string;
  alg: string;
  keyRef: string;
  createdAt: number;
  state: KeyState;
  /** Epoch ms after which a `retiring` key stops verifying. */
  retireAfter: number | null;
}

export interface AuthTokenRecord {
  jti: string;
  kid: string;
  sub: string | null;
  scopesSummary: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface AuthRegistryOptions {
  /** The configured `auth.jwtSecret`, the initial key (kid `config`). */
  configSecret?: string;
  /** Directory holding `<kid>.key` files (0600). Absent -> only the config key is usable. */
  keysDir?: string;
  now?: () => number;
}

export function authKeysDir(cacheDir: string): string {
  return join(cacheDir, "auth-keys");
}

export function summarizeScopes(scopes: readonly string[]): string {
  const joined = scopes.join(",");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

type KeyRow = {
  kid: string;
  alg: string;
  key_ref: string;
  created_at: number;
  state: KeyState;
  retire_after: number | null;
};
const toKey = (r: KeyRow): AuthKey => ({
  kid: r.kid,
  alg: r.alg,
  keyRef: r.key_ref,
  createdAt: r.created_at,
  state: r.state,
  retireAfter: r.retire_after,
});
type TokenRow = {
  jti: string;
  kid: string;
  sub: string | null;
  scopes_summary: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
};
const toToken = (r: TokenRow): AuthTokenRecord => ({
  jti: r.jti,
  kid: r.kid,
  sub: r.sub,
  scopesSummary: r.scopes_summary,
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
});

const KEY_COLS = "kid, alg, key_ref, created_at, state, retire_after";

export interface RotateResult {
  kid: string;
  previousKid: string | null;
  /** Epoch ms the previous key stops verifying; null when there was no previous key. */
  previousRetireAfter: number | null;
}

export interface AuthRegistry {
  /** Per-request: is this jti revoked? Throws if the registry tables are missing (fail closed). */
  isRevoked(jti: string): boolean;
  /** Per-request: the HS256 key that verifies a token naming `kid`. Throws `AuthRejection`. */
  verificationKey(kid: string | undefined): Uint8Array;
  /** The key `token mint` signs with: the active key, or the config key while the registry is empty. */
  signingKey(): { kid: string; secret: string };
  recordToken(t: Omit<AuthTokenRecord, "revokedAt" | "revokedReason">): void;
  /** Revoke by jti. `unknown` when the jti was never recorded; idempotent on an already-revoked one. */
  revoke(jti: string, reason: string | null): "revoked" | "already_revoked" | "unknown";
  listTokens(opts?: { includeExpired?: boolean }): AuthTokenRecord[];
  listKeys(): AuthKey[];
  /** Generate a new active key; the previous one becomes `retiring` for `graceSeconds`. */
  rotateKey(opts?: { graceSeconds?: number }): RotateResult;
}

export function createAuthRegistry(db: Database, opts: AuthRegistryOptions = {}): AuthRegistry {
  const now = opts.now ?? Date.now;
  const secrets = new Map<string, Uint8Array>();
  const q = (sql: string) => cachedPrepare(db, sql);

  const loadSecret = (key: AuthKey): string => {
    if (key.keyRef === CONFIG_REF) {
      if (!opts.configSecret) throw new AuthRejection("misconfigured");
      return opts.configSecret;
    }
    const m = FILE_REF.exec(key.keyRef);
    if (!m || !opts.keysDir) throw new AuthRejection("misconfigured");
    const path = join(opts.keysDir, m[1] as string);
    // A key file readable by group/other is a leaked key. Refuse it rather than sign or verify
    // with it. POSIX permission bits do not exist on Windows.
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new AuthRejection("misconfigured");
    }
    return readFileSync(path, "utf8").trim();
  };
  const secretFor = (key: AuthKey): Uint8Array => {
    let s = secrets.get(key.kid);
    if (!s) {
      s = new TextEncoder().encode(loadSecret(key));
      secrets.set(key.kid, s);
    }
    return s;
  };
  const registryEmpty = (): boolean =>
    q("SELECT 1 AS x FROM auth_keys LIMIT 1").get() === undefined;
  const listKeys = (): AuthKey[] =>
    (q(`SELECT ${KEY_COLS} FROM auth_keys ORDER BY created_at, kid`).all() as KeyRow[]).map(toKey);

  return {
    isRevoked(jti) {
      const r = q("SELECT revoked_at FROM auth_tokens WHERE jti = ?").get(jti) as
        | { revoked_at: number | null }
        | undefined;
      return r?.revoked_at != null;
    },

    verificationKey(kid) {
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE kid = ?`).get(kid ?? CONFIG_KID) as
        | KeyRow
        | undefined;
      if (row === undefined) {
        // An empty registry is a deployment that never rotated: the configured secret verifies
        // everything it always did, whatever `kid` (if any) the token names.
        if (registryEmpty()) {
          return secretFor({
            kid: CONFIG_KID,
            alg: "HS256",
            keyRef: CONFIG_REF,
            createdAt: 0,
            state: "active",
            retireAfter: null,
          });
        }
        throw new AuthRejection("unknown_key");
      }
      const key = toKey(row);
      const live =
        key.state === "active" ||
        (key.state === "retiring" && (key.retireAfter === null || now() < key.retireAfter));
      if (!live) throw new AuthRejection("key_retired");
      return secretFor(key);
    },

    signingKey() {
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE state = 'active'`).get() as
        | KeyRow
        | undefined;
      if (row !== undefined) {
        const key = toKey(row);
        return { kid: key.kid, secret: new TextDecoder().decode(secretFor(key)) };
      }
      if (!registryEmpty() || !opts.configSecret) {
        throw new Error("no active signing key: run `auth rotate-key`");
      }
      return { kid: CONFIG_KID, secret: opts.configSecret };
    },

    recordToken(t) {
      q(
        "INSERT INTO auth_tokens (jti, kid, sub, scopes_summary, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(t.jti, t.kid, t.sub, t.scopesSummary, t.issuedAt, t.expiresAt);
    },

    revoke(jti, reason) {
      const r = q("SELECT revoked_at FROM auth_tokens WHERE jti = ?").get(jti) as
        | { revoked_at: number | null }
        | undefined;
      if (r === undefined) return "unknown";
      const res = q(
        "UPDATE auth_tokens SET revoked_at = ?, revoked_reason = ? WHERE jti = ? AND revoked_at IS NULL",
      ).run(now(), reason, jti);
      return res.changes > 0 ? "revoked" : "already_revoked";
    },

    listTokens({ includeExpired = false } = {}) {
      const sql = `SELECT jti, kid, sub, scopes_summary, issued_at, expires_at, revoked_at, revoked_reason
         FROM auth_tokens ${includeExpired ? "" : "WHERE expires_at > ?"} ORDER BY issued_at DESC, jti`;
      const rows = (includeExpired ? q(sql).all() : q(sql).all(now())) as TokenRow[];
      return rows.map(toToken);
    },

    listKeys,

    rotateKey({ graceSeconds = 0 } = {}) {
      if (!opts.keysDir) throw new Error("rotate-key needs a cache directory to store the new key");
      const t = now();
      const kid = `k_${randomBytes(8).toString("hex")}`;
      const file = `${kid}.key`;
      mkdirSync(opts.keysDir, { recursive: true, mode: 0o700 });
      const path = join(opts.keysDir, file);
      writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
      try {
        return inTransaction(db, () => {
          // First rotation of a deployment that has only ever used the configured secret: enrol it
          // as the `config` key so it is the one being retired, not silently forgotten.
          if (registryEmpty() && opts.configSecret) {
            q(
              "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state) VALUES (?, 'HS256', ?, ?, 'active')",
            ).run(CONFIG_KID, CONFIG_REF, t);
          }
          const prev = q("SELECT kid FROM auth_keys WHERE state = 'active'").get() as
            | { kid: string }
            | undefined;
          const retireAfter = t + Math.max(0, graceSeconds) * 1000;
          if (prev !== undefined) {
            q("UPDATE auth_keys SET state = ?, retire_after = ? WHERE kid = ?").run(
              graceSeconds > 0 ? "retiring" : "retired",
              retireAfter,
              prev.kid,
            );
          }
          // Settle any earlier window that has already elapsed. Verification does not depend on
          // this (it compares retire_after itself); it keeps `auth list` truthful.
          q(
            "UPDATE auth_keys SET state = 'retired' WHERE state = 'retiring' AND retire_after <= ?",
          ).run(t);
          q(
            "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state) VALUES (?, 'HS256', ?, ?, 'active')",
          ).run(kid, `file:${file}`, t);
          return {
            kid,
            previousKid: prev?.kid ?? null,
            previousRetireAfter: prev === undefined ? null : retireAfter,
          };
        });
      } catch (e) {
        try {
          unlinkSync(path);
        } catch {
          /* the transaction error is the one worth reporting */
        }
        throw e;
      }
    },
  };
}
