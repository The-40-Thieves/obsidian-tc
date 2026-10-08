// `auth.as`: the bundled OAuth 2.1 authorization server (design v2 section 5). Leaf schema plus the
// cross-field checks that read only `auth` (mode, resource, tokenTtlSeconds, algorithms,
// authorizationServers, jwksUri). server.schema.ts calls `refineAuthAs` from its superRefine: the
// check cannot live on AuthConfigSchema itself, because wrapping that object in an effect would hide
// its `.shape` from the JSON Schema generator.
//
// Imports Zod and the leaf host helpers only; it must never import server.schema.ts or config.schema.ts.
import { z } from "zod";
import { isLoopbackHost } from "../net-host";

/** The least an access token may live (RFC 9068 tokens this short would force a refresh storm). */
export const AS_ACCESS_TOKEN_SECONDS_MIN = 300;
export const AS_ACCESS_TOKEN_SECONDS_MAX = 3600;
export const AS_DEFAULT_ACCESS_TOKEN_SECONDS = 1800;
export const AS_SIGNING_ALGS = ["ES256", "EdDSA"] as const;
export const AS_DEFAULT_SETUP_TOKEN_ENV = "OBSIDIAN_TC_AS_SETUP_TOKEN";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A bare lowercase DNS hostname: no scheme, port, path or trailing dot. Shared with `auth.oidc`. */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** Schemes a redirect URI may never use, whatever the operator writes: they run code or leave the
 *  browser's origin model. Every other non-http(s) scheme is a private-use scheme (RFC 8252 7.1). */
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "ftp:",
  "ws:",
  "wss:",
]);

/** An issuer is an origin and nothing else: https (http only for a loopback host), no path, query,
 *  fragment or credentials, and written exactly as `URL.origin` spells it. The last condition is
 *  what makes the string byte-identical in metadata, PRM and every `iss` claim and parameter (RFC
 *  9207 clients compare it byte for byte), instead of "equal after normalisation". */
export function isCanonicalIssuerOrigin(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    return false;
  }
  return u.username === "" && u.password === "" && u.origin === v;
}

/** A static client's redirect URI: https; http only to a loopback host; or a private-use scheme.
 *  Never a fragment (RFC 6749 3.1.2), credentials, or a scheme that executes content. */
export function isAcceptableRedirectUri(v: string): boolean {
  if (v.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return isLoopbackHost(u.hostname);
  return !FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol);
}

/** Does `jwksUri` name this server's own published JWKS (`<issuer>/.well-known/jwks.json`)? Compared
 *  on the WHATWG-normalised origin (case, default port, trailing dot of the host) and the decoded
 *  path, ignoring a query or fragment, so no spelling of the same endpoint slips past the check. */
export function isOwnJwksUri(jwksUri: string, issuer: string): boolean {
  let u: URL;
  let i: URL;
  try {
    u = new URL(jwksUri);
    i = new URL(issuer);
  } catch {
    return false;
  }
  const origin = (x: URL) =>
    `${x.protocol}//${x.hostname.replace(/\.$/, "")}${x.port ? `:${x.port}` : ""}`;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  return origin(u) === origin(i) && path === "/.well-known/jwks.json";
}

/** A `client_id` that is an `https://` URL with a path names a Client ID Metadata Document. */
const isMetadataDocumentClientId = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.pathname !== "/";
  } catch {
    return false;
  }
};

const StaticClientSchema = z
  .strictObject({
    clientId: z
      .string()
      .min(1)
      .refine((v) => !isMetadataDocumentClientId(v), {
        message:
          "must not be an https URL with a path: such identifiers are Client ID Metadata Documents, resolved by URL, never looked up in this list",
      })
      .describe(
        "Stable identifier the client presents as `client_id`. Any string that is not an `https://` URL with a path (such strings are Client ID Metadata Document identifiers and are resolved by URL).",
      ),
    name: z.string().min(1).describe("Human-readable name shown on the consent page."),
    redirectUris: z
      .array(
        z.string().refine(isAcceptableRedirectUri, {
          message:
            "must be an https URL, an http URL to a loopback host (127.0.0.1, [::1], localhost), or a private-use scheme URI, with no fragment or credentials",
        }),
      )
      .min(1)
      .describe(
        "Exact redirect URIs this client may use. Loopback http URIs (`127.0.0.1`, `[::1]`, `localhost`) match with the port ignored and the path exact; every other URI must match exactly.",
      ),
    secretEnv: z
      .string()
      .regex(ENV_NAME_RE, "must be an environment variable NAME (letters, digits, underscore)")
      .optional()
      .describe(
        "Optional. Name of the environment variable holding this client's secret, which makes it a confidential client authenticating with `client_secret_basic`. The secret itself is never written in the config file; static clients are the only confidential ones.",
      ),
  })
  .describe("A pre-registered client of the bundled authorization server.");

