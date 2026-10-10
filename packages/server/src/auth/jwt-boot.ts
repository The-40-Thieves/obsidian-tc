import { readFileSync } from "node:fs";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { enabledAs } from "./as-metadata";
import {
  jwksWithoutAudience,
  jwksWithoutAudienceMessage,
  verifierAudience,
} from "./protected-resource";
import type { AuthRegistry } from "./registry";
import { createTokenVerifier, type TokenVerifier } from "./verifier";

/** The missing-audience deprecation line, once per call. `buildJwtVerifier` emits it; so does a boot
 *  that builds no verifier (stdio only), which would otherwise never say it. */
export function warnJwksWithoutAudience(auth: ServerConfig["auth"]): void {
  if (jwksWithoutAudience(auth)) {
    process.stderr.write(`auth: DEPRECATED: ${jwksWithoutAudienceMessage(auth)}\n`);
  }
}

/**
 * Build the `auth.mode: jwt` bearer verifier from config, ONCE per process. The MCP HTTP edge and
 * `/metrics` are handed this same instance (see `wireTransports`), so they cannot disagree about
 * which tokens are accepted: every key source (secret, inline JWKS, `jwksFile`, `jwksUri`, registry
 * keys), the audience/issuer binding, the algorithm allowlist and `requireJti` live here and nowhere
 * else. `null` when the mode is not jwt or no key source is configured.
 *
 * THE-297: `jwksFile` loads ONCE here (file/inline only), so rotation is multiple kid'd keys in the
 * set, or a restart after replacing the file.
 */
export function buildJwtVerifier(
  auth: ServerConfig["auth"],
  registry?: AuthRegistry,
): TokenVerifier | null {
  if (auth.mode !== "jwt") return null;
  const jwks =
    auth.jwks ??
    (auth.jwksFile
      ? (JSON.parse(readFileSync(auth.jwksFile, "utf8")) as Record<string, unknown>)
      : undefined);
  // THE-456: bind the token audience. An explicit auth.audience wins; otherwise, when PRM is
  // configured, default it to the canonical `resource` URI (RFC 9728 / MCP 2025-11-25 require a
  // protected resource to accept only tokens whose aud is itself). Undefined keeps the legacy
  // behavior for local self-issued HS256. A JWKS (shared external issuer, `jwksUri` included) with
  // no effective audience is the confused-deputy hole: it still works this release, as a
  // deprecation (also in `doctor` and server_health) unless the operator opted out.
  const audience = verifierAudience(auth);
  warnJwksWithoutAudience(auth);
  // A remote key set (`jwksUri`) is a key source on its own: leaving it out returned no verifier for
  // a config whose only key source is the URL, which the edge then reported as "no verifier".
  if (!(auth.jwtSecret || jwks || auth.jwksUri || registry)) return null;
  return createTokenVerifier({
    secret: auth.jwtSecret,
    jwks,
    jwksUri: auth.jwksUri,
    algorithms: auth.algorithms,
    maxAgeSeconds: auth.tokenTtlSeconds,
    audience,
    issuer: auth.issuer,
    registry,
    requireJti: auth.requireJti,
    // A token signed by an `as`-purpose registry key is verified only when the bundled authorization
    // server is enabled: its issuer comes from `auth.as`, the audience from `auth.resource`. With the
    // AS off, no `as` key's token verifies (`misconfigured`), whatever the registry holds.
    asIssuer: enabledAs(auth)?.issuer,
    resource: auth.resource,
  });
}
