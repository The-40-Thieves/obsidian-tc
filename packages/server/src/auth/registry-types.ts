// The auth registry's public types. Split out of registry.ts (the registry itself keeps its
// file-length budget); registry.ts re-exports every name here, so callers keep importing them from
// "./registry".
import type {
  AsymmetricAlg,
  GeneratedSigningKey,
  KeyAlg,
  KeyPurpose,
  PublicJwk,
  PublishedJwk,
} from "./signing-keys";

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
  /** What the key signs: `mint` (hand-minted tokens) or `as` (the authorization server's). */
  purpose: KeyPurpose;
  keyRef: string;
  createdAt: number;
  state: KeyState;
  /** Epoch ms after which a `retiring` key stops verifying. */
  retireAfter: number | null;
  /** The public half of an ES256/EdDSA key; null for HS256. */
  publicJwk: PublicJwk | null;
}

/** What verifies a token for one key: an HMAC secret, or a public key for the row's algorithm, plus
 *  the key's purpose (which decides the claim rules the verifier applies). */
export type VerificationMaterial =
  | { alg: "HS256"; secret: Uint8Array; purpose: KeyPurpose }
  | { alg: AsymmetricAlg; publicJwk: PublicJwk; purpose: KeyPurpose };

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

export interface RotateOptions {
  /** Which key to rotate: `mint` (default, hand-minted tokens) or `as` (the authorization server's
   *  access-token key, which exists beside the mint key and rotates independently). */
  purpose?: KeyPurpose;
  /** Seconds the previous key keeps verifying. 0 (default) retires it at once. Replacing an `as`
   *  key needs at least `accessTokenSeconds` + 60 s, so no live access token is killed. */
  graceSeconds?: number;
  /** Algorithm of the NEW key. Default HS256 (`mint`) or ES256 (`as`); an asymmetric one needs
   *  `generated`, and an `as` key must be asymmetric. */
  alg?: KeyAlg;
  /** ES256/EdDSA material from `generateSigningKey` (async, so made outside the write lock). */
  generated?: GeneratedSigningKey;
  /** `auth.as.accessTokenSeconds`, which sizes the `as` grace floor. Default 1800. */
  accessTokenSeconds?: number;
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
  /** Does the registry hold `kid` (any state)? Throws `registry_lost` for a lost keys table. */
  hasKey(kid: string | undefined): boolean;
  /** The key `token mint` signs with: the active `mint` key, or the config key while no `mint` key
   *  was ever rotated in. `purpose` picks the other one (`as`, which has no config fallback). `kid`
   *  must name the ACTIVE key of that purpose. `secret` is the HMAC secret, or the private JWK as JSON. */
  signingKey(opts?: { kid?: string; purpose?: KeyPurpose }): {
    kid: string;
    alg: KeyAlg;
    secret: string;
  };
  recordToken(t: Omit<AuthTokenRecord, "revokedAt" | "revokedReason">): void;
  /** Revoke by jti. A jti this registry never issued gets a tombstone (`tombstoned`), so tokens
   *  minted before the registry, or by an external issuer, can be revoked too. Idempotent on an
   *  already-revoked jti. */
  revoke(jti: string, reason: string | null): "revoked" | "already_revoked" | "tombstoned";
  listTokens(opts?: { includeExpired?: boolean }): AuthTokenRecord[];
  listKeys(): AuthKey[];
  /** Generate a new active key of `opts.purpose`; that purpose's previous key becomes `retiring`
   *  for `graceSeconds`. The other purpose's active key is untouched. */
  rotateKey(opts?: RotateOptions): RotateResult;
  /** Persist `retiring` -> `retired` for elapsed windows; returns how many. Housekeeping only. */
  reapRetired(): number;
  /** Delete token rows more than a day past their `exp` (a tombstone has none, and stays). The
   *  newest row is always kept: an empty `auth_tokens` beside its marker reads as a lost registry.
   *  Housekeeping only; returns how many rows went. */
  reapExpiredTokens(): number;
  /** Keys per EFFECTIVE state (an elapsed window counts as retired before it is reaped). */
  keyCounts(): Record<KeyState, number>;
  /** The JWKS of every active, and every in-window retiring, ES256/EdDSA key: public members only. */
  publicJwks(): { keys: PublishedJwk[] };
  /** `publicJwks()` plus whole seconds to the earliest published `retire_after` (null: none). */
  publishedJwks(): { jwks: { keys: PublishedJwk[] }; secondsUntilRetirement: number | null };
  /** Is the registry usable, never used, or lost? */
  health(): RegistryHealth;
}
