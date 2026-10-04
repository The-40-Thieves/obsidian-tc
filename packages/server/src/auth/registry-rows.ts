// Row shapes of `auth_keys` / `auth_tokens` and their mappings to the registry's public records.
// Split out of registry.ts (the registry itself keeps its file-length budget).
import type { AuthKey, AuthTokenRecord, KeyState } from "./registry-types";
import type { KeyPurpose, PublicJwk } from "./signing-keys";

export type KeyRow = {
  kid: string;
  alg: string;
  purpose: KeyPurpose;
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
export const toKey = (r: KeyRow): AuthKey => ({
  kid: r.kid,
  alg: r.alg,
  purpose: r.purpose,
  keyRef: r.key_ref,
  createdAt: r.created_at,
  state: r.state,
  retireAfter: r.retire_after,
  publicJwk: parsePublic(r.public_jwk),
});
export type TokenRow = {
  jti: string;
  kid: string | null;
  sub: string | null;
  scopes_summary: string;
  issued_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
};
export const toToken = (r: TokenRow): AuthTokenRecord => ({
  jti: r.jti,
  kid: r.kid,
  sub: r.sub,
  scopesSummary: r.scopes_summary,
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
});
