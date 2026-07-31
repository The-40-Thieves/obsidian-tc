// WP1.1: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any vault schema. Refinements that only read fields WITHIN auth or ACL
// move here with their schema; a refinement that reads ANOTHER domain (e.g. the http/auth
// interlock in ServerConfigSchema.superRefine) stays in config.schema.ts.
import { z } from "zod";

export const AuthConfigSchema = z
  .object({
    mode: z
      .enum(["none", "jwt"])
      .default("none")
      .describe(
        "Authentication mode. `none` grants every request full wildcard scopes and is refused on a non-loopback HTTP bind; `jwt` requires a jwtSecret or a JWKS.",
      ),
    jwtSecret: z
      .string()
      .min(32)
      .optional()
      .describe(
        "Shared secret for HS256 verification, minimum 32 characters. Secret. HS256 tokens verify ONLY against this, never against the JWKS.",
      ),
    tokenTtlSeconds: z
      .number()
      .int()
      .positive()
      .default(86400)
      .describe(
        "Maximum accepted token AGE in seconds, measured from the token's `iat`. This caps age INDEPENDENTLY of `exp`: a token with a one-year expiry is still rejected once it is older than this, so a long-lived credential needs this raised to match.",
      ),
    // THE-297 — asymmetric verification (RS256/ES256/EdDSA) behind the TokenVerifier seam.
    // `jwks` is an inline JWKS document; `jwksFile` a path loaded once at transport boot (file
    // or inline only — no URL fetch: no new network attack surface). Key rotation = multiple
    // keys in the set, selected by the token's `kid` header (jose). HS256 stays available
    // beside it; alg-confusion is structurally impossible (HS256 verifies ONLY against
    // jwtSecret, asymmetric algs ONLY against the JWKS).
    jwks: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Inline JWKS document for asymmetric verification (RS256/ES256/EdDSA). Rotation is multiple keys in the set, selected by the token's `kid`.",
      ),
    jwksFile: z
      .string()
      .optional()
      .describe(
        "Path to a JWKS document, loaded once at transport boot. Adds no network dependency; prefer it over jwksUri when the keys are static.",
      ),
    // THE-658: fetch the JWKS from an authorization server's `jwks_uri`.
    //
    // THE-297 deliberately allowed inline/file ONLY, reasoning that a URL fetch adds network
    // attack surface. That reasoning still holds and is why this is OPT-IN and unset by default —
    // it is not a silent reversal. What it buys is the thing that made adopting a real
    // authorization server a code change rather than a config change: with inline keys, every AS
    // key rotation means an operator hand-copying a JWKS and redeploying, so rotation (the entire
    // point of asymmetric verification) becomes a manual outage risk.
    //
    // The added surface is bounded: jose caches the fetched set and re-fetches only on an unknown
    // `kid`, the URL is operator-configured (never derived from a request), and a fetch failure
    // rejects the token rather than falling back to any other key source.
    jwksUri: z
      .string()
      .url()
      .optional()
      .describe(
        "URL of an authorization server's JWKS (its `jwks_uri`), fetched and cached for asymmetric verification. Opt-in: it adds a network dependency to token verification, which jwks/jwksFile do not. Use it when an external AS rotates keys.",
      ),
    algorithms: z
      .array(z.string())
      .optional()
      .describe(
        "Explicit allowlist of accepted JWT algorithms. Algorithm confusion is structurally impossible regardless: HS256 verifies only against jwtSecret and asymmetric algorithms only against the JWKS.",
      ),
    // THE-456 — audience/issuer binding. When set, the JWT verifier enforces them (jose rejects a
    // token whose `aud`/`iss` does not match), closing the confused-deputy / token-passthrough gap
    // the MCP 2025-11-25 authorization spec requires of a protected resource. `audience` defaults to
    // the configured `resource` URI (below) when PRM is set, so a token an external AS minted for a
    // DIFFERENT service is rejected here. Both unset (and no PRM `resource`) keeps the current
    // behavior for local self-issued HS256 tokens.
    audience: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Expected `aud` claim. Binding it rejects a token an issuer minted for a DIFFERENT service (confused deputy). Required with a JWKS or a non-loopback bind; defaults to `resource` when Protected Resource Metadata is configured.",
      ),
    issuer: z
      .string()
      .optional()
      .describe(
        "Expected `iss` claim. Setting it also requires an audience — validating the issuer alone does not establish that the token was meant for this server.",
      ),
    // MCP 2025-11-25 / RFC 9728 Protected Resource Metadata (THE-278). All optional; the HS256 token
    // format is unchanged. When `resource` + at least one `authorizationServers` entry are set, the
    // HTTP transport advertises a spec-compliant PRM document + WWW-Authenticate challenge for the
    // OAuth 2.1 resource-server role. The authorization-server half (token issuance / DCR / OIDC)
    // stays out of scope until a real external AS exists.
    resource: z
      .string()
      .url()
      .optional()
      .describe(
        "This server's canonical resource URI (RFC 9728). Set together with authorizationServers to advertise Protected Resource Metadata; also serves as the default bound audience.",
      ),
    authorizationServers: z
      .array(z.string().url())
      .optional()
      .describe(
        "Authorization server issuer URLs advertised in the Protected Resource Metadata document. At least one is needed for PRM to be served.",
      ),
    resourceName: z
      .string()
      .optional()
      .describe(
        "Human-readable resource name published in the Protected Resource Metadata document.",
      ),
    scopesSupported: z
      .array(z.string())
      .optional()
      .describe("Scopes advertised as supported in the Protected Resource Metadata document."),
  })
  .refine((c) => c.mode !== "jwt" || !!c.jwtSecret || !!c.jwks || !!c.jwksFile || !!c.jwksUri, {
    message:
      "auth.mode 'jwt' requires jwtSecret (>=32 chars) or a JWKS (jwks / jwksFile / jwksUri)",
    path: ["jwtSecret"],
  });
