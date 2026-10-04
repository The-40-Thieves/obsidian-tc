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
// No private key material lives in the database. A key's algorithm is its ROW's `alg`, not the token's.
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
  AS_KEY_FILE_PREFIX,
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
import { type KeyRow, type TokenRow, toKey, toToken } from "./registry-rows";
import type {
  AuthKey,
  AuthRegistry,
  AuthRegistryOptions,
  KeyState,
  RegistryHealth,
  VerificationMaterial,
} from "./registry-types";
import {
  asGraceFloorSeconds,
  isAsymmetricAlg,
  isKeyAlg,
  isKeyPurpose,
  MAX_ROTATION_GRACE_SECONDS,
  type PublishedJwk,
  publicJwkOf,
} from "./signing-keys";

export type {
  AuthKey,
  AuthRegistry,
  AuthRegistryOptions,
  AuthTokenRecord,
  KeyState,
  RegistryHealth,
  RotateOptions,
  RotateResult,
  VerificationMaterial,
} from "./registry-types";

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

const DUE_SQL =
  "SELECT 1 AS x FROM auth_keys WHERE state = 'retiring' AND retire_after <= ? LIMIT 1";
const REAP_SQL =
  "UPDATE auth_keys SET state = 'retired' WHERE state = 'retiring' AND retire_after <= ?";
