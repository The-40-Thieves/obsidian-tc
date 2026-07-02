// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP 2025-11-25 resource-server role
// (THE-278). Pure builders — no framework, no I/O. The HTTP transport serves the document and
// emits the WWW-Authenticate challenge; the HS256 token format is unchanged. The authorization-
// server half (token issuance, Dynamic Client Registration, OIDC discovery) is intentionally out
// of scope: obsidian-tc points at an EXTERNAL authorization server via config when one exists.
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

/** Build the RFC 9728 document from config. Precondition: isPrmConfigured(auth). */
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
  return new URL("/.well-known/oauth-protected-resource", auth.resource as string).toString();
}

/** RFC 6750 / RFC 9728 §5.1 challenge pointing the client at the PRM document. */
export function wwwAuthenticateChallenge(auth: AuthConfig): string {
  return `Bearer realm="obsidian-tc", resource_metadata="${resourceMetadataUrl(auth)}"`;
}