export const AsConfigSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Opt-in. Serves RFC 8414 authorization-server metadata and generates the server's own access-token signing key at boot. Requires `auth.mode: jwt`, `auth.resource` and `issuer`; refused under `none` and `oidc`. With false (the default) nothing about the bearer paths changes.",
      ),
    issuer: z
      .string()
      .refine(isCanonicalIssuerOrigin, {
        message:
          "must be an https origin with no path, trailing slash, query, fragment, credentials or default port (http is allowed only for a loopback host), written in lower case",
      })
      .optional()
      .describe(
        "The authorization server's issuer identifier, an origin such as `https://vault.example.com`. Required when `enabled`. Derived from here and never from the request's Host header; the same string appears byte for byte in the metadata, in Protected Resource Metadata and in every token's `iss`.",
      ),
    signingAlg: z
      .enum(AS_SIGNING_ALGS)
      .default("ES256")
      .describe(
        "Algorithm of the key that signs access tokens, `ES256` or `EdDSA`. The key is generated at first boot with this enabled and kept in the auth registry under its own purpose, so rotating it never retires a hand-minted token's key. When `auth.algorithms` is set it must include this value.",
      ),
    accessTokenSeconds: z
      .number()
      .int()
      .min(AS_ACCESS_TOKEN_SECONDS_MIN)
      .max(AS_ACCESS_TOKEN_SECONDS_MAX)
      .default(AS_DEFAULT_ACCESS_TOKEN_SECONDS)
      .describe(
        "Lifetime of an issued access token in seconds (300 to 3600, default 1800). `auth.tokenTtlSeconds` must be at least this, or the age cap would reject tokens before they expire.",
      ),
    refreshTokenDays: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe(
        "Absolute lifetime of a refresh-token family in days (1 to 90, default 30), counted from the code exchange that started the family; rotation never extends it. Refresh tokens rotate on every use.",
      ),
    dynamicRegistration: z
      .boolean()
      .default(false)
      .describe(
        "Default false. Serves RFC 7591 Dynamic Client Registration at `/oauth/register` and advertises `registration_endpoint`. DCR is deprecated by the MCP authorization spec and opens an unauthenticated client-creation surface (rate-limited and row-capped by `dcr`); claude.ai, Claude Code, ChatGPT and Codex use Client ID Metadata Documents and do not need it. A boot notice is logged whenever it is on.",
      ),
    dcr: z
      .strictObject({
        maxClients: z
          .number()
          .int()
          .min(1)
          .default(1000)
          .describe("Most dynamically registered clients kept at once (default 1000)."),
        perIpPerHour: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Registrations accepted per source address per hour (default 10)."),
        unusedDays: z
          .number()
          .int()
          .min(1)
          .default(90)
          .describe(
            "A dynamically registered client unused for this many days is deleted (default 90).",
          ),
      })
      .prefault({})
      .describe("Limits applied when `dynamicRegistration` is on. Ignored while it is off."),
    cimd: z
      .strictObject({
        allowedHosts: z
          .array(
            z
              .string()
              .regex(HOSTNAME_RE, "must be a bare lowercase hostname (no scheme, port or path)"),
          )
          .default([])
          .describe(
            "Hostnames a Client ID Metadata Document URL may be hosted on. Empty (the default) admits any public https host; set it to restrict which clients can ask the operator for consent.",
          ),
      })
      .prefault({})
      .describe("Client ID Metadata Document registration, the default way clients register."),
    setupTokenEnv: z
      .string()
      .regex(ENV_NAME_RE, "must be an environment variable NAME (letters, digits, underscore)")
      .default(AS_DEFAULT_SETUP_TOKEN_ENV)
      .describe(
        "Name of the environment variable whose value is the one-time setup token that claims the operator account on a host with no terminal (default `OBSIDIAN_TC_AS_SETUP_TOKEN`). The token is never read from the config file.",
      ),
    login: z
      .strictObject({
        maxFailuresPerWindow: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(5)
          .describe("Wrong passwords tolerated per account within the window (default 5)."),
        windowSeconds: z
          .number()
          .int()
          .min(60)
          .max(86400)
          .default(900)
          .describe("Length of the failure window in seconds (default 900)."),
      })
      .prefault({})
      .describe("Operator login brute-force limits."),
    clients: z
      .array(StaticClientSchema)
      .default([])
      .describe(
        "Pre-registered clients. They are the only confidential clients (`secretEnv`); every other client registers by metadata document or, when enabled, dynamically.",
      ),
  })
  .describe(
    "The bundled OAuth 2.1 authorization server. Opt-in, in-process, on the same port as `/mcp`; it signs RFC 9068 access tokens with its own registry key and the verifier checks them without a network hop.",
  );

