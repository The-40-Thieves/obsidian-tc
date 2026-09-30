// Signing-key and issued-token (jti) registry, backed by the `auth_keys` and `auth_tokens` tables in
// `<cacheDir>/auth.db`. It is what lets a minted token be revoked before it expires, and what lets
// more than one signing key be valid at once.
//
// auth.db is NOT cache.db. cache.db is disposable (operators are told to `rm cache.db*`), and this
// registry is authored operator state: deleting it would un-retire keys and un-revoke tokens for
// every vault. So the registry lives in its own file, and losing that file FAILS CLOSED: once the
// registry has ever been initialised (a sentinel file, or any `*.key` file, in `<cacheDir>/auth-keys/`
// -- both OUTSIDE the database), an auth.db that is missing or holds no rows is refused with
// `registry_lost` instead of being read as "never rotated, the configured secret verifies
// everything". Only a deployment that has never initialised the registry keeps that legacy path.
//
// Two lookups happen on EVERY authenticated request, both primary-key reads on auth.db: the token's
// `kid` (which key verifies it) and its `jti` (is it revoked). Nothing about the database is cached
// in process, so a revocation written by one process is visible to every other process sharing the
// file on their next request. A key file's secret is not cached either: it is re-read, and its
// trust re-checked on the open descriptor, on every verify (auth/key-files.ts).
//
// No key material lives in the database. See the `auth_keys` migration header.
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { inTransaction } from "../db/txn";
import { cachedPrepare, type Database } from "../db/types";
import { AuthRejection } from "./jwt";
import {
  createKeyFile,
  ensureKeysDir,
  existsNoFollow,
  KeyFileError,
  keyFileNames,
  readKeyFile,
} from "./key-files";

/** Reserved kid for the deployment's configured `auth.jwtSecret`. */
export const CONFIG_KID = "config";
const CONFIG_REF = "config";
/** How long a "never initialised" reading is reused before the disk is checked again. */
const UNINITIALISED_TTL_MS = 1000;
const FILE_REF = /^file:([A-Za-z0-9_-]+\.key)$/;

export type KeyState = "active" | "retiring" | "retired";

/** `uninitialised`: never used, the configured secret is the only key. `ok`: rows present.
 *  `lost`: initialised before (sentinel / key files exist) but auth.db holds nothing. */
export type RegistryHealth =
  | { state: "uninitialised" }
  | { state: "ok" }
  | { state: "lost"; detail: string };

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
  /** null on a tombstone (a jti revoked without ever having been issued here). */
  kid: string | null;
  sub: string | null;
  scopesSummary: string;
  issuedAt: number | null;
  expiresAt: number | null;
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

/** The registry's own database file: NOT regenerable, back it up. */
export function authDbPath(cacheDir: string): string {
  return join(cacheDir, "auth.db");
}

/** Marker written the first time the registry is used (first key rotation, first recorded token,
 *  first revocation). Lives beside the key files, outside the database, so that losing the database
 *  is detectable. */
export function registrySentinelPath(keysDir: string): string {
  return join(keysDir, ".registry-initialized");
}

/** Has this deployment ever used the registry? The sentinel, or any key file, says yes. */
export function registryInitialized(keysDir: string): boolean {
  return existsNoFollow(registrySentinelPath(keysDir)) || keyFileNames(keysDir).length > 0;
}

/** The operator-facing explanation of a lost registry, naming the recovery. */
export function registryLostMessage(keysDir: string): string {
  return (
    `the auth registry was initialised (${keysDir}) but auth.db is missing or empty: revocations and ` +
    "key retirements are gone, so every token is refused rather than trusted. restore auth.db from " +
    `backup. Only if you accept that revoked tokens and retired keys become valid again, remove ${keysDir} ` +
    "to return to the configured auth.jwtSecret alone."
  );
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
  kid: string | null;
  sub: string | null;
  scopes_summary: string;
  issued_at: number | null;
  expires_at: number | null;
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
  /** Per-request: is this jti revoked? Throws if the registry tables are missing or the registry
   *  is lost (fail closed). */
  isRevoked(jti: string): boolean;
  /** Per-request: the HS256 key that verifies a token naming `kid`. Throws `AuthRejection`. */
  verificationKey(kid: string | undefined): Uint8Array;
  /** The key `token mint` signs with: the active key, or the config key while the registry is empty. */
  signingKey(): { kid: string; secret: string };
  recordToken(t: Omit<AuthTokenRecord, "revokedAt" | "revokedReason">): void;
  /** Revoke by jti. A jti this registry never issued gets a tombstone (`tombstoned`), so tokens
   *  minted before the registry, or by an external issuer, can be revoked too. Idempotent on an
   *  already-revoked jti. */
  revoke(jti: string, reason: string | null): "revoked" | "already_revoked" | "tombstoned";
  listTokens(opts?: { includeExpired?: boolean }): AuthTokenRecord[];
  listKeys(): AuthKey[];
  /** Generate a new active key; the previous one becomes `retiring` for `graceSeconds`. */
  rotateKey(opts?: { graceSeconds?: number }): RotateResult;
  /** Is the registry usable, never used, or lost? */
  health(): RegistryHealth;
}

