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
// No private key material lives in the database. A key's algorithm is its ROW's `alg`, never the
// token header's (see `verificationMaterial`).
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
  readKeyFile,
} from "./key-files";
import {
  authDbPath,
  authKeysDir,
  type RegistryTable,
  registryInitialized,
  registryInitState,
  registryLostMessage,
  registryLostMessageFor,
  registryMarkerPath,
  summarizeScopes,
} from "./registry-markers";
import {
  type AsymmetricAlg,
  type GeneratedSigningKey,
  isAsymmetricAlg,
  isKeyAlg,
  type KeyAlg,
  MAX_ROTATION_GRACE_SECONDS,
  type PublicJwk,
  type PublishedJwk,
  publicJwkOf,
} from "./signing-keys";

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

export {
  authDbPath,
  authKeysDir,
  registryInitialized,
  registryInitState,
  registryLostMessage,
  registryLostMessageFor,
  registryMarkerPath,
  summarizeScopes,
};

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
  /** The public half of an ES256/EdDSA key; null for HS256. */
  publicJwk: PublicJwk | null;
}

/** What verifies a token for one key: an HMAC secret, or a public key for the row's algorithm. */
export type VerificationMaterial =
  | { alg: "HS256"; secret: Uint8Array }
  | { alg: AsymmetricAlg; publicJwk: PublicJwk };

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