type AuthShape = {
  mode: "none" | "jwt" | "oidc";
  resource?: string | undefined;
  tokenTtlSeconds: number;
  algorithms?: string[] | undefined;
  authorizationServers?: string[] | undefined;
  jwksUri?: string | undefined;
  as?: z.infer<typeof AsConfigSchema> | undefined;
};

/** The cross-checks an ENABLED authorization server needs of the rest of `auth` (design 4.1, 4.3,
 *  4.4). Each reads only `auth`, never another config domain. */
export function refineAuthAs(auth: AuthShape, ctx: z.RefinementCtx): void {
  const as = auth.as;
  if (as === undefined || !as.enabled) return;
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path: ["auth", ...path], message });

  if (auth.mode !== "jwt") {
    fail(
      ["as", "enabled"],
      auth.mode === "oidc"
        ? "auth.as.enabled requires auth.mode 'jwt': under 'oidc' an external identity provider is already the issuer. Set auth.as.enabled to false, or switch auth.mode to 'jwt'."
        : "auth.as.enabled requires auth.mode 'jwt': under 'none' there is nothing to protect, so an authorization server would issue tokens nothing checks. Set auth.mode to 'jwt' or auth.as.enabled to false.",
    );
  }
  if (as.issuer === undefined) {
    fail(
      ["as", "issuer"],
      "auth.as.enabled is true but auth.as.issuer is not set: give the public origin of this server, for example https://vault.example.com.",
    );
  }
  if (auth.resource === undefined) {
    fail(
      ["resource"],
      "auth.as.enabled is true but auth.resource is not set: access tokens are bound to the resource URL (their `aud`), so set auth.resource to this server's public /mcp URL.",
    );
  }
  if (auth.tokenTtlSeconds < as.accessTokenSeconds) {
    fail(
      ["tokenTtlSeconds"],
      `auth.tokenTtlSeconds (${auth.tokenTtlSeconds}) is below auth.as.accessTokenSeconds (${as.accessTokenSeconds}): the token age cap would reject access tokens before they expire. Raise auth.tokenTtlSeconds to at least ${as.accessTokenSeconds}.`,
    );
  }
  if (auth.algorithms !== undefined && !auth.algorithms.includes(as.signingAlg)) {
    fail(
      ["algorithms"],
      `auth.algorithms does not include ${as.signingAlg}, the algorithm auth.as.signingAlg signs access tokens with, so every token the server issues would be refused. Add ${as.signingAlg} to auth.algorithms.`,
    );
  }
  if (
    auth.authorizationServers !== undefined &&
    as.issuer !== undefined &&
    auth.authorizationServers[0] !== as.issuer
  ) {
    fail(
      ["authorizationServers"],
      `auth.authorizationServers must list auth.as.issuer (${as.issuer}) FIRST, byte for byte: Claude reads only the first entry, and a different first entry sends clients to another server. Put the issuer first, or omit auth.authorizationServers (it defaults to the issuer).`,
    );
  }
  if (
    auth.jwksUri !== undefined &&
    as.issuer !== undefined &&
    isOwnJwksUri(auth.jwksUri, as.issuer)
  ) {
    fail(
      ["jwksUri"],
      `auth.jwksUri names this server's own JWKS (${as.issuer}/.well-known/jwks.json): remove it. Access tokens signed by the authorization server are verified in process, and pointing the verifier at itself would add a network path whose failure rejects every token.`,
    );
  }
  const seen = new Set<string>();
  as.clients.forEach((c, i) => {
    if (seen.has(c.clientId)) {
      fail(["as", "clients", i, "clientId"], `duplicate auth.as.clients clientId "${c.clientId}"`);
    }
    seen.add(c.clientId);
  });
}
