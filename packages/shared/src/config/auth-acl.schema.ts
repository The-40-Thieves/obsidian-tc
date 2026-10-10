// WP1.1: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any vault schema. Refinements that only read fields WITHIN auth or ACL
// move here with their schema; a refinement that reads ANOTHER domain (e.g. the http/auth
// interlock in ServerConfigSchema.superRefine) stays in config.schema.ts.
import { z } from "zod";
import { isQualifiedScope } from "../scopes";
import { AsConfigSchema, HOSTNAME_RE } from "./auth-as.schema";
import { aclPathGlob } from "./path-glob";

// `auth.oidc`: verify access tokens issued by an EXTERNAL OpenID Connect provider (bring your own
// IdP). Verification only — obsidian-tc stays a resource server; the bundled authorization server
// is a separate design and lives under `auth.as`, a namespace this block does not use.
//
// Only asymmetric algorithms can be allowed. HS* never verifies an IdP token (the "key" would be a
// public value) and `none` is no signature at all, so neither is expressible, not merely defaulted off.
const OIDC_ALLOWED_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

const isHttpsUrl = (v: string, o: { allowQueryFragment: boolean }): boolean => {
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      u.username === "" &&
      u.password === "" &&
      (o.allowQueryFragment || (u.search === "" && u.hash === ""))
    );
  } catch {
    return false;
  }
};