type KeyRow = {
  kid: string;
  alg: string;
  key_ref: string;
  created_at: number;
  state: KeyState;
  retire_after: number | null;
  public_jwk: string | null;
};
const parsePublic = (text: string | null): PublicJwk | null => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as PublicJwk;
  } catch {
    return null; // unusable: an asymmetric row with no readable public key is refused, never guessed
  }
};
const toKey = (r: KeyRow): AuthKey => ({
  kid: r.kid,
  alg: r.alg,
  keyRef: r.key_ref,
  createdAt: r.created_at,
  state: r.state,
  retireAfter: r.retire_after,
  publicJwk: parsePublic(r.public_jwk),
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

const DUE_SQL =
  "SELECT 1 AS x FROM auth_keys WHERE state = 'retiring' AND retire_after <= ? LIMIT 1";
const REAP_SQL =
  "UPDATE auth_keys SET state = 'retired' WHERE state = 'retiring' AND retire_after <= ?";
const KEY_COLS = "kid, alg, key_ref, created_at, state, retire_after, public_jwk";

export interface RotateOptions {
  /** Seconds the previous key keeps verifying. 0 (default) retires it at once. */
  graceSeconds?: number;
  /** Algorithm of the NEW key. Default HS256; an asymmetric one needs `generated`. */
  alg?: KeyAlg;
  /** ES256/EdDSA material from `generateSigningKey` (async, so made outside the write lock). */
  generated?: GeneratedSigningKey;
}

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
  /** Per-request: the HS256 key for `kid`. Throws `AuthRejection` (`unsupported_alg` for an asymmetric `kid`). */
  verificationKey(kid: string | undefined): Uint8Array;
  /** Per-request: what verifies `kid`, with the algorithm the ROW dictates. Throws `AuthRejection`. */
  verificationMaterial(kid: string | undefined): VerificationMaterial;
  /** Does the registry hold a key with this `kid` (any state)? */
  hasKey(kid: string): boolean;
  /** The key `token mint` signs with: the active key, or the config key while the registry is empty.
   *  `kid` must name the ACTIVE key. `secret` is the HMAC secret, or the private JWK as JSON. */
  signingKey(opts?: { kid?: string }): { kid: string; alg: KeyAlg; secret: string };
  recordToken(t: Omit<AuthTokenRecord, "revokedAt" | "revokedReason">): void;
  /** Revoke by jti. A jti this registry never issued gets a tombstone (`tombstoned`), so tokens
   *  minted before the registry, or by an external issuer, can be revoked too. Idempotent on an
   *  already-revoked jti. */
  revoke(jti: string, reason: string | null): "revoked" | "already_revoked" | "tombstoned";
  listTokens(opts?: { includeExpired?: boolean }): AuthTokenRecord[];
  listKeys(): AuthKey[];
  /** Generate a new active key; the previous one becomes `retiring` for `graceSeconds`. */
  rotateKey(opts?: RotateOptions): RotateResult;
  /** Persist `retiring` -> `retired` for elapsed windows; returns how many. Housekeeping only. */
  reapRetired(): number;
  /** Keys per EFFECTIVE state (an elapsed window counts as retired before it is reaped). */
  keyCounts(): Record<KeyState, number>;
  /** The JWKS of every active, and every in-window retiring, ES256/EdDSA key: public members only. */
  publicJwks(): { keys: PublishedJwk[] };
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
    verificationMaterial: () => {
      throw new AuthRejection("registry_lost");
    },
    hasKey: () => {
      throw new AuthRejection("registry_lost");
    },
    signingKey: refuse,
    recordToken: refuse,
    revoke: refuse,
    listTokens: refuse,
    listKeys: refuse,
    rotateKey: refuse,
    reapRetired: refuse,
    keyCounts: refuse,
    publicJwks: refuse,
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
    publicJwk: null,
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

  const verificationMaterial = (kid: string | undefined): VerificationMaterial => {
    const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE kid = ?`).get(kid ?? CONFIG_KID) as
      | KeyRow
      | undefined;
    try {
      if (row === undefined) {
        // Never rotated: the configured secret verifies as it always did. Initialised but empty
        // is a lost table: refused.
        if (keysEmpty()) {
          if (lostCause("keys") !== undefined) throw new AuthRejection("registry_lost");
          return { alg: "HS256", secret: new TextEncoder().encode(loadSecret(configKey())) };
        }
        throw new AuthRejection("unknown_key");
      }
      const key = toKey(row);
      // A retiring key with no window counts as retired (fail closed).
      const live =
        key.state === "active" ||
        (key.state === "retiring" && key.retireAfter !== null && now() < key.retireAfter);
      if (!live) throw new AuthRejection("key_retired");
      if (key.alg === "HS256") {
        return { alg: "HS256", secret: new TextEncoder().encode(loadSecret(key)) };
      }
      // An asymmetric key verifies with its row's PUBLIC key only, never as an HMAC secret.
      if (!isAsymmetricAlg(key.alg) || key.publicJwk === null) {
        throw new AuthRejection("misconfigured");
      }
      try {
        publicJwkOf(key.alg, key.publicJwk);
      } catch (e) {
        throw new AuthRejection("misconfigured", { cause: e });
      }
      return { alg: key.alg, publicJwk: key.publicJwk };
    } catch (e) {
      if (e instanceof KeyFileError) throw new AuthRejection("misconfigured", { cause: e });
      throw e;
    }
  };

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

    verificationMaterial,

    verificationKey(kid) {
      const m = verificationMaterial(kid);
      if (m.alg !== "HS256") throw new AuthRejection("unsupported_alg");
      return m.secret;
    },

    hasKey(kid) {
      return q("SELECT 1 AS x FROM auth_keys WHERE kid = ?").get(kid) !== undefined;
    },

    signingKey(o = {}) {
      const signing = (row: KeyRow) => {
        const key = toKey(row);
        if (!isKeyAlg(key.alg))
          throw new Error(`key ${key.kid} uses unsupported algorithm ${key.alg}`);
        return { kid: key.kid, alg: key.alg, secret: loadSecret(key) };
      };
      if (o.kid !== undefined) {
        const pinned = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE kid = ?`).get(o.kid) as
          | KeyRow
          | undefined;
        if (pinned !== undefined) {
          if (pinned.state !== "active") {
            throw new Error(
              `key ${o.kid} is ${pinned.state}, not active: minting is pinned to the active key (see \`auth list --keys\`)`,
            );
          }
          return signing(pinned);
        }
        assertNotLost();
        if (o.kid === CONFIG_KID && keysEmpty() && opts.configSecret) {
          return { kid: CONFIG_KID, alg: "HS256", secret: opts.configSecret };
        }
        throw new Error(`unknown signing key ${o.kid} (see \`auth list --keys\`)`);
      }
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE state = 'active'`).get() as
        | KeyRow
        | undefined;
      if (row !== undefined) return signing(row);
      assertNotLost();
      if (!keysEmpty()) throw new Error("no active signing key: run `auth rotate-key`");
      if (!opts.configSecret) {
        throw new Error(
          "no signing key: set auth.jwtSecret (or OBSIDIAN_TC_JWT_SECRET), or run `auth rotate-key`",
        );
      }
      return { kid: CONFIG_KID, alg: "HS256", secret: opts.configSecret };
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

    rotateKey({ graceSeconds = 0, alg = "HS256", generated } = {}) {
      if (!keysDir) throw new Error("rotate-key needs a cache directory to store the new key");
      if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
        throw new Error("rotate-key: the grace window must be a non-negative number of seconds");
      }
      if (graceSeconds > MAX_ROTATION_GRACE_SECONDS) {
        throw new Error(
          `rotate-key: the grace window is capped at ${MAX_ROTATION_GRACE_SECONDS}s (7 days)`,
        );
      }
      if (!isKeyAlg(alg)) throw new Error(`rotate-key: unsupported algorithm ${String(alg)}`);
      let fileText: string;
      let publicJwk: string | null = null;
      if (alg === "HS256") {
        fileText = randomBytes(32).toString("base64url");
      } else {
        if (generated === undefined || generated.alg !== alg) {
          throw new Error(`rotate-key: a ${alg} key needs generated key material`);
        }
        publicJwk = JSON.stringify(publicJwkOf(alg, generated.publicJwk));
        fileText = JSON.stringify(generated.privateJwk);
      }
      assertNotLost();
      const t = now();
      const kid = `k_${randomBytes(8).toString("hex")}`;
      const file = `${kid}.key`;
      ensureKeysDir(keysDir, { create: true });
      const path = join(keysDir, file);
      createKeyFile(path, fileText);
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
          // Settle already-elapsed windows (same statement as the periodic reaper).
          q(REAP_SQL).run(t);
          q(
            "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state, public_jwk) VALUES (?, ?, ?, ?, 'active', ?)",
          ).run(kid, alg, `file:${file}`, t, publicJwk);
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

    reapRetired() {
      // A read first: the write lock is only taken when there is something to persist.
      if (q(DUE_SQL).get(now()) === undefined) return 0;
      return inWriteTransaction(db, "auth_registry", () => q(REAP_SQL).run(now()).changes);
    },

    keyCounts() {
      const counts: Record<KeyState, number> = { active: 0, retiring: 0, retired: 0 };
      const rows = q(
        `SELECT CASE WHEN state = 'retiring' AND (retire_after IS NULL OR retire_after <= ?) THEN 'retired' ELSE state END AS s, COUNT(*) AS n
           FROM auth_keys GROUP BY s`,
      ).all(now()) as { s: KeyState; n: number }[];
      for (const r of rows) counts[r.s] = r.n;
      // Nothing rotated yet: the configured secret is the one implicit active key.
      if (rows.length === 0 && opts.configSecret && lostCause("keys") === undefined)
        counts.active = 1;
      return counts;
    },

    publicJwks() {
      assertNotLost();
      const rows = q(
        `SELECT ${KEY_COLS} FROM auth_keys
          WHERE alg <> 'HS256' AND public_jwk IS NOT NULL
            AND (state = 'active' OR (state = 'retiring' AND retire_after > ?))
          ORDER BY created_at, kid`,
      ).all(now()) as KeyRow[];
      const keys: PublishedJwk[] = [];
      for (const r of rows) {
        const key = toKey(r);
        if (!isAsymmetricAlg(key.alg) || key.publicJwk === null) continue;
        try {
          // Rebuilt member by member: only public members can appear in the document.
          keys.push({
            ...publicJwkOf(key.alg, key.publicJwk),
            kid: key.kid,
            alg: key.alg,
            use: "sig",
          });
        } catch {
          /* a stored key that does not fit its algorithm is not published */
        }
      }
      return { keys };
    },
  };
}
