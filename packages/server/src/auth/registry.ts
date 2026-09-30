// Signing-key and issued-token (jti) registry, backed by the `auth_keys` and `auth_tokens` tables in
// `<cacheDir>/auth.db`. It is what lets a minted token be revoked before it expires, and what lets
// more than one signing key be valid at once.
//
// auth.db is NOT cache.db. cache.db is disposable (operators are told to `rm cache.db*`), and this
// registry is authored operator state: deleting it would un-retire keys and un-revoke tokens for
// every vault. So the registry lives in its own file, and losing it FAILS CLOSED.
//
// Health is judged PER TABLE from two durable markers in `<cacheDir>/auth-keys/`, OUTSIDE the
// database: `.keys-initialized` (a key was ever rotated in; any `*.key` file also counts) and
// `.tokens-initialized` (a token or revocation was ever written). A table whose marker exists but
// which now holds no rows is refused with `registry_lost`. Judging the two together ("either table
// has a row") let a partial restore through: an emptied `auth_keys` fell back to the configured
// secret and revived the retired key; an emptied `auth_tokens` read every revoked jti as live. Only
// a table never initialised keeps the legacy reading (no keys: the configured secret verifies
// everything; no tokens: nothing is revoked). The one deliberate way back is destructive: remove
// BOTH auth.db and `auth-keys/` (the markers live in it).
//
// A marker is created INSIDE the transaction of the first write it protects (under `BEGIN
// IMMEDIATE`, fsync'd), so no committed row exists without its marker. It is never deleted blindly:
// after a failed write it is removed only once, under the write lock, no other connection is found
// to have committed a row. A marker with no rows fails closed, which is why keeping one is the safe
// direction; a process that dies between creating it and committing leaves exactly that, cleared
// by restoring auth.db or by the destructive recovery above.
//
// Two lookups happen on EVERY authenticated request, both primary-key reads on auth.db: the token's
// `kid` (which key verifies it) and its `jti` (is it revoked). Nothing about the database is cached
// in process, so a revocation written by one process is seen by every other process sharing the
// file on its next request. A key file's secret is cached for at most KEY_FILE_CACHE_TTL_MS and
// re-read, trust re-checked on the open descriptor (auth/key-files.ts).
//
// No key material lives in the database. See the `auth_keys` migration header.
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { inWriteTransaction } from "../db/txn";
import { cachedPrepare, type Database } from "../db/types";
import { AuthRejection } from "./jwt";
import {
  createKeyFile,
  ensureKeysDir,
  existsNoFollow,
  KeyFileError,
  keyFileNames,
  keysDirProblem,
  readKeyFile,
} from "./key-files";

/** Reserved kid for the deployment's configured `auth.jwtSecret`. */
export const CONFIG_KID = "config";
const CONFIG_REF = "config";
/** How long a "never initialised" reading is reused before the disk is checked again. */
const UNINITIALISED_TTL_MS = 1000;
/**
 * The MAXIMUM staleness for a change to a key file to be noticed by a running server: a chmod, a
 * swapped-in symlink or a deleted/replaced file is seen on the first verify after this window. A
 * validated secret is reused for at most this long, then re-read through the full descriptor checks
 * (see key-files.ts). It buys back the open/fstat/read/close syscalls that made a verify with a
 * rotated file key cost roughly +140-180 us over the configured-secret path (measured, loaded box);
 * `rotate-key` and every other process's writes go to new files or to the database, which is never
 * cached, so revocation and retirement stay immediate.
 */
export const KEY_FILE_CACHE_TTL_MS = 1000;
const FILE_REF = /^file:([A-Za-z0-9_-]+\.key)$/;

export type KeyState = "active" | "retiring" | "retired";

/** `uninitialised`: never used, the configured secret is the only key. `ok`: rows present.
 *  `lost`: a table was initialised before (marker / key files exist) but now holds nothing. */
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

/** Which registry table a durable marker protects. */
export type RegistryTable = "keys" | "tokens";

/** Marker written with the first key rotation (`keys`) or the first recorded token or revocation
 *  (`tokens`). Lives beside the key files, outside the database, so that losing a table is
 *  detectable. */
export function registryMarkerPath(keysDir: string, table: RegistryTable): string {
  return join(keysDir, table === "keys" ? ".keys-initialized" : ".tokens-initialized");
}

export interface RegistryInitState {
  /** A key was ever rotated in: the keys marker, or any `*.key` file. */
  keys: boolean;
  /** A token or revocation was ever written: the tokens marker. */
  tokens: boolean;
  /** Set when `keysDir` is a symlink or not a directory. Both tables then count as initialised: an
   *  unusable directory is refused, never read as "nothing was ever here". */
  dirProblem?: string;
}