/** A registry whose database is gone: every operation refuses with the recovery in the message.
 *  Used at serve time when the sentinel says the registry existed but auth.db is missing. */
export function createLostAuthRegistry(keysDir: string): AuthRegistry {
  const message = registryLostMessage(keysDir);
  const refuse = (): never => {
    throw new Error(message);
  };
  return {
    isRevoked: () => {
      throw new AuthRejection("registry_lost");
    },
    verificationKey: () => {
      throw new AuthRejection("registry_lost");
    },
    signingKey: refuse,
    recordToken: refuse,
    revoke: refuse,
    listTokens: refuse,
    listKeys: refuse,
    rotateKey: refuse,
    health: () => ({ state: "lost", detail: message }),
  };
}

export function createAuthRegistry(db: Database, opts: AuthRegistryOptions = {}): AuthRegistry {
  const now = opts.now ?? Date.now;
  const q = (sql: string) => cachedPrepare(db, sql);
  const keysDir = opts.keysDir;

  const configKey = (): AuthKey => ({
    kid: CONFIG_KID,
    alg: "HS256",
    keyRef: CONFIG_REF,
    createdAt: 0,
    state: "active",
    retireAfter: null,
  });
  /** The secret for `key`. Key-file secrets are re-read and re-judged on EVERY call: a chmod, a
   *  swapped-in symlink or a deleted file is seen on the next request, not at the next restart. */
  const loadSecret = (key: AuthKey): string => {
    if (key.keyRef === CONFIG_REF) {
      if (!opts.configSecret) throw new AuthRejection("misconfigured");
      return opts.configSecret;
    }
    const m = FILE_REF.exec(key.keyRef);
    if (!m || !keysDir) throw new AuthRejection("misconfigured");
    return readKeyFile(join(keysDir, m[1] as string));
  };

  const hasRows = (): boolean =>
    q("SELECT 1 AS x FROM auth_keys LIMIT 1").get() !== undefined ||
    q("SELECT 1 AS x FROM auth_tokens LIMIT 1").get() !== undefined;
  // Rows in a database we hold open cannot vanish under us (a deleted file stays readable through
  // this connection), so once rows have been seen there is nothing left to re-check.
  let sawRows = false;
  // A never-initialised deployment would otherwise pay two SELECTs, an lstat and a readdir on every
  // request to re-learn that nothing exists. `uninitialised` is remembered for a second: it can only
  // turn into `lost` if the database file under this connection is replaced by an empty one WHILE
  // the sentinel appears, which a one-second detection delay does not change. Our own writes clear it.
  let uninitialisedUntil = 0;
  const health = (): RegistryHealth => {
    if (sawRows) return { state: "ok" };
    if (uninitialisedUntil > Date.now()) return { state: "uninitialised" };
    if (hasRows()) {
      sawRows = true;
      return { state: "ok" };
    }
    if (keysDir !== undefined && registryInitialized(keysDir)) {
      return { state: "lost", detail: registryLostMessage(keysDir) };
    }
    uninitialisedUntil = Date.now() + UNINITIALISED_TTL_MS;
    return { state: "uninitialised" };
  };
  /** Refuse (throw the operator message) when the registry is lost; the guard in front of every
   *  path that would otherwise read an empty table as "never used". */
  const assertNotLost = (): void => {
    const h = health();
    if (h.state === "lost") throw new Error(h.detail);
  };
  const keysEmpty = (): boolean => q("SELECT 1 AS x FROM auth_keys LIMIT 1").get() === undefined;

  /** Write the sentinel. Returns true when THIS call created it, so a failed write can undo it. */
  const markInitialized = (): boolean => {
    if (keysDir === undefined) return false;
    ensureKeysDir(keysDir, { create: true });
    const path = registrySentinelPath(keysDir);
    if (existsNoFollow(path)) return false;
    createKeyFile(path, `${new Date(now()).toISOString()}\n`);
    return true;
  };
  const undoSentinel = (created: boolean): void => {
    if (!created || keysDir === undefined) return;
    try {
      unlinkSync(registrySentinelPath(keysDir));
    } catch {
      /* the original error is the one worth reporting */
    }
  };
  /** Run a first-or-later registry write and arm the sentinel in the same unit: if either fails the
   *  database change rolls back and a sentinel this call created is removed, so a failed first
   *  write can never lock a deployment out of its own configured secret. */
  const writeAndArm = <T>(write: () => T): T => {
    let created = false;
    try {
      const out = inTransaction(db, () => {
        const written = write();
        created = markInitialized();
        return written;
      });
      uninitialisedUntil = 0;
      return out;
    } catch (e) {
      undoSentinel(created);
      throw e;
    }
  };

  const listKeys = (): AuthKey[] =>
    (q(`SELECT ${KEY_COLS} FROM auth_keys ORDER BY created_at, kid`).all() as KeyRow[]).map(toKey);

  return {
    health,

    isRevoked(jti) {
      const r = q("SELECT revoked_at FROM auth_tokens WHERE jti = ?").get(jti) as
        | { revoked_at: number | null }
        | undefined;
      if (r !== undefined) return r.revoked_at != null;
      // No row for this jti. In a lost registry that means nothing (every revocation is gone), so
      // it must not read as "not revoked".
      if (health().state === "lost") throw new AuthRejection("registry_lost");
      return false;
    },

    verificationKey(kid) {
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE kid = ?`).get(kid ?? CONFIG_KID) as
        | KeyRow
        | undefined;
      try {
        if (row === undefined) {
          // Empty AND never initialised: a deployment that never rotated, so the configured secret
          // verifies everything it always did, whatever `kid` (if any) the token names. Empty but
          // initialised is a lost registry, which is refused, not trusted.
          if (keysEmpty()) {
            if (health().state === "lost") throw new AuthRejection("registry_lost");
            return new TextEncoder().encode(loadSecret(configKey()));
          }
          throw new AuthRejection("unknown_key");
        }
        sawRows = true;
        const key = toKey(row);
        // A `retiring` key verifies only inside its window; one with no window at all is treated as
        // retired (fail closed), never as live forever.
        const live =
          key.state === "active" ||
          (key.state === "retiring" && key.retireAfter !== null && now() < key.retireAfter);
        if (!live) throw new AuthRejection("key_retired");
        return new TextEncoder().encode(loadSecret(key));
      } catch (e) {
        if (e instanceof KeyFileError) throw new AuthRejection("misconfigured", { cause: e });
        throw e;
      }
    },

    signingKey() {
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE state = 'active'`).get() as
        | KeyRow
        | undefined;
      if (row !== undefined) return { kid: row.kid, secret: loadSecret(toKey(row)) };
      assertNotLost();
      if (!keysEmpty() || !opts.configSecret) {
        throw new Error("no active signing key: run `auth rotate-key`");
      }
      return { kid: CONFIG_KID, secret: opts.configSecret };
    },

    recordToken(t) {
      assertNotLost();
      writeAndArm(() =>
        q(
          "INSERT INTO auth_tokens (jti, kid, sub, scopes_summary, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(t.jti, t.kid, t.sub, t.scopesSummary, t.issuedAt, t.expiresAt),
      );
    },

    revoke(jti, reason) {
      assertNotLost();
      return writeAndArm(() => {
        const res = q(
          "UPDATE auth_tokens SET revoked_at = ?, revoked_reason = ? WHERE jti = ? AND revoked_at IS NULL",
        ).run(now(), reason, jti);
        if (res.changes > 0) return "revoked" as const;
        if (q("SELECT 1 AS x FROM auth_tokens WHERE jti = ?").get(jti) !== undefined) {
          return "already_revoked" as const;
        }
        // Never issued here: pre-registry token, or an external issuer's. Record the decision so
        // the verifier rejects it whenever it appears.
        q("INSERT INTO auth_tokens (jti, revoked_at, revoked_reason) VALUES (?, ?, ?)").run(
          jti,
          now(),
          reason,
        );
        return "tombstoned" as const;
      });
    },

    listTokens({ includeExpired = false } = {}) {
      const sql = `SELECT jti, kid, sub, scopes_summary, issued_at, expires_at, revoked_at, revoked_reason
         FROM auth_tokens ${includeExpired ? "" : "WHERE expires_at IS NULL OR expires_at > ?"} ORDER BY issued_at DESC, jti`;
      const rows = (includeExpired ? q(sql).all() : q(sql).all(now())) as TokenRow[];
      return rows.map(toToken);
    },

    listKeys,

    rotateKey({ graceSeconds = 0 } = {}) {
      if (!keysDir) throw new Error("rotate-key needs a cache directory to store the new key");
      assertNotLost();
      const t = now();
      const kid = `k_${randomBytes(8).toString("hex")}`;
      const file = `${kid}.key`;
      ensureKeysDir(keysDir, { create: true });
      const path = join(keysDir, file);
      createKeyFile(path, randomBytes(32).toString("base64url"));
      try {
        return writeAndArm(() => {
          // First rotation of a deployment that has only ever used the configured secret: enrol it
          // as the `config` key so it is the one being retired, not silently forgotten.
          if (keysEmpty() && opts.configSecret) {
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