export const AclRuleSchema = z.object({
  glob: z.string().min(1).describe("Glob matched against the vault-relative note path."),
  scopes: z
    .array(z.string())
    .default([])
    .describe(
      "Scopes REQUIRED to operate on paths matching this rule (P1.4): a caller must hold every listed scope, in addition to the tool's own required scopes, to read/write/delete a matching path. The LAST matching rule wins, replacing rather than merging the scopes of earlier matches. An empty list adds no requirement. Enforced at dispatch on tool operations; it does not filter search/enumeration result visibility, which is governed by readPaths.",
    ),
});

export const AclConfigSchema = z.object({
  readOnly: z
    .boolean()
    .default(false)
    .describe(
      "Reject every mutating operation on this vault regardless of the scopes a caller holds.",
    ),
  defaultScopes: z
    .array(z.string())
    .default([])
    .describe(
      "Scopes REQUIRED to operate on a path that matches no rule (P1.4). Empty (the default) adds no requirement.",
    ),
  rules: z
    .array(AclRuleSchema)
    .default([])
    .describe(
      "Ordered glob-to-required-scope rules enforced at dispatch (P1.4). Later matches override earlier ones.",
    ),
  // Per-path operation ACL (G2.2 section 5 / G2.4). Optional and back-compatible:
  // when a field is omitted that operation kind is unrestricted (M0 behavior);
  // when present it is a glob whitelist — a path must match at least one entry.
  // camelCase mirrors the rest of the config (readOnly, defaultScopes).
  readPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Glob whitelist for reads: a path must match at least one entry. Omitted leaves reads unrestricted (see strictReadDefault).",
    ),
  writePaths: z
    .array(z.string())
    .optional()
    .describe(
      "Glob whitelist for writes: a path must match at least one entry. Omitted leaves writes unrestricted.",
    ),
  deletePaths: z
    .array(z.string())
    .optional()
    .describe(
      "Glob whitelist for deletes: a path must match at least one entry. Omitted leaves deletes unrestricted.",
    ),
  /** When true, an UNDEFINED readPaths whitelist fails CLOSED on the request path (read_note et
   *  al.), not just bridge enumeration (THE-268). Default false = M0 allow-all back-compat. */
  strictReadDefault: z
    .boolean()
    .default(false)
    .describe(
      "When true, an UNDEFINED readPaths whitelist fails CLOSED on the request path rather than only on bridge enumeration. Default false preserves allow-all back-compatibility.",
    ),
});