/** What the durable markers say about this deployment. `lstat` first: a symlink (even to an empty
 *  directory) is a refusal, and is never followed to look for markers or key files. */
export function registryInitState(keysDir: string): RegistryInitState {
  const dirProblem = keysDirProblem(keysDir);
  if (dirProblem !== undefined) return { keys: true, tokens: true, dirProblem };
  return {
    keys: existsNoFollow(registryMarkerPath(keysDir, "keys")) || keyFileNames(keysDir).length > 0,
    tokens: existsNoFollow(registryMarkerPath(keysDir, "tokens")),
  };
}

/** Has this deployment ever used the registry (either table)? */
export function registryInitialized(keysDir: string): boolean {
  const s = registryInitState(keysDir);
  return s.keys || s.tokens;
}

/** The operator-facing explanation of a lost registry, naming the recovery. `cause` says what is
 *  wrong; it defaults to a missing or empty auth.db. */
export function registryLostMessage(
  keysDir: string,
  cause = "auth.db is missing or empty",
): string {
  return (
    `the auth registry was initialised (${keysDir}) but ${cause}: revocations and key retirements ` +
    "are gone, so every token is refused rather than trusted. restore auth.db from backup. " +
    "Only if you accept that revoked tokens and retired keys become valid again, remove BOTH " +
    `auth.db and ${keysDir} to return to the configured auth.jwtSecret alone (destructive).`
  );
}