// A claim location: a dotted path into NESTED objects (`realm_access.roles`), or an array of literal
// segments. A top-level claim whose own NAME contains dots (`https://app.example.com/roles`, the
// Auth0 namespaced form) can only be written as the array `["https://app.example.com/roles"]`: a
// string is always walked, so a forged top-level `realm_access.roles` never shadows the nested claim.
const ClaimPathSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const OidcConfigSchema = z
  .strictObject({
    issuer: z
      .string()
      .refine((v) => isHttpsUrl(v, { allowQueryFragment: false }), {
        message: "must be an https URL with no query, fragment or credentials",
      })
      .describe(
        "The identity provider's issuer identifier, an https URL. Compared EXACTLY (no normalisation, a trailing slash matters) against the `iss` claim of every token and the `issuer` member of the discovery document fetched from `<issuer>/.well-known/openid-configuration`.",
      ),
    audience: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .describe(
        "Required. The `aud` this server accepts: a token must name it (or one entry of a list). Use a dedicated API audience registered at the IdP, not a client id, so an ID token or another service's token is not accepted here.",
      ),
    clientId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. When set, the token's `client_id` (RFC 9068) or `azp` claim must equal it, restricting access to tokens minted for that one application. Unset accepts any client of the IdP that obtains a token for `audience`.",
      ),
    jwksUri: z
      .string()
      .refine((v) => isHttpsUrl(v, { allowQueryFragment: true }), {
        message: "must be an https URL",
      })
      .optional()
      .describe(
        "Optional override for the key set location. Discovery still runs (it validates the issuer); this replaces only the discovered `jwks_uri`. https only.",
      ),
    allowedJwksHosts: z
      .array(
        z
          .string()
          .regex(HOSTNAME_RE, "must be a bare lowercase hostname (no scheme, port or path)"),
      )
      .optional()
      .describe(
        "Optional. Hostnames a DISCOVERED `jwks_uri` may name besides the issuer's own origin. Without it the discovered `jwks_uri` must be on the same origin as `issuer` (a discovery document cannot redirect key material to another host). Needed for IdPs that serve keys from another host (Google: `www.googleapis.com`). A listed host admits the default https port (443) only: a `jwks_uri` on another port is refused (set `jwksUri` for that). Ignored when `jwksUri` is set. It never lifts the private-network block.",
      ),
    allowPrivateNetwork: z
      .boolean()
      .default(false)
      .describe(
        "Default false: the issuer and the JWKS host are resolved before every fetch and refused when any address is loopback, link-local (including the cloud metadata address), private (RFC 1918, unique-local) or otherwise non-public. Set true only for a self-hosted identity provider on a LAN or loopback.",
      ),
    allowedAlgs: z
      .array(z.enum(OIDC_ALLOWED_ALGS))
      .min(1)
      .default(["RS256", "ES256", "EdDSA"])
      .describe(
        "Signature algorithms accepted, asymmetric only: HS256/384/512 and `none` are not valid values. Taken from this list, never from the token header alone.",
      ),
    clockToleranceSeconds: z
      .number()
      .int()
      .min(0)
      .max(300)
      .default(30)
      .describe(
        "Clock skew tolerated when checking `exp`, `nbf` and `iat`, in seconds. Default 30, maximum 300.",
      ),
    discoveryCacheSeconds: z
      .number()
      .int()
      .min(60)
      .max(86400)
      .default(3600)
      .describe(
        "How long the discovery document is trusted before it is fetched again, in seconds (60 to 86400, default 3600). A refresh that fails or returns a different issuer refuses tokens rather than serving a stale document.",
      ),
    requireAtJwtType: z
      .boolean()
      .default(false)
      .describe(
        "Require the JOSE `typ` header to be `at+jwt` (RFC 9068), rejecting `JWT` and a missing `typ`. Default false, because several IdPs emit pre-RFC-9068 access tokens (Entra and Keycloak send `JWT`); with it off, `at+jwt`, `JWT`, `Bearer` and an absent `typ` are accepted and every other header `typ` (for example `id_token+jwt`) is refused. Independently of this flag, a token that names itself a non-access token is refused: a payload `typ` other than `Bearer`/`Access` (Keycloak ID and Refresh tokens), a `nonce`, `at_hash` or `c_hash` claim (ID-token markers), or a `token_use` other than `access` (Cognito). Turn the flag on when your IdP issues RFC 9068 tokens.",
      ),
    claimMapping: z
      .strictObject({
        subject: ClaimPathSchema.default("sub").describe(
          "Claim naming the caller. Required on every token.",
        ),
        scopes: ClaimPathSchema.default("scope").describe(
          "Claim holding the granted scopes: a space-delimited string (`scope`, `scp`) or an array of strings (`permissions`, `realm_access.roles`). Only this claim grants scopes, and only FULLY-QUALIFIED values (`read:notes`, `write:*`) are taken from it: a bare value such as the role `admin` is dropped (and logged once) unless `scopeMap` maps it, because obsidian-tc reads a bare family name as a wildcard over every resource.",
        ),
        scopeMap: z
          .record(
            z.string().min(1),
            z
              .array(
                z.string().refine(isQualifiedScope, {
                  message:
                    "must be a fully-qualified scope: a family (read, write, delete, execute, admin, bulk), a colon, a resource (for example `read:notes`)",
                }),
              )
              .min(1),
          )
          .optional()
          .describe(
            'Optional. Maps a value of the scopes claim (an IdP role or group name) to the obsidian-tc scopes it grants, e.g. `{ vault_admin: ["admin:auth"], reader: ["read:notes", "read:search"] }`. A mapped value grants exactly its list; an unmapped, non-qualified value grants nothing.',
          ),
        principal: ClaimPathSchema.optional().describe(
          "Optional claim used as the caller label in audit and logs instead of the subject (for example `email`). It does not affect authentication.",
        ),
        vault: ClaimPathSchema.optional().describe(
          "Optional claim binding the caller to one vault, as the `vault` claim does in jwt mode. Requires `allowedVaults`: a value outside it refuses the token. Unset: no vault claim is read.",
        ),
        allowedVaults: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Vault ids the `vault` claim may name. Required when `vault` is set; a token naming any other vault (or a non-string) is refused, not ignored.",
          ),
        persona: ClaimPathSchema.optional().describe(
          "Optional claim naming a configured persona, as the `persona` claim does in jwt mode (the persona's scopes replace the token's). Requires `allowedPersonas`. Unset: no persona claim is read.",
        ),
        allowedPersonas: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Persona names the `persona` claim may name. Required when `persona` is set; a token naming any other persona (or a non-string) is refused, not ignored.",
          ),
      })
      .superRefine((m, ctx) => {
        // A persona or vault claim is a bearer capability (a persona REPLACES the token's scopes; a
        // vault claim picks the vault): reading one without an operator-written allowlist would let
        // the IdP's claim, not the operator, decide what exists.
        if (
          m.persona !== undefined &&
          (m.allowedPersonas === undefined || m.allowedPersonas.length === 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["allowedPersonas"],
            message:
              "claimMapping.persona is set: list the persona names it may carry in claimMapping.allowedPersonas",
          });
        }
        if (
          m.vault !== undefined &&
          (m.allowedVaults === undefined || m.allowedVaults.length === 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["allowedVaults"],
            message:
              "claimMapping.vault is set: list the vault ids it may carry in claimMapping.allowedVaults",
          });
        }
      })
      .default({ subject: "sub", scopes: "scope" })
      .describe(
        'Where the identity comes from. A string value is a claim name or a dotted path into NESTED claims (`realm_access.roles`); a claim whose own name contains dots (a namespaced URL) is written as an array of literal segments, `["https://app.example.com/roles"]`.',
      ),
    requiredClaims: z
      .union([
        z.array(ClaimPathSchema),
        z
          .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]))
          .refine((r) => Object.keys(r).length > 0, { message: "must name at least one claim" }),
      ])
      .optional()
      .describe(
        'Extra claims a token must carry. An array of claim names requires a truthy, non-empty value (`null`, `false`, `0`, `""`, `[]` and `{}` fail, so `email_verified: false` does not satisfy `["email_verified"]`). An object maps a claim to the exact value it must have (`{ email_verified: true, hd: "example.com" }`; an array claim satisfies it when it contains the value). `exp`, `iat`, `iss`, `aud` and the subject claim are always required.',
      ),
  })
  .describe(
    "OpenID Connect provider whose access tokens this server verifies (`auth.mode: oidc`). Discovery is fetched at boot; the server refuses to start if it fails.",
  );

