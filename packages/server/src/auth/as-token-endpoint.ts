// `POST /oauth/token` of the bundled authorization server (design v2 sections 4.3, 4.4 and 4.6): the
// `authorization_code` grant here, the `refresh_token` grant in as-refresh-grant.ts.
//
// A code is exchanged once: it must be unused, unexpired and bound to the authenticated client, the
// redirect URI and the resource it was issued for, and the PKCE verifier must hash to its challenge.
// A second exchange of a used code is a replay: it is refused and everything already issued from the
// code is revoked (RFC 9700 section 4.14). The access token is an RFC 9068 JWT signed with the
// registry's `as` key, and a refresh token starts the code's family.
//
// Ordering is what makes a concurrent replay safe: the token's jti is recorded (mintAccessToken)
// BEFORE the code is consumed, so whichever exchange loses the race finds the winner's jti already in
// `issued_access` when it revokes the family, and the winner's token dies with the rest.
import { createHash } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import { type AccessContext, mintAccessToken } from "./as-access";
import { accountBounds, applyBounds } from "./as-account";
import {
  authenticateClient,
  clientFailureStatus,
  formReader,
  isFormRequest,
} from "./as-client-auth";
import { clientResolverFor } from "./as-client-resolver";
import { sameResource, secretsEqual, splitScope } from "./as-clients";
import { loadCode, revokeFamily } from "./as-grants";
import { type AsRouteDeps, enabledAs } from "./as-metadata";
import { socketClientIp } from "./as-operator";
import { consumeCodeAndStartFamily, newRefreshToken } from "./as-refresh";
import { refreshGrant } from "./as-refresh-grant";
import { secretGeneration } from "./as-refresh-replay";

type AuthConfig = ServerConfig["auth"];

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

type ErrorStatus = 400 | 401 | 415 | 500 | 503;

export function mountTokenRoute(app: Hono, auth: AuthConfig, deps?: AsRouteDeps): void {
  const as = enabledAs(auth);
  if (as === undefined || deps === undefined) return;
  const { db, registry } = deps;
  const resolveClient = clientResolverFor(deps, as);
  const clientIp = deps.clientIp ?? socketClientIp;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const resource = auth.resource as string;
  const access: AccessContext = {
    db,
    registry,
    issuer: as.issuer,
    resource,
    accessTokenSeconds: as.accessTokenSeconds,
    now,
  };

  const fail = (c: Context, status: ErrorStatus, error: string, description: string) => {
    c.header("pragma", "no-cache");
    if (status === 401) c.header("www-authenticate", 'Basic realm="oauth"');
    return c.json({ error, error_description: description }, status);
  };

  app.post("/oauth/token", async (c) => {
    if (!isFormRequest(c)) {
      return fail(c, 415, "invalid_request", "the body must be application/x-www-form-urlencoded");
    }
    const form = new URLSearchParams(await c.req.text());
    const one = formReader(form);

    // ---- client authentication: `none` for a public client, client_secret_basic for a confidential one
    const authed = await authenticateClient(
      (id) => resolveClient(id, { source: clientIp(c) }),
      form,
      c.req.header("authorization"),
    );
    if ("failure" in authed) {
      const { status, error } = clientFailureStatus(authed);
      return fail(c, status, error, authed.failure);
    }
    const { client } = authed;

    // ---- request
    const grantType = one("grant_type");
    if (grantType === undefined || grantType === null) {
      return fail(c, 400, "invalid_request", "grant_type is required");
    }
    const asked = one("resource");
    if (grantType === "refresh_token") {
      return refreshGrant(
        {
          c,
          one,
          client,
          db,
          registry,
          secret: deps.secret,
          access,
          now,
          log,
          fail: (status, error, description) => fail(c, status, error, description),
        },
        asked,
      );
    }
    if (grantType !== "authorization_code") {
      return fail(
        c,
        400,
        "unsupported_grant_type",
        "only authorization_code and refresh_token are supported",
      );
    }
    const code = one("code");
    const redirectUri = one("redirect_uri");
    if (!code || !redirectUri) {
      return fail(c, 400, "invalid_request", "code and redirect_uri are required");
    }
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

    // ---- issue. The jti is recorded BEFORE the code is consumed and before the token can leave: a
    // failure here ends the exchange with no token (and the code intact).
    let token: string;
    try {
      ({ token } = await mintAccessToken(access, {
        sub: rec.sub,
        clientId: client.clientId,
        scope,
        persona: rec.persona,
        vault: bounded.vault,
        familyId: rec.codeHash,
        grantId: rec.grantId,
      }));
    } catch (e) {
      log(`token not issued: ${e instanceof Error ? e.message : "signing failed"}`);
      return fail(c, 500, "server_error", "the access token could not be issued");
    }

    // The refresh token is born with the code's death, in one transaction. Its scope is the granted
    // scope as bounded now; later refreshes may narrow it, never widen it.
    // Only a client that registered the grant gets one (RFC 7591 section 2: an unlisted type is not served).
    const refreshToken =
      client.grantTypes === undefined || client.grantTypes.includes("refresh_token")
        ? newRefreshToken()
        : undefined;
    let started = false;
    try {
      started = consumeCodeAndStartFamily(db, {
        codeHash: rec.codeHash,
        grantId: rec.grantId,
        token: refreshToken,
        scope,
        now: now(),
        days: as.refreshTokenDays,
        secretGen: secretGeneration(deps.secret),
      });
    } catch (e) {
      revokeFamily(db, registry, rec.codeHash, "authorization_code_failed", now());
      log(`token not issued: ${e instanceof Error ? e.message : "refresh token not stored"}`);
      return fail(c, 500, "server_error", "the access token could not be issued");
    }
    if (!started) {
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
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      scope,
    });
  });
}
