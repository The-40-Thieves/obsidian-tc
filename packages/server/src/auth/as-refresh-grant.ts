// The `refresh_token` grant of `POST /oauth/token` (design v2 section 4.6). Every refusal of a
// refresh token is the SAME `invalid_grant` with the same description, so the answer says nothing
// about why (unknown, revoked, expired, someone else's, too wide, a reuse): there is no oracle.
//
// What may revoke: only a presentation by the token's OWN client of a token that is a reuse beyond the
// window. A request from any other client, or for a token this server never issued, is refused and
// changes nothing, so an unbound request can never kill someone's family (the lesson of the code
// exchange).
//
// The access token's jti is recorded before the successor is committed, as on the code exchange, and
// revokeFamily marks the tokens before it reads the jtis: a reuse that races a refresh in flight
// either sees its jti or finds the refresh refused at commit (and the refresh revokes its own jti).
import type { Context } from "hono";
import type { Database } from "../db/types";
import { type AccessContext, mintAccessToken } from "./as-access";
import { accountBounds, applyBounds } from "./as-account";
import type { FormReader } from "./as-client-auth";
import { type AsClient, sameResource, scopesCovered, splitScope } from "./as-clients";
import { revokeFamily } from "./as-grants";
import { loadRefresh, REFRESH_TOKEN_RE, standing, successorToken, useRefresh } from "./as-refresh";
import type { AuthRegistry } from "./registry";

export interface RefreshContext {
  c: Context;
  one: FormReader;
  client: AsClient;
  db: Database;
  registry: AuthRegistry;
  secret: string;
  access: AccessContext;
  now: () => number;
  log: (line: string) => void;
  fail: (status: 400 | 500, error: string, description: string) => Response;
}

export async function refreshGrant(
  x: RefreshContext,
  askedResource: string | undefined | null,
): Promise<Response> {
  const { c, one, client, db, registry, now, log } = x;
  const token = one("refresh_token");
  if (!token) return x.fail(400, "invalid_request", "refresh_token is required");
  const asked = one("scope");
  if (asked === null) return x.fail(400, "invalid_request", "scope may be sent once");
  if (
    askedResource === null ||
    (askedResource !== undefined && !sameResource(askedResource, x.access.resource))
  ) {
    return x.fail(400, "invalid_target", "resource must be this server's resource URL");
  }
  const bad = (why: string) => {
    log(`refresh refused: ${why}`);
    return x.fail(400, "invalid_grant", "the refresh token is invalid");
  };

  // ---- the token, and who it belongs to
  if (!REFRESH_TOKEN_RE.test(token)) return bad("not a refresh token");
  const rec = loadRefresh(db, token);
  if (rec === undefined) return bad("unknown refresh token");
  // Bound to the client it was issued to: anyone else learns nothing and changes nothing.
  if (rec.clientId !== client.clientId) return bad("refresh token issued to another client");
  const successor = successorToken(x.secret, token);
  const state = standing(db, rec, successor, now());
  if (state === "reuse") {
    revokeFamily(db, registry, rec.familyId, "refresh_token_reuse", now());
    return bad(`refresh token reuse, client=${rec.clientId}: the family is revoked`);
  }
  if (state === "dead") return bad("revoked, expired or no longer usable");

  // ---- the scope: narrower than the family's, never wider
  const held = splitScope(rec.scope);
  const named = splitScope(asked ?? "").filter((s) => s !== "offline_access");
  const wanted = named.length > 0 ? named : held;
  if (!scopesCovered(held, wanted)) return bad("scope wider than the family holds");

  // ---- the account's bounds as they are NOW
  const bounds = accountBounds(db, rec.sub);
  const bounded =
    bounds === undefined ? undefined : applyBounds(bounds, { scopes: wanted, vault: rec.vault });
  if (bounded === undefined || !bounded.ok) {
    return bad(`account bounds no longer allow this grant, client=${rec.clientId}`);
  }
  const scope = bounded.scopes.join(" ");

  // ---- issue: record and sign the access token, then commit the rotation
  let minted: { token: string; jti: string };
  try {
    minted = await mintAccessToken(x.access, {
      sub: rec.sub,
      clientId: client.clientId,
      scope,
      persona: rec.persona,
      vault: bounded.vault,
      familyId: rec.familyId,
      grantId: rec.grantId,
    });
  } catch (e) {
    log(`token not refreshed: ${e instanceof Error ? e.message : "signing failed"}`);
    return x.fail(500, "server_error", "the access token could not be issued");
  }
  let outcome: ReturnType<typeof useRefresh>;
  try {
    outcome = useRefresh(db, { token, successor, now: now() });
  } catch (e) {
    registry.revoke(minted.jti, "refresh_not_committed");
    log(`token not refreshed: ${e instanceof Error ? e.message : "rotation failed"}`);
    return x.fail(500, "server_error", "the access token could not be issued");
  }
  if (outcome === "reuse") {
    // Lost a race to the successor's first use: the token is behind, and that is a reuse.
    revokeFamily(db, registry, rec.familyId, "refresh_token_reuse", now());
    return bad(`refresh token reuse, client=${rec.clientId}: the family is revoked`);
  }
  if (outcome === "dead") {
    registry.revoke(minted.jti, "refresh_refused");
    return bad("revoked or expired while refreshing");
  }
  log(`token refreshed client=${client.clientId}`);
  c.header("pragma", "no-cache");
  return c.json({
    access_token: minted.token,
    token_type: "Bearer",
    expires_in: x.access.accessTokenSeconds,
    refresh_token: successor,
    scope,
  });
}
