// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP 2025-11-25 resource-server role
// (THE-278). Pure builders — no framework, no I/O. The HTTP transport serves the document and
// emits the WWW-Authenticate challenge; the HS256 token format is unchanged. The authorization-
// server half (token issuance, Dynamic Client Registration, OIDC discovery) is intentionally out
// of scope: obsidian-tc points at an EXTERNAL authorization server via config when one exists.
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";

type AuthConfig = ServerConfig["auth"];

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  resource_name?: string;
}

/**
 * True when the operator has configured a COMPLETE PRM document: a canonical `resource` URI AND at
 * least one authorization server. MCP 2025-11-25 requires `authorization_servers` to be non-empty,
 * so an AS-less config advertises nothing (and the default config serves no PRM at all).
 */
export function isPrmConfigured(auth: AuthConfig): boolean {
  return !!auth.resource && (auth.authorizationServers?.length ?? 0) > 0;
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
    authorization_servers: auth.authorizationServers ?? [],
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

/** RFC 6750 / RFC 9728 §5.1 challenge pointing the client at the PRM document. */
export function wwwAuthenticateChallenge(auth: AuthConfig): string {
  return `Bearer realm="obsidian-tc", resource_metadata="${resourceMetadataUrl(auth)}"`;
}