const KEY_COLS = "kid, alg, purpose, key_ref, created_at, state, retire_after, public_jwk";
/** Reaped `auth_tokens` rows are those more than this long past their `exp`. */
const EXPIRED_TOKEN_RETENTION_MS = 86_400_000;

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
    reapExpiredTokens: refuse,
    keyCounts: refuse,
    publicJwks: refuse,
    publishedJwks: refuse,
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
    purpose: "mint",
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
    keys: "SELECT 1 AS x FROM auth_keys WHERE purpose = 'mint' LIMIT 1",
    "as-keys": "SELECT 1 AS x FROM auth_keys WHERE purpose = 'as' LIMIT 1",
    tokens: "SELECT 1 AS x FROM auth_tokens LIMIT 1",
  };
  const TABLES: readonly RegistryTable[] = ["keys", "as-keys", "tokens"];
  const lostMessage: Record<RegistryTable, string> = {
    keys: "auth.db holds no signing keys",
    "as-keys": "auth.db holds no authorization-server (`as`) signing keys",
    tokens: "auth.db holds no token or revocation rows",
  };
  const hasRows = (table: RegistryTable): boolean => q(rowSql[table]).get() !== undefined;
  // A never-initialised table would otherwise pay a SELECT, an lstat and a readdir on every miss to
  // re-learn that nothing exists. `uninitialised` is remembered for a second: it can only turn into
  // `lost` if the database is replaced by an empty one WHILE the marker appears, which a one-second
  // detection delay does not change. Our own writes clear it. Nothing else is cached: a table that
  // empties under a live connection is noticed on the next miss.
  const uninitialisedUntil: Record<RegistryTable, number> = { keys: 0, "as-keys": 0, tokens: 0 };
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
    if (!(table === "as-keys" ? state.asKeys : state[table])) {
      uninitialisedUntil[table] = Date.now() + UNINITIALISED_TTL_MS;
      return undefined;
    }
    if (!emptyUnderLock(table)) return undefined;
    if (state.dirProblem !== undefined) return registryLostMessageFor(keysDir, state);
    return registryLostMessage(keysDir, lostMessage[table]);
  };
  /** The first lost part of the registry (`mint` keys, `as` keys, tokens), as the operator message. */
  const anyLost = (): string | undefined => {
    for (const t of TABLES) {
      const detail = lostCause(t);
      if (detail !== undefined) return detail;
    }
    return undefined;
  };
  const health = (): RegistryHealth => {
    const detail = anyLost();
    if (detail !== undefined) return { state: "lost", detail };
    return TABLES.some(hasRows) ? { state: "ok" } : { state: "uninitialised" };
  };
  /** Refuse (throw the operator message) when any part is lost; the guard in front of every path
   *  that would otherwise read an empty table as "never used". */
  const assertNotLost = (): void => {
    const detail = anyLost();
    if (detail !== undefined) throw new Error(detail);
  };
  /** No `mint` key was ever rotated in (rows only): the configured secret is the one mint key. */
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
      for (const t of TABLES) uninitialisedUntil[t] = 0;
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
        // Never rotated: the configured secret verifies. Initialised but empty: lost, refused.
        if (keysEmpty()) {
          if (lostCause("keys") !== undefined) throw new AuthRejection("registry_lost");
          return {
            alg: "HS256",
            secret: new TextEncoder().encode(loadSecret(configKey())),
            purpose: "mint",
          };
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
        return {
          alg: "HS256",
          secret: new TextEncoder().encode(loadSecret(key)),
          purpose: key.purpose,
        };
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
      return { alg: key.alg, publicJwk: key.publicJwk, purpose: key.purpose };
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
      // HMAC verifies hand-minted tokens only: an `as` row is asymmetric by construction, and one
      // that is not (a tampered database) is refused, never read as an HMAC secret.
      if (m.alg !== "HS256" || m.purpose !== "mint") throw new AuthRejection("unsupported_alg");
      return m.secret;
    },

    hasKey(kid) {
      if (
        kid !== undefined &&
        q("SELECT 1 AS x FROM auth_keys WHERE kid = ?").get(kid) !== undefined
      )
        return true;
      // Not held: a lost keys table (either purpose) must not let the token fall through to an
      // external JWKS.
      if (lostCause("keys") !== undefined || lostCause("as-keys") !== undefined) {
        throw new AuthRejection("registry_lost");
      }
      return false;
    },

    signingKey(o = {}) {
      const purpose = o.purpose ?? "mint";
      if (!isKeyPurpose(purpose)) throw new Error(`unknown key purpose ${String(purpose)}`);
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
          if (pinned.purpose !== purpose) {
            throw new Error(
              `key ${o.kid} is a \`${pinned.purpose}\` key, not \`${purpose}\`: a key signs only for its own purpose (see \`auth list --keys\`)`,
            );
          }
          if (pinned.state !== "active") {
            throw new Error(
              `key ${o.kid} is ${pinned.state}, not active: minting is pinned to the active key (see \`auth list --keys\`)`,
            );
          }
          return signing(pinned);
        }
        assertNotLost();
        if (purpose === "mint" && o.kid === CONFIG_KID && keysEmpty() && opts.configSecret) {
          return { kid: CONFIG_KID, alg: "HS256", secret: opts.configSecret };
        }
        throw new Error(`unknown signing key ${o.kid} (see \`auth list --keys\`)`);
      }
      const row = q(`SELECT ${KEY_COLS} FROM auth_keys WHERE state = 'active' AND purpose = ?`).get(
        purpose,
      ) as KeyRow | undefined;
      if (row !== undefined) return signing(row);
      assertNotLost();
      if (purpose === "as") {
        throw new Error("no active `as` signing key: run `auth rotate-key --purpose as`");
      }
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

    rotateKey({
      purpose = "mint",
      graceSeconds = 0,
      alg = purpose === "as" ? "ES256" : "HS256",
      generated,
      accessTokenSeconds,
    } = {}) {
      if (!keysDir) throw new Error("rotate-key needs a cache directory to store the new key");
      if (!isKeyPurpose(purpose)) {
        throw new Error(`rotate-key: unknown purpose ${String(purpose)} (mint or as)`);
      }
      if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
        throw new Error("rotate-key: the grace window must be a non-negative number of seconds");
      }
      if (graceSeconds > MAX_ROTATION_GRACE_SECONDS) {
        throw new Error(
          `rotate-key: the grace window is capped at ${MAX_ROTATION_GRACE_SECONDS}s (7 days)`,
        );
      }
      if (!isKeyAlg(alg)) throw new Error(`rotate-key: unsupported algorithm ${String(alg)}`);
      if (purpose === "as" && alg === "HS256") {
        throw new Error(
          "rotate-key: an `as` key signs RFC 9068 access tokens: ES256 or EdDSA only",
        );
      }
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
      // An `as` key's kid is its RFC 7638 thumbprint (what a client reads from the JWKS); a `mint`
      // key keeps its random id. The `as-` file prefix is what attributes the file to a purpose.
      const kid =
        purpose === "as" ? (generated?.thumbprint ?? "") : `k_${randomBytes(8).toString("hex")}`;
      if (kid === "") throw new Error("rotate-key: an `as` key needs the thumbprint of its key");
      const file = `${purpose === "as" ? AS_KEY_FILE_PREFIX : ""}${kid}.key`;
      ensureKeysDir(keysDir, { create: true });
      const path = join(keysDir, file);
      createKeyFile(path, fileText);
      try {
        return writeAndArm(purpose === "as" ? "as-keys" : "keys", () => {
          // First `mint` rotation of a deployment that has only ever used the configured secret:
          // enrol it as the `config` key so it is the one being retired, not silently forgotten.
          if (purpose === "mint" && keysEmpty() && opts.configSecret) {
            q(
              "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state) VALUES (?, 'HS256', ?, ?, 'active')",
            ).run(CONFIG_KID, CONFIG_REF, t);
          }
          // One active key PER PURPOSE: the other purpose's key is never touched.
          const prev = q("SELECT kid FROM auth_keys WHERE state = 'active' AND purpose = ?").get(
            purpose,
          ) as { kid: string } | undefined;
          // Replacing an `as` key with a window shorter than an access token's life (plus skew)
          // would kill tokens that have not expired yet.
          const floor = asGraceFloorSeconds(accessTokenSeconds);
          if (purpose === "as" && prev !== undefined && graceSeconds < floor) {
            throw new Error(
              `rotate-key: replacing the \`as\` key needs a grace window of at least ${floor}s (access-token lifetime plus 60s skew), got ${graceSeconds}s: a shorter one would kill live access tokens`,
            );
          }
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
            "INSERT INTO auth_keys (kid, alg, purpose, key_ref, created_at, state, public_jwk) VALUES (?, ?, ?, ?, ?, 'active', ?)",
          ).run(kid, alg, purpose, `file:${file}`, t, publicJwk);
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
      // No `mint` key rotated in yet: the configured secret is the one implicit active mint key.
      if (keysEmpty() && opts.configSecret && lostCause("keys") === undefined) counts.active += 1;
      return counts;
    },

    reapExpiredTokens() {
      const cutoff = now() - EXPIRED_TOKEN_RETENTION_MS;
      // A read first: the write lock is only taken when there is something to drop.
      if (
        q("SELECT 1 AS x FROM auth_tokens WHERE expires_at < ? LIMIT 1").get(cutoff) === undefined
      ) {
        return 0;
      }
      // The newest row stays whatever its age. The table must never empty: an empty `auth_tokens`
      // beside its marker is exactly what reads as a lost registry.
      return inWriteTransaction(
        db,
        "auth_registry",
        () =>
          q(
            "DELETE FROM auth_tokens WHERE expires_at < ? AND rowid <> (SELECT MAX(rowid) FROM auth_tokens)",
          ).run(cutoff).changes,
      );
    },

    publicJwks() {
      return this.publishedJwks().jwks;
    },

    publishedJwks() {
      assertNotLost();
      const t = now();
      const rows = q(
        `SELECT ${KEY_COLS} FROM auth_keys
          WHERE alg <> 'HS256' AND public_jwk IS NOT NULL
            AND (state = 'active' OR (state = 'retiring' AND retire_after > ?))
          ORDER BY created_at, kid`,
      ).all(t) as KeyRow[];
      const keys: PublishedJwk[] = [];
      let earliestRetireAfter: number | null = null;
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
          if (
            key.state === "retiring" &&
            key.retireAfter !== null &&
            (earliestRetireAfter === null || key.retireAfter < earliestRetireAfter)
          ) {
            earliestRetireAfter = key.retireAfter;
          }
        } catch {
          /* a stored key that does not fit its algorithm is not published */
        }
      }
      return {
        jwks: { keys },
        secondsUntilRetirement:
          earliestRetireAfter === null
            ? null
            : Math.max(0, Math.floor((earliestRetireAfter - t) / 1000)),
      };
    },
  };
}