/** The lost-registry message for a state read from `registryInitState`. */
export function registryLostMessageFor(keysDir: string, state: RegistryInitState): string {
  return state.dirProblem !== undefined
    ? registryLostMessage(keysDir, `the keys directory is unusable (${state.dirProblem})`)
    : registryLostMessage(keysDir);
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
 *  Used at serve time when the markers say the registry existed but auth.db is missing. */
export function createLostAuthRegistry(
  keysDir: string,
  message = registryLostMessage(keysDir),
): AuthRegistry {
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
  // path -> a secret that passed the full key-file checks, and when. Only ever holds a value that
  // `readKeyFile` accepted; expiry and any failed re-read drop it, so a bad file is never served
  // past KEY_FILE_CACHE_TTL_MS.
  const keyCache = new Map<string, { secret: string; checkedAt: number }>();
  const readKeyCached = (path: string): string => {
    const t = now();
    const hit = keyCache.get(path);
    if (hit !== undefined && t >= hit.checkedAt && t - hit.checkedAt < KEY_FILE_CACHE_TTL_MS) {
      return hit.secret;
    }
    keyCache.delete(path);
    const secret = readKeyFile(path);
    keyCache.set(path, { secret, checkedAt: t });
    return secret;
  };
  /** The secret for `key`. A key-file secret is re-read and re-judged (regular file, ours, no
   *  group/other bits, no symlink) at least every KEY_FILE_CACHE_TTL_MS, so a chmod, a swapped-in
   *  symlink or a deleted file is seen within that window, not at the next restart. */
  const loadSecret = (key: AuthKey): string => {
    if (key.keyRef === CONFIG_REF) {
      if (!opts.configSecret) throw new AuthRejection("misconfigured");
      return opts.configSecret;
    }
    const m = FILE_REF.exec(key.keyRef);
    if (!m || !keysDir) throw new AuthRejection("misconfigured");
    return readKeyCached(join(keysDir, m[1] as string));
  };

  const rowSql: Record<RegistryTable, string> = {
    keys: "SELECT 1 AS x FROM auth_keys LIMIT 1",
    tokens: "SELECT 1 AS x FROM auth_tokens LIMIT 1",
  };
  const hasRows = (table: RegistryTable): boolean => q(rowSql[table]).get() !== undefined;
  // A never-initialised table would otherwise pay a SELECT, an lstat and a readdir on every miss to
  // re-learn that nothing exists. `uninitialised` is remembered for a second: it can only turn into
  // `lost` if the database is replaced by an empty one WHILE the marker appears, which a one-second
  // detection delay does not change. Our own writes clear it. Nothing else is cached: a table that
  // empties under a live connection is noticed on the next miss.
  const uninitialisedUntil: Record<RegistryTable, number> = { keys: 0, tokens: 0 };
  /** Re-read the emptiness of `table` while holding the write lock. A marker is created inside the
   *  first write's transaction, BEFORE its commit, so a reader can see "marker, no rows" for the
   *  length of that commit; waiting for the lock resolves it to either committed rows or a real
   *  loss. A lock that cannot be taken (read-only handle, busy timeout) is read as lost: fail closed. */
  const emptyUnderLock = (table: RegistryTable): boolean => {
    try {
      return inWriteTransaction(db, "auth_registry", () => !hasRows(table));
    } catch {
      return true;
    }
  };
  /** The operator message when `table` was initialised but is now empty; undefined otherwise. */
  const lostCause = (table: RegistryTable): string | undefined => {
    if (keysDir === undefined || hasRows(table)) return undefined;
    if (uninitialisedUntil[table] > Date.now()) return undefined;
    const state = registryInitState(keysDir);
    if (!state[table]) {
      uninitialisedUntil[table] = Date.now() + UNINITIALISED_TTL_MS;
      return undefined;
    }
    if (!emptyUnderLock(table)) return undefined;
    if (state.dirProblem !== undefined) return registryLostMessageFor(keysDir, state);
    return registryLostMessage(
      keysDir,
      table === "keys"
        ? "auth.db holds no signing keys"
        : "auth.db holds no token or revocation rows",
    );
  };
  const health = (): RegistryHealth => {
    const detail = lostCause("keys") ?? lostCause("tokens");
    if (detail !== undefined) return { state: "lost", detail };
    return hasRows("keys") || hasRows("tokens") ? { state: "ok" } : { state: "uninitialised" };
  };
  /** Refuse (throw the operator message) when either table is lost; the guard in front of every
   *  path that would otherwise read an empty table as "never used". */
  const assertNotLost = (): void => {
    const detail = lostCause("keys") ?? lostCause("tokens");
    if (detail !== undefined) throw new Error(detail);
  };
  const keysEmpty = (): boolean => !hasRows("keys");

  /** Write the marker for `table`. Returns true when THIS call created it. */
  const markInitialized = (table: RegistryTable): boolean => {
    if (keysDir === undefined) return false;
    ensureKeysDir(keysDir, { create: true });
    const path = registryMarkerPath(keysDir, table);
    if (existsNoFollow(path)) return false;
    createKeyFile(path, `${new Date(now()).toISOString()}\n`);
    return true;
  };
  /** After a failed first write: remove the marker THIS call created, but only if no row landed
   *  under it. The check and the unlink share one write lock, and every other writer creates or
   *  observes its marker under that same lock, so a row committed by another connection is always
   *  seen here and the marker stays. If the check itself cannot run the marker stays: a marker with
   *  no rows fails closed, a missing marker over committed rows would not. */
  const releaseMarker = (table: RegistryTable, created: boolean): void => {
    if (!created || keysDir === undefined) return;
    try {
      inWriteTransaction(db, "auth_registry", () => {
        if (!hasRows(table)) unlinkSync(registryMarkerPath(keysDir, table));
      });
    } catch {
      /* the original error is the one worth reporting */
    }
  };
  /** Run a registry write and arm `table`'s marker in the same unit. `BEGIN IMMEDIATE`, so the
   *  marker is created under the write lock. A failure rolls the rows back and releases the marker
   *  only when nothing else committed under it, so a failed first write never locks a deployment out
   *  of its own configured secret and never strips the marker from another writer's row. */
  const writeAndArm = <T>(table: RegistryTable, write: () => T): T => {
    let created = false;
    try {
      const out = inWriteTransaction(db, "auth_registry", () => {
        const written = write();
        created = markInitialized(table);
        return written;
      });
      uninitialisedUntil.keys = 0;
      uninitialisedUntil.tokens = 0;
      return out;
    } catch (e) {
      releaseMarker(table, created);
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
      // No row for this jti. Once revocations were ever written, an empty auth_tokens means every
      // revocation is gone, so it must not read as "not revoked".
      if (lostCause("tokens") !== undefined) throw new AuthRejection("registry_lost");
      return false;
    },

    verificationKey(kid) {
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE kid = ?`).get(kid ?? CONFIG_KID) as
        | KeyRow
        | undefined;
      try {
        if (row === undefined) {
          // Empty AND keys never initialised: a deployment that never rotated, so the configured
          // secret verifies everything it always did, whatever `kid` (if any) the token names.
          // Empty but initialised is a lost table, which is refused, not trusted.
          if (keysEmpty()) {
            if (lostCause("keys") !== undefined) throw new AuthRejection("registry_lost");
            return new TextEncoder().encode(loadSecret(configKey()));
          }
          throw new AuthRejection("unknown_key");
        }
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
      writeAndArm("tokens", () =>
        q(
          "INSERT INTO auth_tokens (jti, kid, sub, scopes_summary, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(t.jti, t.kid, t.sub, t.scopesSummary, t.issuedAt, t.expiresAt),
      );
    },

    revoke(jti, reason) {
      assertNotLost();
      return writeAndArm("tokens", () => {
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
        return writeAndArm("keys", () => {
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
