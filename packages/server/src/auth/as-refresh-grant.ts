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
//
// The one-step window is idempotent: a retry of a parent whose successor exists is answered with the
// stored first response (same access token, same successor) and mints nothing, so one stolen token
// cannot be turned into any number of bearers. A token minted under another server secret is retired.

import type { Context } from "hono";
import { decodeJwt } from "jose";
import type { Database } from "../db/types";
import { type AccessContext, mintAccessToken } from "./as-access";
import { accountBounds, applyBounds } from "./as-account";
import type { FormReader } from "./as-client-auth";
import { type AsClient, scopesCovered, splitScope } from "./as-clients";
import { noteClientUsed } from "./as-dcr";
import { drainRevocations, revokeFamily } from "./as-grants";
import {
  loadRefresh,
  loadReplay,
  REFRESH_TOKEN_RE,
  standing,
  successorToken,
  useRefresh,
} from "./as-refresh";
import { openResponse, sealResponse, secretGeneration } from "./as-refresh-replay";
import type { AuthRegistry } from "./registry";
import { matchResource } from "./resource-set";

export interface RefreshContext {
  c: Context;
  one: FormReader;
  client: AsClient;
  db: Database;
  registry: AuthRegistry;
  secret: string;
  access: AccessContext;
  now: () => number;
  /** `auth.as.refreshReuseGraceSeconds` in ms (see `standing`). */
  reuseGraceMs: number;
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
  const askedMember =
    typeof askedResource === "string" ? matchResource(askedResource, x.access.resource) : undefined;
  if (askedResource === null || (askedResource !== undefined && askedMember === undefined)) {
    return x.fail(400, "invalid_target", "resource must be this server's resource URL");
  }
  const bad = (why: string) => {
    log(`refresh refused: ${why}`);
    return x.fail(400, "invalid_grant", "the refresh token is invalid");
  };

  // ---- revocations owed to the registry are paid before anything is decided on top of them
  try {
    drainRevocations(db, registry);
  } catch (e) {
    log(`token not refreshed: ${e instanceof Error ? e.message : "revocations not recorded"}`);
    return x.fail(500, "server_error", "the access token could not be issued");
  }

  // ---- the token, and who it belongs to
  if (!REFRESH_TOKEN_RE.test(token)) return bad("not a refresh token");
  const rec = loadRefresh(db, token);
  if (rec === undefined) return bad("unknown refresh token");
  // Bound to the client it was issued to: anyone else learns nothing and changes nothing.
  if (rec.clientId !== client.clientId) return bad("refresh token issued to another client");
  // The family keeps the resource its grant was consented for; naming another one here is refused.
  const resource = matchResource(rec.resource, x.access.resource);
  if (resource === undefined) return bad("the grant's resource is no longer served");
  if (askedMember !== undefined && askedMember !== resource) {
    return x.fail(400, "invalid_target", "resource differs from the one the token was issued for");
  }
  const successor = successorToken(x.secret, token);
  const secretGen = secretGeneration(x.secret);
  /** The token's own client presented a reuse, or a token of a retired secret: the family goes. */
  const retire = (why: "reuse" | "foreign") => {
    revokeFamily(db, registry, rec.familyId, `refresh_token_${why}`, now());
    return bad(
      why === "reuse"
        ? `refresh token reuse, client=${rec.clientId}: the family is revoked`
        : `refresh token of a replaced server secret, client=${rec.clientId}: the family is revoked`,
    );
  };
  const answer = (r: { token: string; scope: string; expiresIn: number }) => {
    log(`token refreshed client=${client.clientId}`);
    c.header("pragma", "no-cache");
    return c.json({
      access_token: r.token,
      token_type: "Bearer",
      expires_in: r.expiresIn,
      refresh_token: successor,
      scope: r.scope,
    });
  };
  /** The stored first response, if it is still good for exactly what this request asks. */
  const replayed = (vault: string | null, scope: string): Response | undefined => {
    const stored = openResponse(x.secret, rec.tokenHash, loadReplay(db, rec.tokenHash));
    const left = stored === undefined ? 0 : stored.exp * 1000 - now();
    if (
      stored === undefined ||
      left <= 0 ||
      stored.vault !== vault ||
      stored.scope !== scope ||
      registry.isRevoked(stored.jti)
    ) {
      return undefined;
    }
    return answer({ token: stored.token, scope: stored.scope, expiresIn: Math.ceil(left / 1000) });
  };
  const graceMs = x.reuseGraceMs;
  const state = standing(db, rec, { successor, secretGen, now: now(), graceMs });
  if (state === "reuse" || state === "foreign") return retire(state);
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

  // ---- the window: a retry gets the first response again and mints nothing
  if (state === "retry")
    return replayed(bounded.vault, scope) ?? bad("the stored response cannot be repeated");

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
      resource,
    });
  } catch (e) {
    log(`token not refreshed: ${e instanceof Error ? e.message : "signing failed"}`);
    return x.fail(500, "server_error", "the access token could not be issued");
  }
  let outcome: ReturnType<typeof useRefresh>;
  try {
    const replay = sealResponse(x.secret, rec.tokenHash, {
      token: minted.token,
      jti: minted.jti,
      exp: decodeJwt(minted.token).exp as number,
      scope,
      vault: bounded.vault,
    });
    outcome = useRefresh(db, { token, successor, secretGen, replay, now: now(), graceMs });
  } catch (e) {
    registry.revoke(minted.jti, "refresh_not_committed");
    log(`token not refreshed: ${e instanceof Error ? e.message : "rotation failed"}`);
    return x.fail(500, "server_error", "the access token could not be issued");
  }
  if (outcome === "reuse" || outcome === "foreign") return retire(outcome);
  if (outcome === "dead") {
    registry.revoke(minted.jti, "refresh_refused");
    return bad("revoked or expired while refreshing");
  }
  if (outcome === "retry") {
    // Another request of this token committed first: its response is THE response, ours was never out.
    registry.revoke(minted.jti, "refresh_superseded");
    return replayed(bounded.vault, scope) ?? bad("the stored response cannot be repeated");
  }
  noteClientUsed(db, client.clientId, now());
  return answer({ token: minted.token, scope, expiresIn: x.access.accessTokenSeconds });
}
