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
