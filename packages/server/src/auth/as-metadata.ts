// RFC 8414 authorization-server metadata for the bundled authorization server (design v2 section
// 4.3). A pure function of config: the issuer and every endpoint URL come from `auth.as.issuer`,
// never from the request's Host or X-Forwarded-* headers (RFC 9700 4.13), so the document cannot be
// steered by whoever sends the request. Built once at boot and served as a constant.
//
// What the fields promise is what the MCP clients key on: Claude uses a Client ID Metadata Document
// only when `client_id_metadata_document_supported` is true AND `none` is a listed client-auth
// method; ChatGPT needs `code_challenge_methods_supported: ["S256"]` and RFC 9207 `iss`
// (`authorization_response_iss_parameter_supported`), and stops sending a `private_key_jwt`
// assertion on every exchange when that method is simply not advertised.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Hono } from "hono";

type AuthConfig = ServerConfig["auth"];
type AsConfig = NonNullable<AuthConfig["as"]>;

/** The paths the bundled authorization server serves under its issuer. */
export const AS_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  revoke: "/oauth/revoke",
  register: "/oauth/register",
  jwks: "/.well-known/jwks.json",
} as const;

export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
/** OpenID Connect discovery alias: the same document, discovery fields only (no `id_token`). */
export const AS_DISCOVERY_ALIAS_PATH = "/.well-known/openid-configuration";

export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  registration_endpoint?: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  authorization_response_iss_parameter_supported: boolean;
  scopes_supported: string[];
}

/** The enabled AS block with its issuer, or undefined: the one definition of "the AS is on". */
export function enabledAs(auth: Pick<AuthConfig, "as">): (AsConfig & { issuer: string }) | undefined {
  const as = auth.as;
  return as?.enabled === true && as.issuer !== undefined
    ? (as as AsConfig & { issuer: string })
    : undefined;
}

/**
 * Build the metadata document. Fails closed on a config that is not an enabled authorization server
 * with an issuer: the schema already refuses that at load, so reaching here with one is a bug in the
 * caller, and a document advertising no issuer is worse than none.
 */
export function buildAsMetadata(auth: AuthConfig): AsMetadata {
  const as = enabledAs(auth);
  if (as === undefined) {
    throw new Error("auth.as is not enabled with an issuer: no authorization-server metadata");
  }
  const { issuer } = as;
  const confidential = as.clients.some((c) => c.secretEnv !== undefined);
  const scopes = [...(auth.scopesSupported ?? [])];
  if (!scopes.includes("offline_access")) scopes.push("offline_access");
  return {
    issuer,
    authorization_endpoint: `${issuer}${AS_PATHS.authorize}`,
    token_endpoint: `${issuer}${AS_PATHS.token}`,
    revocation_endpoint: `${issuer}${AS_PATHS.revoke}`,
    jwks_uri: `${issuer}${AS_PATHS.jwks}`,
    // Only when DCR is on: a client that finds the member tries to register, so advertising it with
    // the flag off would turn every first connection into a failed registration.
    ...(as.dynamicRegistration ? { registration_endpoint: `${issuer}${AS_PATHS.register}` } : {}),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // `none` (public client + PKCE) is all CIMD clients need; `client_secret_basic` only for a
    // configured confidential client. `private_key_jwt` is deliberately never advertised.
    token_endpoint_auth_methods_supported: confidential ? ["none", "client_secret_basic"] : ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: scopes,
  };
}

/** Serve the metadata (and its discovery alias) when the AS is enabled; a no-op otherwise. */
export function mountAsMetadata(app: Hono, auth: AuthConfig): void {
  if (enabledAs(auth) === undefined) return;
  const body = JSON.stringify(buildAsMetadata(auth));
  const serve = () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  app.get(AS_METADATA_PATH, serve);
  app.get(AS_DISCOVERY_ALIAS_PATH, serve);
}
