// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP resource-server role (THE-278),
// current as of protocol version 2026-07-28 (mcp/server.ts MODERN_PROTOCOL_VERSION) as well as
// 2025-11-25 -- the requirements this file implements are unchanged across both dated specs. Pure
// builders — no framework, no I/O. The HTTP transport serves the document and emits the
// WWW-Authenticate challenge; the HS256 token format is unchanged. The authorization-server half
// (token issuance, Dynamic Client Registration, OIDC discovery) is intentionally out of scope:
// obsidian-tc points at an EXTERNAL authorization server via config when one exists, and until then
// stays pre-registration-only (THE-661; see isPrmConfigured for the dated decision).
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { URL_SURFACE_NAMES } from "../mcp/tool-profiles";
import { advertisedScopes, asIssuing, enabledAs } from "./as-metadata";
import { allowedResources, surfaceResource } from "./resource-set";

type AuthConfig = ServerConfig["auth"];
/** The fields the audience and PRM decisions read, so server_health and `doctor` can ask with the
 *  config slice they already hold. */
export type PrmFields = Partial<
  Pick<AuthConfig, "mode" | "oidc" | "resource" | "authorizationServers" | "as">
>;
export type AudienceFields = PrmFields &
  Partial<Pick<AuthConfig, "audience" | "jwks" | "jwksFile" | "jwksUri" | "allowMissingAudience">>;

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  resource_name?: string;
  bearer_methods_supported: string[];
}

/**
 * True when the operator has configured a COMPLETE PRM document: a canonical `resource` URI AND at
 * least one authorization server.
 *
 * THE-661: RFC 9728 alone treats `authorization_servers` as OPTIONAL -- only `resource` is
 * REQUIRED. But obsidian-tc doesn't implement bare RFC 9728; it implements the MCP authorization
 * spec's overlay on top of it (see the file header), and THAT spec is stricter: "The Protected
 * Resource Metadata document returned by the MCP server MUST include the `authorization_servers`
 * field containing at least one authorization server." That sentence is identical, word for word,
 * in both the 2025-11-25 and the current 2026-07-28 dated spec (verified against both spec pages
 * directly, not assumed from the version bump) -- so this is not a stale check to relax by era.
 * Serving a `resource`-only document would be a document missing a field the protocol we implement
 * says MUST be present, which is worse than serving none: a client would discover a PRM, find no
 * usable authorization server in it, and have gained nothing over a 404. Omitting the PRM (and, by
 * the same guard, the WWW-Authenticate `resource_metadata` pointer -- see transports/http.ts) is
 * the spec-compliant response to "no authorization server is configured."
 *
 * Dated decision (2026-07-28): obsidian-tc stays pre-registration-only for now. Its sole client is
 * LiteLLM, a single fixed self-operated process -- exactly the "existing relationship" case the
 * spec's client-registration priority order lists first, ahead of Client ID Metadata Documents and
 * Dynamic Client Registration. No authorization server is being stood up. Re-check this decision
 * when either (a) a third-party MCP client needs access with no prior relationship, so
 * pre-registration stops being sufficient, or (b) access becomes multi-user.
 */
export function isPrmConfigured(auth: PrmFields): boolean {
  return !!auth.resource && authorizationServersOf(auth).length > 0;
}

/**
 * The authorization servers this resource advertises. Under `auth.mode: oidc` that is the external
 * identity provider's issuer, by construction (the schema refuses any other explicit list), so a
 * bring-your-own-IdP deployment needs `auth.resource` and nothing else to be discoverable.
 */
function authorizationServersOf(auth: PrmFields): string[] {
  if (auth.mode === "oidc" && auth.oidc !== undefined) return [auth.oidc.issuer];
  // The bundled authorization server defaults to advertising itself, but only once it can issue: a
  // PRM naming an issuer whose authorize and token routes do not exist sends clients into a dead
  // flow. An explicit list is kept as written (the schema already requires the issuer to be its
  // first entry: Claude reads only that).
  const bundled = asIssuing(auth) ? enabledAs(auth)?.issuer : undefined;
  if (bundled !== undefined) return auth.authorizationServers ?? [bundled];
  return auth.authorizationServers ?? [];
}

