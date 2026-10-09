// `POST /oauth/revoke` of the bundled authorization server (RFC 7009; design v2 section 4.3). The
// client authenticates exactly as at the token endpoint. A refresh token revokes its whole family
// (the token and every access token issued from it); an access token revokes its own `jti` in the
// registry's revoked set, which is what the verifier at /mcp consults.
//
// No oracle: anything the server cannot act on (an unknown or expired token, a token that belongs to
// another client, a forged signature, a token already revoked) is the same empty 200 as a success, so
// the response never says whether a value was a token. The only refusals are the ones about the
// REQUEST (no token, wrong encoding) and about the CLIENT's own credentials. `token_type_hint` is a
// hint only: the value is tried as a refresh token and as an access token whatever it says.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import { decodeProtectedHeader, jwtVerify } from "jose";
import {
  authenticateClient,
  clientFailureStatus,
  formReader,
  isFormRequest,
} from "./as-client-auth";
import { clientResolverFor } from "./as-client-resolver";
import { revokeFamily } from "./as-grants";
import { type AsRouteDeps, enabledAs } from "./as-metadata";
import { socketClientIp } from "./as-operator";
import { loadRefresh, REFRESH_TOKEN_RE } from "./as-refresh";
import { importVerificationKey } from "./signing-keys";

type AuthConfig = ServerConfig["auth"];

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

export function mountRevokeRoute(app: Hono, auth: AuthConfig, deps?: AsRouteDeps): void {
  const as = enabledAs(auth);
  if (as === undefined || deps === undefined) return;
  const { db, registry } = deps;
  const resolveClient = clientResolverFor(deps, as);
  const clientIp = deps.clientIp ?? socketClientIp;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const resource = auth.resource as string;

  const fail = (c: Context, status: 400 | 401 | 415 | 503, error: string, description: string) => {
    if (status === 401) c.header("www-authenticate", 'Basic realm="oauth"');
    return c.json({ error, error_description: description }, status);
  };

  /** Revoke `token` as the refresh token of `clientId`'s, if that is what it is. */
  const revokeRefresh = (token: string, clientId: string): boolean => {
    if (!REFRESH_TOKEN_RE.test(token)) return false;
    const rec = loadRefresh(db, token);
    if (rec === undefined || rec.clientId !== clientId) return false;
    revokeFamily(db, registry, rec.familyId, "revoked_by_client", now());
    log(`refresh token revoked client=${clientId}`);
    return true;
  };

  /** The jti of `token` if it is a valid access token of `clientId`'s: signed by an `as` key, for this resource. */
  const accessJti = async (token: string, clientId: string): Promise<string | undefined> => {
    try {
      const { kid } = decodeProtectedHeader(token);
      if (!registry.hasKey(kid)) return undefined;
      const m = registry.verificationMaterial(kid);
      if (m.purpose !== "as" || m.alg === "HS256") return undefined;
      const key = await importVerificationKey(m.alg, m.publicJwk);
      const { payload } = await jwtVerify(token, key, {
        algorithms: [m.alg],
        typ: "at+jwt",
        issuer: as.issuer,
        audience: resource,
        currentDate: new Date(now()),
      });
      return payload.client_id === clientId && typeof payload.jti === "string"
        ? payload.jti
        : undefined;
    } catch {
      // Not a token this server signed, or expired: nothing to revoke, and not worth saying.
      return undefined;
    }
  };

  const revokeAccess = async (token: string, clientId: string): Promise<boolean> => {
    const jti = await accessJti(token, clientId);
    if (jti === undefined) return false;
    // Outside the try above: a registry that cannot record the revocation is a 500, never a false 200.
    registry.revoke(jti, "revoked_by_client");
    log(`access token revoked client=${clientId}`);
    return true;
  };

  app.post("/oauth/revoke", async (c) => {
    if (!isFormRequest(c)) {
      return fail(c, 415, "invalid_request", "the body must be application/x-www-form-urlencoded");
    }
    const form = new URLSearchParams(await c.req.text());
    const authed = await authenticateClient(
      (id) => resolveClient(id, { source: clientIp(c) }),
      form,
      c.req.header("authorization"),
    );
    if ("failure" in authed) {
      const { status, error } = clientFailureStatus(authed);
      return fail(c, status, error, authed.failure);
    }
    const token = formReader(form)("token");
    if (!token) return fail(c, 400, "invalid_request", "token is required");

    // The hint only picks which to try first; a wrong one still finds the token.
    const hint = formReader(form)("token_type_hint");
    const clientId = authed.client.clientId;
    if (hint === "access_token") {
      if (!(await revokeAccess(token, clientId))) revokeRefresh(token, clientId);
    } else if (!revokeRefresh(token, clientId)) {
      await revokeAccess(token, clientId);
    }
    return c.body(null, 200);
  });
}
