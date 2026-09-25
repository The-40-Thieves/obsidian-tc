# THE-1111 — an authorization server for obsidian-tc (design, G1)

Status: **design for owner review, not built.** Written 2026-09-24 against `main` `101c91c6`
(v1.31.3 + three unreleased changes). Supersedes the 2026-07-29 "pre-registration only" decision on
THE-661, whose two re-check triggers (a third-party client with no prior relationship; multi-user
access) were both met by owner direction on 2026-09-24. Parent epic: THE-1110. Siblings that depend
on this note: THE-1113 (browser clients), THE-1112 (vendor onboarding), THE-1114 (hosted deploy),
THE-1116 (era sunset), THE-1115 (per-device attribution).

Research digest with sources: `scratchpad/the1111-oauth-research.md` (2026-09-24; the load-bearing
facts are repeated here with their citations so this note stands alone).

## 0. The one-paragraph version

obsidian-tc already has the resource-server half of OAuth: signed-JWT verification (HS256 or a
JWKS, `jwksUri` with `kid` rotation), audience binding enforced, a `WWW-Authenticate` challenge with
scope, and an RFC 9728 protected-resource-metadata builder that serves only when an authorization
server is configured. It has no authorization server, so no client without a prior relationship can
obtain a token: not claude.ai or ChatGPT connectors, not `codex mcp login`, not Gemini CLI,
Antigravity, Grok Build, Cursor, not a browser. This note designs an **optional, bundled
authorization server** (`auth.as`) that issues asymmetric JWTs the existing verifier already accepts,
registers clients by **Client ID Metadata Document** by default and by **dynamic registration behind a
flag**, authenticates a **single operator with a passkey**, and keeps its state in its own
`auth.db`. Bring-your-own external servers stay supported through the two config keys that exist
today. The bundled server is what makes "someone else deploys this on Railway and logs in once" real;
the external path is for operators who already run Keycloak, Auth0, Zitadel or Cloudflare Access.

## 1. Where we are (measured 2026-09-24)