export const AuthConfigSchema = z.object({
  mode: z
    .enum(["none", "jwt", "oidc"])
    .default("none")
    .describe(
      "Authentication mode. `none` grants every request full wildcard scopes and is refused on a non-loopback HTTP bind; `jwt` needs a signing key: a jwtSecret, a JWKS, or a key in the auth registry (`obsidian-tc auth rotate-key`). A `jwt` server with none of them refuses to start. `oidc` verifies access tokens from an external OpenID Connect provider configured in `auth.oidc`; discovery runs at boot and a failure refuses to start.",
    ),
  oidc: OidcConfigSchema.optional().describe(
    "Required when `mode` is `oidc`, and refused under any other mode. Replaces jwtSecret/jwks*/issuer/audience/algorithms for verification.",
  ),
  jwtSecret: z
    .string()
    .min(32)
    .optional()
    .describe(
      "Shared secret for HS256 verification, minimum 32 characters. Secret. HS256 tokens verify ONLY against this (or an HS256 key in the auth registry), never against the JWKS. It is the initial signing key (kid `config`); once `auth rotate-key` has retired that key it is no longer used to verify or mint, and can be removed (`obsidian-tc doctor` says when).",
    ),
  tokenTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(86400)
    .describe(
      "Maximum accepted token AGE in seconds, measured from the token's `iat`. This caps age INDEPENDENTLY of `exp`: a token with a one-year expiry is still rejected once it is older than this, so a long-lived credential needs this raised to match.",
    ),
  // Rotation grace window: how long `auth rotate-key` keeps the PREVIOUS key verifying when
  // `--grace` is not given. 0 (default) preserves the immediate retirement that existed before
  // this key did. Capped at 7 days (604800; mirrored as MAX_ROTATION_GRACE_SECONDS in
  // server/src/auth/signing-keys.ts): a retiring key still verifies everything it ever signed, so
  // a longer window is a key that is never really rotated.
  rotationGraceSeconds: z
    .number()
    .int()
    .min(0)
    .max(604800)
    .default(0)
    .describe(
      "Seconds the previous signing key keeps verifying after `obsidian-tc auth rotate-key`, used when `--grace` is not passed (an explicit `--grace` always wins, including `--grace 0`). 0, the default, retires the previous key immediately. Maximum 604800 (7 days). A retiring key stops verifying at its `retire_after` whether or not anything has rewritten its state, so the window is exact; `obsidian-tc doctor` lists each retiring key with its time remaining.",
    ),
  requireJti: z
    .boolean()
    .default(false)
    .describe(
      'Reject any bearer token that carries no `jti` claim, on every verify path (HS256, JWKS, `/metrics`). A jti-less token cannot be revoked individually — only rotating its signing key kills it. Default false for compatibility with tokens minted before the registry, but `securityProfile: "hardened"` sets it true (an explicit value still wins); the default itself is planned to flip to true at the next major release. `obsidian-tc doctor` recommends true once `auth rotate-key` or `token mint` has initialised the registry (`token mint` always sets a jti).',
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
      "URL of an authorization server's JWKS (its `jwks_uri`), fetched and cached for asymmetric verification. Opt-in: it adds a network dependency to token verification, which jwks/jwksFile do not. Use it when an external AS rotates keys. The host is resolved once and the connection is pinned to the validated address (SNI and certificate on the hostname); redirects are refused and the body is capped. Default: `https://` on a public host. A loopback host needs no entry; a host listed in `network.plainHttpHosts` may be `http://` or on a private/tailnet address (the provider rules); link-local and cloud metadata addresses are refused even when listed. An unlisted host that resolves only to private addresses still works for one release with a deprecation (startup, doctor, server_health).",
    ),
  algorithms: z
    .array(z.string())
    .optional()
    .describe(
      'Explicit allowlist of accepted JWT algorithms, applied to every verify path: HS256 (the configured secret and registry keys), registry asymmetric keys, the JWKS and `/metrics`. Leaving HS256 out refuses HS256 tokens everywhere (`["EdDSA"]` is asymmetric-only). Absent, HS256 plus RS256/ES256/EdDSA are accepted. Algorithm confusion is structurally impossible regardless: HS256 verifies only against jwtSecret (or an HS256 registry key) and asymmetric algorithms only against the JWKS. Not used under `mode: oidc`, which has its own `oidc.allowedAlgs`.',
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
  allowMissingAudience: z
    .boolean()
    .optional()
    .describe(
      "DEPRECATION OPT-OUT. A JWKS key source (jwks, jwksFile, jwksUri) with no EFFECTIVE audience accepts a token its issuer minted for another service. `audience` is effective; `resource` is used as the audience only when Protected Resource Metadata is complete (`authorizationServers` set too), so a `resource`-only config passes validation and binds nothing. That keeps working for one release with a warning at startup, in `obsidian-tc doctor` and in server_health, and becomes a startup error in the next minor release. Set `true` only if you really mean to accept tokens regardless of `aud`; the warning then stops. It does NOT waive the rule above: a JWKS still needs `audience` or `resource` at config load.",
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
  anonymousDiscovery: z
    .enum(["none", "list"])
    .optional()
    .describe(
      'What an anonymous caller may do when OAuth is on. `none` (the default when unset) answers 401 with the WWW-Authenticate challenge to every request that carries no valid token, `initialize` and `tools/list` included: this is what makes grok.com and Claude start their OAuth flow. `list` is the ChatGPT mixed-auth mode: an anonymous `initialize`, `ping`, `server/discover` and `tools/list` are answered (the list is what a caller holding the default OAuth scopes sees, each tool carrying `securitySchemes`), and an anonymous `tools/call` returns a tool error whose `_meta["mcp/www_authenticate"]` holds the challenge that triggers ChatGPT\'s account-linking UI. Every other method, and any request with an invalid or expired token, still gets the 401. Do NOT use `list` for grok.com: it never starts OAuth when `tools/list` succeeds anonymously. Needs `auth.mode` `jwt` or `oidc` and `auth.resource`.',
    ),
  as: AsConfigSchema.optional().describe(
    "The bundled authorization server (opt-in; see `auth.as.enabled`). Absent means disabled. Needs `mode: jwt`; with it enabled, `authorizationServers` defaults to the issuer, and when set must list the issuer first.",
  ),
});
export const AclRuleSchema = z.object({
  glob: aclPathGlob()
    .min(1)
    .describe(
      "Glob matched against the vault-relative note path. Written with forward slashes; a backslash is read as a separator, so `notes\\private\\**` is `notes/private/**` (a vault path can never contain a backslash). Must be vault-relative: a leading separator, a drive letter (`C:`), a UNC prefix, a leading `./` or a trailing separator is refused at load, because such a rule can never match a note and its scopes would be silently bypassed.",
    ),
  scopes: z
    .array(z.string())
    .default([])
    .describe(
      "Scopes REQUIRED to operate on paths matching this rule (P1.4): a caller must hold every listed scope, in addition to the tool's own required scopes, to read/write/delete a matching path. The LAST matching rule wins, replacing rather than merging the scopes of earlier matches. An empty list adds no requirement. Enforced at dispatch on tool operations, and applied to results too: a search, listing or graph result for a path whose scopes the caller lacks is dropped, exactly as a path outside readPaths is.",
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
    .array(aclPathGlob())
    .optional()
    .describe(
      "Glob whitelist for reads: a path must match at least one entry. Omitted leaves reads unrestricted (see strictReadDefault). Write separators as `/`: a backslash is read as a separator (`notes\\**` is `notes/**`), since a vault path can never contain one, and repeated separators collapse. Entries must be vault-relative: a leading separator, drive letter, UNC prefix, leading `./` or trailing separator is refused at load.",
    ),
  writePaths: z
    .array(aclPathGlob())
    .optional()
    .describe(
      "Glob whitelist for writes: a path must match at least one entry. Omitted leaves writes unrestricted. Write separators as `/`: a backslash is read as a separator (`notes\\**` is `notes/**`), since a vault path can never contain one, and repeated separators collapse. Entries must be vault-relative: a leading separator, drive letter, UNC prefix, leading `./` or trailing separator is refused at load.",
    ),
  deletePaths: z
    .array(aclPathGlob())
    .optional()
    .describe(
      "Glob whitelist for deletes: a path must match at least one entry. Omitted leaves deletes unrestricted. Write separators as `/`: a backslash is read as a separator (`notes\\**` is `notes/**`), since a vault path can never contain one, and repeated separators collapse. Entries must be vault-relative: a leading separator, drive letter, UNC prefix, leading `./` or trailing separator is refused at load.",
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