/**
 * The audience every bearer check binds: an explicit `auth.audience`, else the PRM `resource` when
 * a complete PRM is configured, else undefined (not checked). ONE definition, shared by the MCP
 * HTTP edge and the `/metrics` scrape so the two cannot disagree about which tokens they accept.
 *
 * This is the single source for "was this token issued for this server". The SDK 2.3
 * `expectedResource` option of `requireBearerAuth` / `verifyBearerToken` is deliberately NOT
 * adopted: neither function runs here (bearer auth is the Hono middleware in transports/http.ts,
 * verified by jose with `audience` from this function), so there is no plug-in point, and wiring a
 * second comparison would need a second copy of this resolution (including the oidc exception
 * above and the string-array form) that could drift from the first.
 */
export function effectiveAudience(
  auth: AudienceFields | AuthConfig,
): string | string[] | undefined {
  // oidc mode binds ONLY its own audience: the PRM `resource` is a URL the client sees, while an IdP
  // API audience may be any registered identifier (`api://...`), so the two are not assumed equal.
  if (auth.mode === "oidc") return auth.oidc?.audience;
  // The bundled AS's default PRM entry is deliberately NOT read here (`as: undefined`): it exists for
  // discovery, and binding the audience on its account would turn every hand-minted token without an
  // `aud` into a 401 the moment `auth.as` is enabled (design v2 section 7). Tokens the AS issues are
  // checked against `auth.resource` by their own, stricter rules in the verifier.
  return auth.audience ?? (isPrmConfigured({ ...auth, as: undefined }) ? auth.resource : undefined);
}

/**
 * The audience the bearer verifier is built with. `effectiveAudience`, except that an audience which
 * is only the PRM `resource` (no explicit `auth.audience`, not `oidc`) also takes the resource's
 * profile URLs (`allowedResources`): a client that signed in at R/essentials holds a token an external
 * authorization server issued for that URL, and profiles are advertisement-only, so it is accepted
 * wherever R is. An explicit `auth.audience`, and the oidc audience, are exactly what the operator
 * wrote; to serve per-profile audiences there, list them (`auth.audience` takes an array).
 */
export function verifierAudience(auth: AudienceFields | AuthConfig): string | string[] | undefined {
  const audience = effectiveAudience(auth);
  if (auth.mode === "oidc" || auth.audience !== undefined || audience === undefined)
    return audience;
  return allowedResources(auth.resource as string);
}

/**
 * True when `auth.mode: jwt` verifies tokens against a JWKS (inline, file or URI) but binds NO
 * audience, and the operator has not opted out with `auth.allowMissingAudience`: a token the same
 * issuer minted for another service is then accepted here (confused deputy). The schema requires
 * `audience` or `resource` with a JWKS, but `resource` binds only with a complete PRM
 * (`isPrmConfigured`), so a `resource`-only config lands here. ONE definition for the startup line,
 * `doctor` and server_health.
 */
export function jwksWithoutAudience(auth: AudienceFields): boolean {
  return (
    auth.mode === "jwt" &&
    !!(auth.jwks || auth.jwksFile || auth.jwksUri) &&
    effectiveAudience(auth) === undefined &&
    auth.allowMissingAudience !== true
  );
}

/** The deprecation text for `jwksWithoutAudience`: what is wrong, the fix, the opt-out, the deadline. */
export function jwksWithoutAudienceMessage(auth: Pick<AuthConfig, "resource">): string {
  const resourceNote = auth.resource
    ? ` auth.resource is set but is used as the audience only when Protected Resource Metadata is complete (auth.authorizationServers too), so it binds nothing here.`
    : "";
  return (
    `auth.mode 'jwt' verifies tokens against a JWKS but no audience is enforced, so a token the same issuer minted for ANOTHER service is accepted (confused deputy).${resourceNote} ` +
    `Set auth.audience to this server's resource identifier. This becomes a startup error in the next minor release; ` +
    `auth.allowMissingAudience: true opts out (and stops this warning).`
  );
}

