// `POST /oauth/token`, `authorization_code` grant, of the bundled authorization server (design v2
// sections 4.3 and 4.4). A code is exchanged once: it must be unused, unexpired and bound to the
// authenticated client, the redirect URI and the resource it was issued for, and the PKCE verifier
// must hash to its challenge. A second exchange of a used code is a replay: it is refused and
// everything already issued from the code is revoked (RFC 9700 section 4.14). The access token is an
// RFC 9068 JWT signed with the registry's `as` key.
//
// Ordering is what makes a concurrent replay safe: the token's jti is recorded (recordIssuedAccess)
// BEFORE the code is consumed, so whichever exchange loses the race finds the winner's jti already in
// `issued_access` when it revokes the family, and the winner's token dies with the rest.
import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import { SignJWT } from "jose";
import { accountBounds, applyBounds } from "./as-account";
import { findStaticClient, sameResource, secretsEqual, splitScope } from "./as-clients";
import { consumeCode, loadCode, revokeFamily } from "./as-grants";
import { type AsRouteDeps, enabledAs } from "./as-metadata";
import { type IssuedAccessToken, recordIssuedAccess } from "./oauth-db";
import { importSigningKey, isAsymmetricAlg } from "./signing-keys";

type AuthConfig = ServerConfig["auth"];

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

type ErrorStatus = 400 | 401 | 415 | 500;

/** `Authorization: Basic` as RFC 6749 section 2.3.1 defines it (form-urlencoded id and secret). */
function parseBasic(header: string | undefined): { id: string; secret: string } | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header ?? "");
  if (m === null) return undefined;
  const decoded = Buffer.from(m[1] as string, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " ")),
      secret: decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " ")),
    };
  } catch {
    return undefined;
  }
}