| piece | state | where |
| --- | --- | --- |
| Bearer verification | HS256 secret, inline JWKS, JWKS file, or remote `jwksUri` (cached, `kid` rotation); alg-routed so an asymmetric key can never be used as an HMAC secret; allowlist `RS256/ES256/EdDSA` | `auth/verifier.ts`, `auth/jwt.ts` |
| Audience + issuer binding | enforced (THE-456), verified live | `auth/jwt.ts` |
| Age cap | `auth.tokenTtlSeconds` caps token age from `iat` regardless of `exp` (THE-520's "exp still in the future" trap) | `auth/jwt.ts` |
| PRM (RFC 9728) | builder exists; served at `/.well-known/oauth-protected-resource` and `…/mcp` only when `auth.resource` AND `auth.authorizationServers` are set | `auth/protected-resource.ts`, `transports/http.ts:416` |
| Personas | named bundles `{vaults, scopes, toolVisibility?}` a token's `persona` claim resolves to; unknown persona → refused, never degraded | `auth/persona.ts`, `config/personas.schema.ts` |
| Scopes | families `read/write/delete/execute/admin/bulk`, `verb:noun` vocabulary, HITL floor scopes | `shared/src/scopes.ts` |
| Authorization server | **none**; tokens minted by hand (`obsidian-tc token mint`), 1-year TTL on Cave | `cli/commands/token-mint.ts` |
| SDK help | `@modelcontextprotocol/server` 2.0.0 / 2.1.0 ship resource-side helpers only (`requireBearerAuth`, `verifyBearerToken`, `oauthMetadataResponse`, `buildOAuthProtectedResourceMetadata`, `bearerAuthChallengeResponse`, `validateOriginHeader`); no provider | installed package, type files |
| HTTP framework | Hono 4.12, `createMcpHandler`; `jose` 6.2.3; `zod` 4.4; `bun:sqlite` via `openBunSqlite` | `packages/server/package.json` |
| Deployment on Cave | HTTP behind the LiteLLM gateway on the tailnet; the gateway is a 2025-era MCP client (python `mcp` 1.28.1) and cannot move (litellm#35306) | THE-1116 |

## 2. What the standards and the real clients require

Spec: MCP authorization 2026-07-28 (fetched 2026-09-24), built on OAuth 2.1 draft -13 (latest -15),
RFC 6750, 8414, 7591, 8707, 9728, **9207**, and draft-ietf-oauth-client-id-metadata-document (MCP
cites -00; the current draft is **-02**, 2026-07-06).

Resource server (obsidian-tc): MUST serve PRM with ≥1 `authorization_servers`; MUST validate
audience per RFC 8707; 401 SHOULD carry `scope`; insufficient scope → 403 with every needed scope in
one challenge; MUST NOT accept passthrough tokens; SHOULD NOT advertise `offline_access` in PRM.

Authorization server: MUST implement OAuth 2.1 for public and confidential clients; MUST provide
RFC 8414 or OIDC discovery; clients MUST refuse an AS whose metadata lacks
`code_challenge_methods_supported` (S256 only); **CIMD is SHOULD, DCR is MAY and deprecated**
(PR #2858); SHOULD return `iss` on every authorization response (RFC 9207, SEP-2468, expected to
become MUST); all endpoints HTTPS; redirect URIs exact-match, `localhost` or HTTPS; public clients
MUST get rotated refresh tokens; clients MUST send `resource` on both authorize and token requests.

2026-07-28 removed sessions and `initialize`, so **every POST authenticates on its own** and any
cross-call state is keyed by the token `sub`. URL-mode elicitation **MUST NOT** be used to log a user
into the MCP server itself, so the login is a real authorization-code flow, not an elicitation.

What the clients actually do (measured or first-party docs; "inferred" = binary strings):

| client | CIMD | DCR | pre-registered | redirect | notes |
| --- | --- | --- | --- | --- | --- |
| claude.ai (web, desktop, mobile) | yes, **only if** AS metadata has `client_id_metadata_document_supported: true` AND `"none"` in `token_endpoint_auth_methods_supported` | fallback; registers **on every fresh connection** | custom-connector fields | `https://claude.ai/api/mcp/auth_callback` (+ `claude.com`) | uses only the FIRST `authorization_servers` entry; PRM `resource` must equal the typed URL exactly; refresh failures must be `invalid_grant`; 10 s discovery/token, 30 s refresh |
| Claude Code | yes | yes | yes | `http://localhost:<eph>/…` and `127.0.0.1` | port-agnostic matching needed for **`localhost` too** |
| ChatGPT connectors | yes (stable client only with RFC 9207 `iss` + identical issuer everywhere) | yes, once per server | yes | `https://chatgpt.com/connector_platform_oauth_redirect` | its CIMD document declares `private_key_jwt`; fallback to `none` unverified |
| Codex CLI 0.156.1 | yes (merged 2026-08-12), loopback only | yes | `--oauth-client-id` | loopback, fixed via `mcp_oauth_callback_port` | `--oauth-client-registration auto\|cimd\|dcr` |
| Gemini CLI | unverified | yes | yes | random loopback port | |
| Antigravity 1.2.10 | inferred yes | yes | yes | `http://localhost:<port>/auth/callback` (inferred) | community reports of a post-login request without the bearer |
| Grok Build 1.0.41 | inferred **no** | inferred yes | `oauth_client_id` | `http://127.0.0.1/callback` (inferred) | |
| Cursor | no | yes, sends a `cursor://` private-use redirect that strict servers reject | yes | `cursor://…` + loopback | accept-or-drop private-use schemes, never fail the whole registration |

**Consequence:** CIMD + `none` + RFC 9207 `iss` covers Claude, ChatGPT and Codex without growing a
client table. DCR is still required for Cursor, Gemini CLI and Grok Build. Both ship; DCR behind a
flag with a boot notice.

## 3. Decisions (owner picks; recommendation marked)

- **D1 Shape.** Bundled opt-in module in the same process (**recommended**), with bring-your-own
  external AS supported unchanged through `auth.authorizationServers` + `auth.jwksUri`. Rationale:
  no embeddable Bun-native AS supports CIMD (oidc-provider 9.12 has it behind an experimental flag
  and needs Koa plus a Node bridge; Cloudflare's `workers-oauth-provider` 1.1 is the best reference
  design but is bound to Workers KV; Keycloak 26.6 experimental; Hydra and Zitadel none); external-only
  kills the one-click hosted story (a second stateful service with its own database). The bundled
  server is a port of the `workers-oauth-provider` design onto Hono + jose + `bun:sqlite`.
- **D2 Token format.** RFC 9068 JWT access tokens (`typ: at+jwt`, `iss`, `sub`, `aud` = canonical
  resource, `client_id`, `scope`, `persona?`, `iat`, `exp`, `jti`), signed **ES256** (widest verifier
  compatibility; `EdDSA` also fine; **never** `alg: Ed25519`, which the current allowlist rejects).
  One verifier path serves both modes. `exp - iat` ≤ `auth.tokenTtlSeconds` or the age cap kills
  tokens early. Lifetime 15–60 min, default 30.
- **D3 Refresh tokens.** Rotated on every use (public clients MUST). Hybrid reuse policy: exactly one
  step back is accepted **until the successor is first used** (a client that lost the refresh
  response can retry; Claude allows 30 s and a Railway cold start can exceed that); any older token,
  or the previous one after its successor was used, revokes the whole family (RFC 9700 §4.14.2).
  Absolute cap 30 days. Failure → `invalid_grant`.
- **D4 Registration.** CIMD by default (fetch rules in §4); DCR behind `auth.as.dynamicRegistration`
  (default off) with a loud boot notice, per-IP rate limit, unused-client TTL 90 days renewed on use,
  a row cap, and private-use redirect schemes accepted-or-dropped rather than rejected (Cursor);
  pre-registered clients in config for fixed consumers such as LiteLLM.
- **D5 Identity.** Single operator, one `owner` row with a random stable `sub`. **Passkey** primary
  (`@simplewebauthn/server` 14.0.2, runs under Bun), password fallback (Argon2id via
  `Bun.password`), recovery codes shown once. Multi-user is out of scope; personas give a client a
  scope-and-vault bundle at consent time, so "users" are personas until a real need appears.
- **D6 First boot without a TTY** (Railway, Fly, Coolify). Env-var bootstrap secret
  (`OBSIDIAN_TC_AS_SETUP_TOKEN`) required by `/setup`, burned after the first successful enrollment;
  a one-time setup URL in the logs is **opt-in only** (Cave ships logs to Loki). Until claimed the AS
  refuses every authorization request: the first-run race is otherwise fatal.
- **D7 Consent.** First grant to a new `(client_id, redirect_uri)` requires a fresh owner
  authentication and shows client host, redirect host, scopes, resource, and the persona being
  granted. Remembered consent per `(client_id, redirect_uri, scope ⊆ granted)`. No auto-approve.
- **D8 Storage.** A separate `auth.db` (own migration chain, WAL, `openBunSqlite`), per server not per
  vault, next to `cache.db`; picked up by the nightly backup with its `-wal` sidecar. Codes, refresh
  tokens and DCR secrets stored as SHA-256 only; CIMD documents are a cache, not clients.
- **D9 Scope surface.** PRM `scopes_supported` = the minimal read set; writes and admin via 403
  step-up with every needed scope in one challenge; `offline_access` advertised in AS metadata only.
  Scope hierarchy honoured (`write:notes` ⊇ `read:notes`) where the existing precedence defines it.
- **D10 DPoP.** Not now: absent from 2026-07-28, SEP-1932 open, no major client documents support.
  Leave the metadata field out; jose can verify proofs later.
- **D11 HITL codec.** With asymmetric tokens there is no `jwtSecret`; the `inputRequired` codec is
  keyed from a server-local random secret (as the stdio path already does since THE-1106), not from
  the signing key.

## 4. Design

### 4.1 Modes and config

```jsonc
"auth": {
  "mode": "jwt",
  "resource": "https://vault.example.com/mcp",          // canonical, = aud, = PRM resource, exact
  "authorizationServers": ["https://vault.example.com"], // bundled: the server's own issuer
  "jwksUri": "https://vault.example.com/.well-known/jwks.json",
  "tokenTtlSeconds": 3600,
  "as": {
    "enabled": true,
    "issuer": "https://vault.example.com",              // MUST equal PRM entry and every `iss`
    "accessTokenSeconds": 1800,
    "refreshTokenDays": 30,
    "dynamicRegistration": false,                       // DCR switch; boot notice when true
    "clientIdHostAllowlist": [],                         // optional CIMD trust policy
    "setupTokenEnv": "OBSIDIAN_TC_AS_SETUP_TOKEN",
    "clients": [ { "client_id": "litellm", "redirect_uris": [], "grant": "client_credentials?" } ] // see §9 Q3
  },
  "personas": { "default": { "vaults": ["main"], "scopes": ["read:notes", "write:notes"] } }
}
```

Bring-your-own: `as.enabled: false`, `authorizationServers` = the external issuer, `jwksUri` = its
keys. Nothing else changes; this is today's code path.

Issuer and every endpoint URL derive from **config, never from `Host` or `X-Forwarded-*`** (RFC 9700
§4.13; the PRM builder already does this). A TLS-terminating proxy (Railway edge, Cloudflare tunnel)
is the normal case.

### 4.2 Endpoint surface (bundled mode)

| route | purpose |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` (+ `openid-configuration` alias) | RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`, `revocation_endpoint`, optional `registration_endpoint`, `response_types_supported ["code"]`, `grant_types_supported ["authorization_code","refresh_token"]`, `code_challenge_methods_supported ["S256"]`, `token_endpoint_auth_methods_supported ["none"]` (+ `private_key_jwt` later), `client_id_metadata_document_supported true`, `authorization_response_iss_parameter_supported true`, `scopes_supported` (+ `offline_access`) |
| `GET /.well-known/jwks.json` | ≥2 keys published (current + previous/next); sign with current; retire after max access-token lifetime + skew |
| `GET /oauth/authorize` | validates client + redirect BEFORE anything else; on error renders locally, never redirects; stores the pending request server-side; sends the owner to login/consent |
| `POST /oauth/token` | `application/x-www-form-urlencoded`; grants `authorization_code` (PKCE verified, code single-use, bound to client, redirect, resource, scope) and `refresh_token` (rotation per D3) |
| `POST /oauth/register` | RFC 7591, only when `dynamicRegistration`; `application_type` recorded; rate-limited |
| `POST /oauth/revoke` | RFC 7009 |
| `GET/POST /auth/login`, `/auth/consent`, `/auth/setup`, `/auth/recover` | owner UI: passkey ceremony, consent, first-boot claim, recovery; `frame-ancestors 'none'`, `__Host-` SameSite cookie, per-form CSRF token bound to the pending request handle, 303 after POST |

PRM (`/.well-known/oauth-protected-resource[/mcp]`) lists `authorization_servers: [issuer]` with the
issuer string byte-identical to AS metadata and to every `iss` (ChatGPT's stable-client prerequisite;
Claude reads only the first entry).

### 4.3 Client registration

CIMD (`client_id` = HTTPS URL with a path): fetch HTTPS only, **no redirects**, ≤5 KB, ~10 s timeout,
resolve DNS and refuse RFC 6890 special-use ranges **re-checking after resolution** (DNS rebinding),
same rule for `logo_uri`/`jwks_uri` or do not fetch them; validate exact `client_id` equality and
JSON shape; redirect URIs exact-match with port-agnostic loopback for `127.0.0.1`, `[::1]` and
`localhost`; cache per HTTP headers within 5 min–24 h; never cache errors. Consent shows the
`client_id` host and redirect host and warns on loopback-only redirects. Optional operator allowlist
of `client_id` hosts.

DCR: as D4. Pre-registered: config rows; the only confidential clients.

### 4.4 Tokens, grants, keys

Access token per D2. A grant row is the consent `(client_id, redirect_uri, sub, scope, resource,
persona)`; codes and refresh-token families hang off it, so revoking a grant revokes everything.
Signing keys: ES256 pair generated at first boot, private half encrypted at rest with a key from the
setup token or a 0600 file, `kid` = RFC 7638 thumbprint, rotation is "generate next, publish both,
switch, retire".

### 4.5 Resource-server changes (small, in `transports/http.ts`)

1. PRM served whenever `as.enabled` (the builder needs nothing new).
2. 401 challenge carries `scope` = the minimal read set and `resource_metadata`.
3. 403 `insufficient_scope` with the full needed set (the scope model already has the precedence;
   the challenge just has to emit it).
4. Verifier: unchanged; `jwksUri` may point at the server's own `/.well-known/jwks.json` (in-process
   verification uses `createLocalJWKSet` from the key table to avoid a loopback HTTP fetch).
5. `token_max_age` interaction: document that `auth.tokenTtlSeconds` must be ≥ `accessTokenSeconds`;
   validate at config load.

### 4.6 Storage schema (sketch; every secret as SHA-256 hex)

`signing_key(kid, alg, public_jwk, private_jwk_enc, created_at, activated_at, retired_at)`,
`owner(id=1, sub, password_hash?, claimed_at, recovery_hashes)`,
`webauthn_credential(id, public_key, counter, transports, device_type, backed_up, rp_id, …)`,
`oauth_client(client_id, kind dcr|static, secret_hash?, metadata json, created_at, last_used_at,
expires_at, created_ip)`, `cimd_cache(client_id, document, fetched_at, expires_at)`,
`grant_(id, client_id, redirect_uri, sub, scope, resource, persona, created_at, revoked_at)`,
`auth_code(code_hash, grant_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at)`,
`refresh_token(token_hash, grant_id, family_id, parent_hash, issued_at, first_used_successor_at,
expires_at, revoked_at)`. Rate-limit counters in memory. Optional `jti` denylist only if pre-`exp`
revocation of JWT access tokens is wanted (30-minute tokens make this unnecessary at first).

### 4.7 Passkey constraints

`rpID` is the registrable domain the AS is served on; changing the public hostname (Railway default
domain → custom domain) orphans every passkey, so re-enrollment goes through the recovery path and
the docs say so before the first deploy.

## 5. Threat model (mapped; each row becomes a test)

| threat | mitigation | cite |
| --- | --- | --- |
| open redirect | exact-match registered `redirect_uris`; loopback port-agnostic only for `127.0.0.1`, `[::1]`, `localhost`; never redirect on error before client+redirect validated | RFC 9700 §4.1/§4.11, OAuth 2.1 §7.12.2 |
| PKCE downgrade | `code_challenge` + S256 required on every request; token endpoint rejects verifier-without-challenge and the reverse | RFC 9700 §2.1.1/§4.8 |
| code injection/replay | single-use codes (second use revokes the tokens issued from it), TTL ≤ 60 s, bound to client/redirect/resource/scope | RFC 9700 §4.5 |
| mix-up | `iss` on every response incl. errors; `authorization_response_iss_parameter_supported: true`; issuer identical in AS metadata, PRM and tokens | RFC 9207, RFC 9700 §4.4 |
| CIMD SSRF | HTTPS only, no redirects, special-use IP refusal after resolution, 5 KB cap, timeout, bounded cache, never cache errors | CIMD-02 §8.6–8.7 |
| localhost impersonation | show client host + redirect host; warn on loopback-only; optional host allowlist | CIMD-02 §8.5/§8.9 |
| DCR flooding | per-IP rate limit, unused-client TTL, row cap, operator switch | RFC 7591 §5 |
| consent phishing | fresh owner auth on first grant per client+redirect; full-context consent page; no auto-approve | RFC 9700 §4.18 |
| audience confusion | `aud` = canonical resource; RS enforces (THE-456); no passthrough | RFC 8707, RFC 9700 §4.10.2 |
| clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` on every AS page | RFC 9700 §4.16 |
| CSRF | `__Host-` SameSite cookie; per-form CSRF token bound to the pending-request handle | RFC 9700 §4.7 |
| refresh-token theft | rotation + family revocation on reuse; hashed at rest; absolute cap | RFC 9700 §2.2.2/§4.14 |
| secret storage | hashes only for codes/RTs/secrets; private keys encrypted; constant-time compares; never log `Authorization`, codes, RTs | OAuth 2.1 §7.1 |
| proxy `Host` spoofing | issuer/endpoints from config only | RFC 9700 §4.13 |
| POSTed credentials re-sent on redirect | 303 after login/consent POST | RFC 9700 §4.12 |

## 6. Testing

- Conformance: a test client per row of §2's matrix shape (CIMD+none, DCR native, DCR with a
  private-use scheme, pre-registered confidential), each completing authorize → consent → token →
  `list_vaults` over a real `startHttp`, then refresh with rotation, then reuse → family revoked.
- Each threat row in §5 as a red-then-green test (mutation on the mitigation must fail the test).
- CIMD fetcher against a local server that redirects, returns 6 KB, resolves to `127.0.0.1` after a
  public hostname, and serves a `client_id` mismatch.
- First-boot race: an unclaimed instance refuses `/oauth/authorize` and `/oauth/register`; the setup
  token is single-use; a second enrollment attempt fails.
- Passkey ceremony with `@simplewebauthn/server` in-memory; hostname change → credentials orphaned →
  recovery path re-enrolls.
- Interop with the existing suites: THE-456 audience gate, THE-520 max-age diagnosis, THE-1106 HITL
  round trip under an asymmetric token with the server-local codec secret.
- Cross-vendor review through the security lane before merge (auth surface).

## 7. Acceptance

- With `as.enabled: true` on a fresh install: valid AS metadata and PRM; Claude Code (`elicitation: {}`,
  CIMD), `codex mcp login` (CIMD), Gemini CLI or Grok Build (DCR flag on), and a claude.ai custom
  connector each complete a login and call `list_vaults`; a browser PKCE client completes the flow
  (THE-1113).
- With `as.enabled: false` and an external issuer: the same clients work; no bundled route is served.
- Tokens are audience-bound; a token for another resource is refused 401 (existing test extended).
- No placeholder ever in `authorizationServers` (THE-661 rule); PRM still 404s honestly when nothing
  is configured.
- `config show` and `doctor` never print the setup token, signing private key, or any hash.
- Docs: `security/auth-model.md` gains the bundled-mode section; a "Connect a client" page per client
  lands with THE-1112; SECURITY.md threat-model table gains the §5 rows.

## 8. Cost

Estimated from the Cloudflare reference design ported onto Hono + jose + `bun:sqlite`: authorization
+ token + refresh + metadata + JWKS ≈ M; CIMD fetcher with SSRF guard ≈ S; DCR + GC + rate limit ≈ S;
passkey login + setup + consent + recovery UI ≈ M; storage + migrations ≈ S; tests per §6 ≈ M. New
runtime dependency: `@simplewebauthn/server` (MIT, ~8 MB installed with its x509 deps). No new
service, no new database engine. One config block, one new file `auth.db`.

## 9. Open questions for the owner

1. **Bundled AS at all, or external-only?** (D1; recommendation: bundled + external.)
2. **Passkey-first or password-first** for the single operator? (D5; recommendation: passkey, password
   fallback.)
3. **Does LiteLLM keep a pre-registered confidential client, or does the gateway MCP hop go away
   first?** THE-1116 recorded "take MCP out of LiteLLM" as the direction; if so, the pre-registered
   client list may start empty and `client_credentials` is not needed.
4. **Multi-user later?** The `owner` table is `CHECK (id = 1)` on purpose; lifting it is a schema
   change plus a user-management UI. Personas cover the "different agents, different rights" need.
5. **Should the consent page be the place a client is bound to a persona** (the recommendation), or
   should personas stay a token-mint-time concept only?
6. **DCR default:** off (recommended) means Cursor, Gemini CLI and Grok Build users flip a flag and
   read a notice; on means the flooding surface is open by default on every hosted install.

## 10. Out of scope

Multi-user identity; OIDC identity provider features (`id_token`, `userinfo`) beyond the discovery
alias; DPoP; federated login to upstream providers (Google, GitHub) — a later `auth.as.upstream`
that would use URL-mode elicitation correctly, since there the server is the OAuth *client*; token
introspection for third parties; the per-device attribution stamp (THE-1115, which this note enables
by making every device its own `sub`).

## 11. Sequencing

1. Owner answers §9 → this note is stamped `G1-CONFIRMED` or revised.
2. Build ticket split from THE-1111 in three PRs: (a) metadata + JWKS + token/refresh + PRM wiring +
   config, behind `as.enabled`, no UI (tokens obtainable only via pre-registered clients; proves the
   verifier path); (b) CIMD + DCR + consent + passkey/setup UI; (c) docs + client recipes + advisory
   text. Security-lane review on each.
3. THE-1113 (browser) and the claude.ai/ChatGPT rows of THE-1112 unblock after (b).
4. THE-1116 Gate A (devices off the gateway MCP hop) becomes a config change after (b).
5. THE-1114 (Railway) picks up `OBSIDIAN_TC_AS_SETUP_TOKEN` as its first-run story.

## Sources

MCP authorization 2026-07-28 and its discovery, client-registration and security-considerations
pages (modelcontextprotocol.io/specification/2026-07-28); OAuth 2.1 draft-ietf-oauth-v2-1-15;
RFC 6750, 7591, 8414, 8707, 9068, 9207, 9700, 9728; draft-ietf-oauth-client-id-metadata-document-02;
Claude connector authentication docs (claude.com/docs/connectors/building/authentication); ChatGPT
Apps auth docs (developers.openai.com/plugins/build/auth); openai/codex PR #38089 and
`codex mcp login --help` (0.156.1); Gemini CLI MCP docs; Antigravity MCP docs; Cursor forum thread on
DCR private-use redirects; `workers-oauth-provider` 1.1.0; `oidc-provider` 9.12.2; Keycloak 26.6
release notes; `@simplewebauthn/server` 14.0.2; `jose` 6.2.3 measured under Bun 1.4.2; litellm#35306.
