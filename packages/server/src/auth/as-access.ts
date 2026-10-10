// Signing of the bundled authorization server's access tokens (design v2 section 4.4), shared by the
// authorization_code and refresh_token grants. The jti is recorded BEFORE the token is signed and
// before it can leave (a failure here ends the request with no token): a replay or a reuse that
// revokes the family then always finds every jti that could already be out.
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type { Database } from "../db/types";
import { type IssuedAccessToken, recordIssuedAccess } from "./oauth-db";
import type { AuthRegistry } from "./registry";
import { importSigningKey, isAsymmetricAlg } from "./signing-keys";

export interface AccessContext {
  db: Database;
  registry: AuthRegistry;
  issuer: string;
  resource: string;
  accessTokenSeconds: number;
  now: () => number;
}

export interface AccessSubject {
  sub: string;
  clientId: string;
  scope: string;
  persona: string | null;
  vault: string | null;
  /** The refresh-token family (the code's hash for the first token) its jti is recorded under. */
  familyId: string;
  grantId: string;
  /** The `aud`: one of `allowedResources(ctx.resource)`. Defaults to `ctx.resource`. */
  resource?: string;
}

export async function mintAccessToken(
  ctx: AccessContext,
  s: AccessSubject,
): Promise<{ token: string; jti: string }> {
  const iat = Math.floor(ctx.now() / 1000);
  const exp = iat + ctx.accessTokenSeconds;
  const jti = randomUUID();
  const { kid, alg, secret } = ctx.registry.signingKey({ purpose: "as" });
  const record: IssuedAccessToken = {
    jti,
    kid,
    sub: s.sub,
    scope: s.scope,
    familyId: s.familyId,
    grantId: s.grantId,
    iat,
    exp,
  };
  recordIssuedAccess(ctx.db, ctx.registry, record);
  const key = isAsymmetricAlg(alg)
    ? await importSigningKey(alg, secret)
    : new TextEncoder().encode(secret);
  const token = await new SignJWT({
    client_id: s.clientId,
    scope: s.scope,
    ...(s.persona !== null ? { persona: s.persona } : {}),
    ...(s.vault !== null ? { vault: s.vault } : {}),
  })
    .setProtectedHeader({ alg, typ: "at+jwt", kid })
    .setIssuer(ctx.issuer)
    .setSubject(s.sub)
    .setAudience(s.resource ?? ctx.resource)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);
  return { token, jti };
}