export function mountTokenRoute(app: Hono, auth: AuthConfig, deps?: AsRouteDeps): void {
  const as = enabledAs(auth);
  if (as === undefined || deps === undefined) return;
  const { db, registry } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const resource = auth.resource as string;

  const fail = (c: Context, status: ErrorStatus, error: string, description: string) => {
    c.header("pragma", "no-cache");
    if (status === 401) c.header("www-authenticate", 'Basic realm="oauth"');
    return c.json({ error, error_description: description }, status);
  };

  app.post("/oauth/token", async (c) => {
    if (
      !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")
    ) {
      return fail(c, 415, "invalid_request", "the body must be application/x-www-form-urlencoded");
    }
    const form = new URLSearchParams(await c.req.text());
    const one = (name: string): string | undefined | null => {
      const all = form.getAll(name);
      return all.length > 1 ? null : all[0];
    };

    // ---- client authentication: `none` for a public client, client_secret_basic for a confidential one
    const basic = parseBasic(c.req.header("authorization"));
    const bodyId = one("client_id");
    if (bodyId === null || form.has("client_secret")) {
      return fail(c, 401, "invalid_client", "client authentication is malformed");
    }
    const clientId = basic?.id ?? bodyId;
    if (basic !== undefined && bodyId !== undefined && bodyId !== basic.id) {
      return fail(c, 401, "invalid_client", "client authentication is malformed");
    }
    const client = clientId === undefined ? undefined : findStaticClient(as.clients, clientId);
    if (client === undefined) return fail(c, 401, "invalid_client", "unknown client");
    if (client.secretEnv !== undefined) {
      const expected = process.env[client.secretEnv];
      if (basic === undefined || !expected || !secretsEqual(basic.secret, expected)) {
        return fail(c, 401, "invalid_client", "client authentication failed");
      }
    } else if (c.req.header("authorization") !== undefined) {
      // A public client is bound to the `none` method: presenting credentials is a different client.
      return fail(c, 401, "invalid_client", "this client does not authenticate");
    }

    // ---- request
    const grantType = one("grant_type");
    if (grantType === undefined || grantType === null) {
      return fail(c, 400, "invalid_request", "grant_type is required");
    }
    if (grantType !== "authorization_code") {
      return fail(c, 400, "unsupported_grant_type", "only authorization_code is supported");
    }
    const code = one("code");
    const redirectUri = one("redirect_uri");
    if (!code || !redirectUri) {
      return fail(c, 400, "invalid_request", "code and redirect_uri are required");
    }
    const asked = one("resource");
    if (asked === null || (asked !== undefined && !sameResource(asked, resource))) {
      return fail(c, 400, "invalid_target", "resource must be this server's resource URL");
    }

    // ---- the code
    const rec = loadCode(db, code);
    const bad = (why: string) => {
      log(`token refused: ${why}`);
      return fail(c, 400, "invalid_grant", "the authorization code is invalid");
    };
    if (rec === undefined) return bad("unknown code");
    // Every binding is proved BEFORE a used code counts as a replay by its holder: a code that became
    // known to someone else (callback history, a loopback observer) must not let them revoke what it issued.
    if (rec.clientId !== client.clientId) return bad("code issued to another client");
    if (rec.redirectUri !== redirectUri) return bad("redirect_uri differs from the request");
    if (!sameResource(rec.resource, resource)) return bad("resource differs from the request");
    const verifier = one("code_verifier");
    if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier))
      return bad("no usable verifier");
    const computed = createHash("sha256").update(verifier).digest("base64url");
    if (!secretsEqual(computed, rec.codeChallenge)) return bad("PKCE verifier mismatch");
    if (rec.usedAt !== null) {
      revokeFamily(db, registry, rec.codeHash, "authorization_code_reuse", now());
      return bad(`code replay, client=${rec.clientId}: tokens issued from it are revoked`);
    }
    if (rec.expiresAt <= now()) return bad("expired code");
    if (rec.grantRevoked) return bad("revoked grant");

    // ---- the account's bounds as they are NOW, not as they were at consent
    const bounds = accountBounds(db, rec.sub);
    const bounded =
      bounds === undefined
        ? undefined
        : applyBounds(bounds, { scopes: splitScope(rec.scope), vault: rec.vault });
    if (bounded === undefined || !bounded.ok) {
      return bad(`account bounds no longer allow this grant, client=${rec.clientId}`);
    }
    const scope = bounded.scopes.join(" ");
    const vault = bounded.vault;

    // ---- issue
    const iat = Math.floor(now() / 1000);
    const exp = iat + as.accessTokenSeconds;
    const jti = randomUUID();
    let token: string;
    try {
      const { kid, alg, secret } = registry.signingKey({ purpose: "as" });
      const record: IssuedAccessToken = {
        jti,
        kid,
        sub: rec.sub,
        scope,
        familyId: rec.codeHash,
        grantId: rec.grantId,
        iat,
        exp,
      };
      // Recorded BEFORE the code is consumed and before the token can leave: a failure here ends the
      // exchange with no token (and the code intact).
      recordIssuedAccess(db, registry, record);
      const key = isAsymmetricAlg(alg)
        ? await importSigningKey(alg, secret)
        : new TextEncoder().encode(secret);
      token = await new SignJWT({
        client_id: client.clientId,
        scope,
        ...(rec.persona !== null ? { persona: rec.persona } : {}),
        ...(vault !== null ? { vault } : {}),
      })
        .setProtectedHeader({ alg, typ: "at+jwt", kid })
        .setIssuer(as.issuer)
        .setSubject(rec.sub)
        .setAudience(resource)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setJti(jti)
        .sign(key);
    } catch (e) {
      log(`token not issued: ${e instanceof Error ? e.message : "signing failed"}`);
      return fail(c, 500, "server_error", "the access token could not be issued");
    }

    if (!consumeCode(db, rec.codeHash, now())) {
      // Another exchange of this code won while this one was signing: it is a replay.
      revokeFamily(db, registry, rec.codeHash, "authorization_code_reuse", now());
      return bad(`concurrent exchange, client=${rec.clientId}: tokens issued from it are revoked`);
    }
    log(`token issued client=${client.clientId}`);
    c.header("pragma", "no-cache");
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: as.accessTokenSeconds,
      scope,
    });
  });
}
