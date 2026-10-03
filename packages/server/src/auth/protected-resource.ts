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

type AuthConfig = ServerConfig["auth"];
/** The fields the audience and PRM decisions read, so server_health and `doctor` can ask with the
 *  config slice they already hold. */
export type PrmFields = Partial<
  Pick<AuthConfig, "mode" | "oidc" | "resource" | "authorizationServers">
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
  return auth.authorizationServers ?? [];
}

/**
 * The audience every bearer check binds: an explicit `auth.audience`, else the PRM `resource` when
 * a complete PRM is configured, else undefined (not checked). ONE definition, shared by the MCP
 * HTTP edge and the `/metrics` scrape so the two cannot disagree about which tokens they accept.
 */
export function effectiveAudience(
  auth: AudienceFields | AuthConfig,
): string | string[] | undefined {
  // oidc mode binds ONLY its own audience: the PRM `resource` is a URL the client sees, while an IdP
  // API audience may be any registered identifier (`api://...`), so the two are not assumed equal.
  if (auth.mode === "oidc") return auth.oidc?.audience;
  return auth.audience ?? (isPrmConfigured(auth) ? auth.resource : undefined);
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
export function buildProtectedResourceMetadata(auth: AuthConfig): ProtectedResourceMetadata {
  return {
    resource: auth.resource as string,
    authorization_servers: authorizationServersOf(auth),
    // RFC 9728 §5.2, OPTIONAL. The token verifier (transports/http.ts `bearer()`) reads ONLY the
    // Authorization header -- never a request body or query string -- so `["header"]` is a fixed
    // fact about this deployment, not something an operator configures per instance.
    bearer_methods_supported: ["header"],
    ...(auth.scopesSupported ? { scopes_supported: auth.scopesSupported } : {}),
    ...(auth.resourceName ? { resource_name: auth.resourceName } : {}),
  };
}

/**
 * Absolute URL where this server serves its PRM, derived from the configured resource ORIGIN — never
 * from a request Host header, so an attacker cannot make the server advertise a resource_metadata
 * URL it controls. Precondition: isPrmConfigured(auth).
 */
export function resourceMetadataUrl(auth: AuthConfig): string {
  // THE-583: the SDK's own derivation, so the well-known path is not a string we maintain a second
  // copy of (SEP-2351 adjusts this suffix, and a stale copy would advertise a URL nothing serves).
  return getOAuthProtectedResourceMetadataUrl(new URL(auth.resource as string));
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
export function wwwAuthenticateChallenge(auth: AuthConfig): string {
  const scopes = auth.scopesSupported;
  const scope =
    scopes && scopes.length > 0 ? `, scope="${scopes.join(" ").replace(/"/g, "")}"` : "";
  return `Bearer realm="obsidian-tc", resource_metadata="${resourceMetadataUrl(auth)}"${scope}`;
}