/**
 * Build the RFC 9728 document from config. Precondition: isPrmConfigured(auth).
 *
 * THE-583 deliberately does NOT use the SDK's `buildOAuthProtectedResourceMetadata` here, even
 * though the name matches. That helper derives the document from a FETCHED authorization-server
 * metadata document (it requires `options.oauthMetadata.issuer`); our config carries only a list of
 * AS URLs. Adopting it would mean fetching AS metadata at boot — a different design with a new
 * network dependency on the startup path, and properly part of choosing an AS (THE-658 step 3)
 * rather than a like-for-like swap. The URL derivation below IS the SDK's.
 */
export function buildProtectedResourceMetadata(
  auth: AuthConfig,
  surface?: string,
): ProtectedResourceMetadata {
  const scopes = advertisedScopes(auth);
  return {
    resource: profileResource(auth, surface),
    authorization_servers: authorizationServersOf(auth),
    // RFC 9728 §5.2, OPTIONAL. The token verifier (transports/http.ts `bearer()`) reads ONLY the
    // Authorization header -- never a request body or query string -- so `["header"]` is a fixed
    // fact about this deployment, not something an operator configures per instance.
    bearer_methods_supported: ["header"],
    ...(scopes ? { scopes_supported: scopes } : {}),
    ...(auth.resourceName ? { resource_name: auth.resourceName } : {}),
  };
}

/** The `resource` a PRM names: R, or R/<surface> for a profile URL (so it equals the URL the client
 *  entered). An R with no path to hang a profile on (a root URL) keeps R. */
function profileResource(auth: AuthConfig, surface?: string): string {
  const resource = auth.resource as string;
  return (surface === undefined ? undefined : surfaceResource(resource, surface)) ?? resource;
}

/**
 * Absolute URL where this server serves its PRM, derived from the configured resource ORIGIN — never
 * from a request Host header, so an attacker cannot make the server advertise a resource_metadata
 * URL it controls. Precondition: isPrmConfigured(auth).
 */
export function resourceMetadataUrl(auth: AuthConfig, surface?: string): string {
  // THE-583: the SDK's own derivation, so the well-known path is not a string we maintain a second
  // copy of (SEP-2351 adjusts this suffix, and a stale copy would advertise a URL nothing serves).
  return getOAuthProtectedResourceMetadataUrl(new URL(profileResource(auth, surface)));
}

/**
 * The path-aware PRM paths served for the profile URLs: one per known surface, each the path of
 * `resourceMetadataUrl(auth, surface)`. Unknown surfaces get none, so they stay 404.
 */
export function profileMetadataPaths(auth: AuthConfig): { surface: string; path: string }[] {
  return URL_SURFACE_NAMES.flatMap((surface) => {
    if (surfaceResource(auth.resource as string, surface) === undefined) return [];
    return [{ surface, path: new URL(resourceMetadataUrl(auth, surface)).pathname }];
  });
}

/**
 * RFC 6750 / RFC 9728 §5.1 challenge pointing the client at the PRM document.
 *
 * THE-658: carries `scope` when the operator configured `scopesSupported`. The 2026-07-28 spec
 * makes this a SHOULD, and the reason is concrete — a general-purpose MCP client has no
 * domain knowledge to pick scopes with. Its documented fallback when `scope` is absent is to request
 * EVERY scope in `scopes_supported`, so omitting the parameter does not fail closed; it pushes
 * clients toward asking for more than they need.
 */
export function wwwAuthenticateChallenge(auth: AuthConfig, surface?: string): string {
  const scopes = advertisedScopes(auth);
  const scope =
    scopes && scopes.length > 0 ? `, scope="${scopes.join(" ").replace(/"/g, "")}"` : "";
  return `Bearer realm="obsidian-tc", resource_metadata="${resourceMetadataUrl(auth, surface)}"${scope}`;
}

/**
 * The challenge in a tool error's `_meta["mcp/www_authenticate"]` (`auth.anonymousDiscovery: "list"`):
 * the 401's own challenge, so the same per-profile `resource_metadata`, plus the `error` and
 * `error_description` OpenAI requires for its account-linking UI (apps-sdk/build/auth, 2026-10-10).
 */
export function wwwAuthenticateToolChallenge(auth: AuthConfig, surface?: string): string {
  return `${wwwAuthenticateChallenge(auth, surface)}, error="insufficient_scope", error_description="Sign in to use this tool"`;
}
