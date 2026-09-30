---
title: Authentication
description: Transport trust model, signed-JWT bearer auth, scoped tokens, and optional OAuth resource-server discovery.
---

## Transport trust

- **stdio** is trusted-local. The operator runs the binary against their own vault,
  so stdio calls are authenticated with full local scope and need no token.
- **HTTP** is untrusted by default. When the HTTP transport is enabled you set
  `auth.mode: jwt`, and every request must carry a valid signed bearer token.

## Tokens

Clients authenticate with a signed JWT bearer token. Each token carries:

- the **vault** it may act on,
- a **scope** set (`family:resource`, e.g. `read:notes`, `write:notes`),
- an **expiry** (TTL).

Folder-path restrictions are applied separately by the folder ACL (glob allow/deny
on paths), not encoded in the scope string. The signing key lives outside the vault
and is never logged. Tokens are verified with a pinned algorithm — `alg: none` and
unsigned tokens are rejected — and checked for signature and expiry on every request.

## Asymmetric JWT verification (RS256 / ES256 / EdDSA)

Beyond the shared-secret HS256 path above, `auth.mode: jwt` can verify tokens signed
with an **asymmetric** key, so the server holds only a *public* key while the issuer
keeps the private key. Provide a JWKS in place of (or alongside) `jwtSecret`:

- **`auth.jwks`** — an inline JWKS document (`{ "keys": [ … ] }`).
- **`auth.jwksFile`** — a path to a JWKS document, loaded **once** at transport boot.
  File or inline only — there is no URL fetch, so no new network attack surface.
- **`auth.algorithms`** — an allowlist of asymmetric algorithms. Defaults to
  `["RS256", "ES256", "EdDSA"]` when omitted.

```json
{
  "auth": {
    "mode": "jwt",
    "jwksFile": "/etc/obsidian-tc/jwks.json",
    "algorithms": ["RS256", "EdDSA"]
  }
}
```

**Key rotation is `kid`-based:** publish the old and new keys together in the JWKS
set and the token's `kid` header selects the verifying key (handled by `jose`).

**Algorithm-confusion is structurally impossible.** An HS256 token is verified *only*
against `jwtSecret`; an asymmetric token is verified *only* against the JWKS — a
public key can never be presented as an HMAC secret. HS256-only deployments are
unchanged; asymmetric verification is purely additive and opt-in.

## Localhost-by-default posture

The HTTP transport and the optional `/metrics` endpoint bind to loopback unless
explicitly configured otherwise. Binding either to a non-loopback interface
**requires** JWT auth; a non-loopback bind with `auth.mode: none` is refused at
startup rather than silently exposing an open surface. The HTTP edge also validates
the `Origin` header (rejecting DNS-rebinding / cross-origin browser requests with
`403`).

## Revoking tokens and rotating the signing key

`obsidian-tc token mint` gives every token a `jti` claim and a `kid` header and records
the token (its `jti`, `kid`, subject, expiry and a scope summary, never the token string)
in the `auth_tokens` table of `cache.db`. Three commands operate on that registry:

```bash
obsidian-tc auth list [--all] [--keys] [--json] [config-path]
obsidian-tc auth revoke <jti> [--reason <text>] [config-path]
obsidian-tc auth rotate-key [--grace <seconds>] [config-path]
```

- **`auth list`** prints `jti`, `kid`, `sub`, `exp` and state (`active`, `revoked`,
  `expired`) for issued tokens, and never a token or key. `--all` includes expired
  tokens; `--keys` lists the signing keys (kid, state, created, retire_after) instead.
- **`auth revoke <jti>`** kills one token before it expires. The verifier checks the
  token's `jti` on every request, after the signature verifies, so the revoked token
  is refused (logged and counted as `token_revoked`; the caller sees the same generic
  `401` as any other bad token). The check reads `cache.db` directly with no in-process
  cache, so every process sharing that database sees a revocation on its next request.
- **`auth rotate-key`** generates a new signing key and makes it the only active one.
  The old key is `retiring` for `--grace` seconds (default `0`: retired at once, and
  every token it signed stops verifying) and verifies alongside the new one until then.

Your existing `auth.jwtSecret` keeps working with no change: it is the registry's
initial key (`kid` `config`), and a deployment that never runs `rotate-key` verifies
exactly as before. `jwtSecret` must stay configured, because it anchors the `config`
key. Keys created by `rotate-key` live in `<cacheDir>/auth-keys/<kid>.key` (mode 0600),
never in the database.

What revocation does not cover: a token with no `jti` (minted before this feature, or
by another tool) cannot be revoked individually; rotate the key instead. A token issued
by an external authorization server and verified through a JWKS is affected only if it
carries a `jti` that is present in this registry. Work already queued as a background
task keeps the scopes it was enqueued with. `cache.db` now holds these decisions, so
keep it in your backups: deleting it un-revokes tokens.

## OAuth resource-server discovery (optional)

For clients that expect OAuth-style discovery, obsidian-tc can act as an OAuth 2.0
**resource server** (RFC 9728) without changing its HS256 token format. When you set
`auth.resource` (this server's canonical URI) plus one or more
`auth.authorizationServers`, the HTTP transport serves a Protected Resource Metadata
document at `/.well-known/oauth-protected-resource` (and the path-inserted `…/mcp`)
and returns `WWW-Authenticate: Bearer resource_metadata="…"` on a `401`, so a
spec-compliant client can discover the authorization server. This is opt-in and off
by default; there is no in-repo authorization server (token issuance, Dynamic Client
Registration, OIDC discovery) — point `authorizationServers` at your external AS.

See also [Scopes & Folder ACLs](/security/acls/) and
[HITL Elicitation](/security/hitl-elicit/).
