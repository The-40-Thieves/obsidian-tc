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
- **`auth.jwksFile`** — a path to a JWKS document, loaded **once** at transport boot. No network dependency.
- **`auth.jwksUri`** — the URL of an authorization server's JWKS, fetched and cached (see
  [Remote key set](#remote-key-set-authjwksuri) below). Use it when the issuer rotates keys; prefer
  `jwksFile` for static keys.
- **`auth.algorithms`** — an allowlist of JWT algorithms, applied to every verify path (HS256,
  registry keys, the JWKS and `/metrics`, which share one verifier built at boot). Omitted, HS256 plus `RS256`, `ES256` and `EdDSA` are
  accepted; a list that leaves HS256 out (such as `["RS256", "EdDSA"]`) refuses HS256 tokens
  everywhere, including the configured `jwtSecret` and any HS256 registry key.

```json
{
  "auth": {
    "mode": "jwt",
    "jwksFile": "/etc/obsidian-tc/jwks.json",
    "algorithms": ["RS256", "EdDSA"]
  }
}
```

### Remote key set (`auth.jwksUri`)

The key set URL is fetched through the same checked transport as OIDC discovery, never by `jose`'s own fetch:
the host is resolved **once**, every answer must be acceptable, and the connection goes to the addresses that
were validated (the name is never resolved again, so a DNS record that flips in between cannot reach a private
or metadata address). TLS keeps SNI and certificate validation on the hostname, a redirect is refused, the body
is capped at 256 KiB and the request has a timeout. A refusal rejects the token; there is no fallback to another
key source.

| `jwksUri` host | Result |
| --- | --- |
| `https://`, every address public | Works. **The default.** Connected to the validated address. |
| Loopback (`127.0.0.1`, `[::1]`, `localhost`), `http://` or `https://` | Works with no entry. |
| Listed in [`network.plainHttpHosts`](/configuration/config-yaml/#plain-http-provider-endpoints-networkplainhttphosts), `http://` or `https://`, every address loopback, RFC 1918, `fc00::/7` (or `100.64.0.0/10`, listed tailnet host) | Works, silently. This is the opt-out for an `http://` or LAN/tailnet key set. |
| **Not** listed, every address loopback, RFC 1918 or `fc00::/7` | Works for **one more release** with a deprecation (startup line, `doctor`, `server_health`). Refused from the next major release: list the host. |
| `http://` to a public host, a public and private mix, an unlisted `100.64.0.0/10` host | **Refused.** A key set read in clear can be forged in transit. |
| Link-local and every cloud metadata address | **Refused**, listed or not. |

The startup line (`auth: jwt auth.jwksUri ...`) and `obsidian-tc doctor` (`auth.jwks-uri`) say which mode is
active. A pinned connection is direct: `HTTPS_PROXY` is not used for the key set.

The startup line is advisory and the fetch decides again on every request. It says `REFUSED` only for a
definitive policy refusal (plain `http://` to a public host, a metadata address, a public and private mix). When
the startup lookup itself fails or times out (3 s) it says `could not verify the key set at startup; will retry on
each request` instead. A key set that answers `200` with something that is not a JWKS (not JSON, no `keys` array)
is rejected as `idp_unavailable`, like any other failed fetch.

**Bind an audience.** A JWKS trusts an external issuer, so without an enforced `aud` it accepts a token that
issuer minted for another service. Set `auth.audience`. `auth.resource` is used as the audience only when
Protected Resource Metadata is complete (`auth.authorizationServers` set too); a `resource`-only config binds
nothing. That works for one more release with a deprecation (startup line, `doctor` `auth.jwks-audience`,
`server_health`) and becomes a startup error in the next minor release. `auth.allowMissingAudience: true` is the
explicit opt-out and stops the warning. The warning is printed on every boot of such a config, including a
stdio-only one.

The two places that read `auth.resource` currently disagree, on purpose until that release:

| Config with a JWKS (`jwks`, `jwksFile` or `jwksUri`) | Config schema | Verifier |
|---|---|---|
| `auth.audience` set | accepted | enforces it |
| `auth.resource` **and** `auth.authorizationServers` | accepted | enforces `resource` as the audience |
| `auth.resource` **alone** | accepted (counts as "an audience is bound") | enforces **no** audience: a token minted for another service is accepted, with the deprecation as the only signal |
| neither `audience` nor `resource` | refused at config load | n/a |

In the next minor release the two are aligned (a `resource`-only JWKS config stops being accepted without an
enforced audience). Until then, set `auth.audience` explicitly. `test/auth-resource-alone-audience.test.ts` pins
the current behaviour.

**Key rotation is `kid`-based:** publish the old and new keys together in the JWKS
set and the token's `kid` header selects the verifying key (handled by `jose`).

**Algorithm-confusion is structurally impossible.** An HS256 token is verified *only*
against `jwtSecret` (or an HS256 key in the auth registry); an asymmetric token is verified
*only* against a registry key or the JWKS — a public key can never be presented as an HMAC
secret. HS256-only deployments are unchanged; asymmetric verification is purely additive and
opt-in.

## Localhost-by-default posture

The HTTP transport and the optional `/metrics` endpoint bind to loopback unless
explicitly configured otherwise. Binding either to a non-loopback interface
**requires** JWT auth; a non-loopback bind with `auth.mode: none` is refused at
startup rather than silently exposing an open surface. Under `auth.mode: jwt` or `oidc`, `/metrics`
needs a verified bearer holding the `admin:metrics` scope and bound to no vault or persona on
**every** bind, loopback included: a tunnel or reverse proxy in front of a loopback listener makes
remote callers look local, so the bind address is not an authentication signal (see
[Prometheus](/observability/prometheus/)). Only `auth.mode: none` keeps the open loopback scrape.
The HTTP edge validates the `Host` and `Origin` headers (rejecting DNS-rebinding / cross-origin
browser requests with `403`); a loopback `/metrics` listener applies the same `Host` guard.

## Revoking tokens and rotating the signing key

`obsidian-tc token mint` gives every token a `jti` claim and a `kid` header and records
the token (its `jti`, `kid`, subject, expiry and a scope summary, never the token string)
in the `auth_tokens` table of `<cacheDir>/auth.db` (its own file: see "Back up auth.db" below).
Three commands operate on that registry:

```bash
obsidian-tc auth list [--all] [--keys] [--json] [config-path]
obsidian-tc auth revoke <jti> [--reason <text>] [config-path]
obsidian-tc auth rotate-key [--purpose mint|as] [--grace <seconds>] [--alg HS256|ES256|EdDSA] [config-path]
```

- **`auth list`** prints `jti`, `kid`, `sub`, `exp` and state (`active`, `revoked`,
  `expired`) for issued tokens, and never a token or key. `--all` includes expired
  tokens, but a record is deleted once its token is more than a day past `exp` (at server start and
  by the periodic maintenance sweep; revocation tombstones are kept, and so is the newest record, so
  the table never empties); `--keys` lists the signing keys (kid, alg, purpose, state, created, retire_after) instead.
- **`auth revoke <jti>`** kills one token before it expires. The verifier checks the
  token's `jti` on every request, after the signature verifies, so the revoked token
  is refused (logged and counted as `token_revoked`; the caller sees the same generic
  `401` as any other bad token). The check reads `<cacheDir>/auth.db` directly with no in-process
  cache, so every process sharing that file sees a revocation on its next request. A jti this
  registry never issued (a token minted before the registry existed, or by an external issuer
  behind a JWKS) is revoked by recording a *tombstone*, so `auth revoke` works for any jti you can
  name.
- **`auth rotate-key`** generates a new signing key and makes it the only active one **of its
  purpose** (see "Key purposes" below; with no `--purpose` that is `mint`, the key `token mint`
  signs with). The old key is `retiring` for `--grace` seconds and verifies alongside the new one until
  then. Without `--grace` the window is `auth.rotationGraceSeconds` (default `0`: retired at
  once, and every token it signed stops verifying; maximum `604800`, 7 days). An explicit
  `--grace`, including `--grace 0`, always wins over the config value.

Your existing `auth.jwtSecret` keeps working with no change: it is the registry's
initial key (`kid` `config`), and a deployment that never runs `rotate-key` verifies
exactly as before. Keys created by `rotate-key` live in `<cacheDir>/auth-keys/<kid>.key`
(mode 0600), never in the database.

### The grace window

A retiring key stops verifying at its `retire_after` instant, exactly. The verifier compares
`retire_after` on every request, so the window is exact whether or not anything has yet rewritten
the row from `retiring` to `retired`. That rewrite (the *reaper*) is housekeeping that keeps
`auth list --keys` and the `obsidian_tc_auth_keys` gauge truthful, and it runs on `rotate-key`, on
server start and on the periodic maintenance sweep (`signing_keys_retired` in the sweep counts).
Nothing about verification waits for it.

`obsidian-tc doctor` (the auth registry check) lists each retiring key with its time remaining and warns
when a window has more than a day left, or when `auth.rotationGraceSeconds` itself exceeds a day: a
retiring key still verifies every token it ever signed, so a long window is a key that is barely
rotated. The Prometheus gauge `obsidian_tc_auth_keys{state="active|retiring|retired"}` reports the
counts (`retiring` counts only windows still open; `active` should be exactly 1).

### Pinning a mint to a key

`obsidian-tc token mint --kid <kid>` signs with that key only, and only if it is the **active** key
(or `config` while the registry is still empty). A retiring, retired or unknown `kid` is refused
and nothing is signed or recorded.

### Asymmetric signing keys (ES256, EdDSA)

`obsidian-tc auth rotate-key --alg ES256` (or `EdDSA`, Ed25519; the default is `HS256`) creates
an asymmetric signing key. The private key is a JWK in the same 0600 key file (created
`O_EXCL|O_NOFOLLOW`, read back through the same `fstat` trust check as an HMAC secret); the
`auth_keys.public_jwk` column holds only the public half. `token mint` then signs ES256/EdDSA
tokens, and other verifiers can validate them from the JWKS this server publishes:

```
GET /.well-known/jwks.json
{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "k_…", "alg": "EdDSA", "use": "sig" } ] }
```

It lists the **active** key and every **retiring** key still inside its window (a key drops out the
instant its window ends), public members only, and never an HS256 key. The response carries an
`ETag` over the key set (and answers `If-None-Match` with `304`), and its `Cache-Control` is bound
to key retirement: `max-age` is 60 seconds, capped at the whole seconds left until the earliest
`retire_after` among the published keys, and `no-cache` when that is under a second away. A cache
that honours it therefore never serves a retiring key past the moment this server stops verifying
it. The bound covers retirements already scheduled when the cache fetched; an immediate retirement
(`rotate-key --grace 0`) made afterwards can still be served from a cache for up to 60 seconds, so
a verifier that must see a rotation at once should revalidate (`no-cache`) rather than rely on
`max-age`. It is unauthenticated, like
the Protected Resource Metadata document, and is served whenever `auth.mode` is `jwt`; it is not
advertised as the PRM's `jwks_uri` (RFC 9728 means that field for keys the resource signs
*responses* with, which is not what these are).

**The algorithm comes from the registry row, never from the token header alone.** A token whose
`kid` names a registry key must carry that key's algorithm: an HS256 header naming an
ES256/EdDSA key (the classic public-key-as-HMAC-secret attack), or an ES256/EdDSA header naming an
HS256 key, or the wrong asymmetric algorithm, is refused `unsupported_alg` before any signature is
checked, and `alg: none` is refused everywhere. A configured `auth.algorithms` list narrows the
registry algorithms too, and it applies to HS256 as well: `["EdDSA"]` refuses HS256 on the MCP edge
and on `/metrics` alike.

### Key purposes (`mint` and `as`)

Every registry key has a **purpose**, and the registry holds one **active** key per purpose:

| purpose | signs | algorithms | verified by |
| --- | --- | --- | --- |
| `mint` (the default) | the tokens `obsidian-tc token mint` prints, and the write-provenance chain | HS256, ES256, EdDSA | exactly the rules above, including `auth.issuer` and `auth.audience` when set |
| `as` | the access tokens of the bundled authorization server (RFC 9068 JWTs) | ES256, EdDSA only | stricter rules of its own, below |

Every key that existed before purposes was a `mint` key, and a deployment that never creates an
`as` key behaves exactly as before: the `<cacheDir>/auth.db` migration adds the column with `mint` as its default.
Because each purpose has its own active key, `obsidian-tc auth rotate-key --purpose as` never
retires your HS256 (or any other) `mint` key, and a `mint` rotation never retires the `as` key. Your
hand-minted tokens therefore keep verifying however often the `as` key rotates.

```bash
obsidian-tc auth rotate-key --purpose as [--alg ES256|EdDSA] [--grace <seconds>] [config-path]
```

- The algorithm defaults to ES256 for `as`; HS256 is refused. The key's `kid` is its RFC 7638
  thumbprint, and its private JWK lives in `auth-keys/as-<kid>.key` (0600), never in the database.
- Replacing an `as` key needs a grace window of at least the access-token lifetime plus 60 seconds
  (1860 s with the default 1800 s lifetime), so a rotation never kills a live access token. An
  omitted `--grace` uses that floor (or `auth.rotationGraceSeconds` when that is longer); an explicit
  shorter one is refused and nothing changes.
- `/.well-known/jwks.json` publishes the active and in-window retiring asymmetric keys of **both**
  purposes, public members only.

A token whose `kid` names an `as` key is checked by the **key's** purpose, never by what the token
says about itself. It must carry `iss` equal to the authorization server's issuer, the JOSE header
`typ: at+jwt`, a non-empty `client_id`, `aud` equal to `auth.resource` (a single string; an
`auth.audience` override does not apply), and a `jti` (required even with `auth.requireJti` off).
Its scopes come from the `scope` claim only. The legacy `auth.issuer` never applies to an `as`
token, and still binds only `mint` tokens. A token signed by an `as` key but shaped like a
hand-minted one (no `typ`, no `client_id`, the legacy issuer) is refused. The verifier refuses every
`as` token until the issuer and resource are configured, so creating a key alone enables nothing.

**Personas narrow `as` tokens.** For a token signed by an `as` key that carries a `persona`, the
effective scopes are the persona's scopes **intersected** with the token's `scope`: this only ever
removes, and a scope the token holds but the persona lacks is not granted. A hand-minted persona token
keeps the existing rule: the persona's scopes replace the token's.

### Removing `auth.jwtSecret`

Once `rotate-key` has retired the `config` key, `auth.jwtSecret` verifies and signs nothing, and
verification and minting work from the registry keys alone: you can remove `auth.jwtSecret` (and
`OBSIDIAN_TC_JWT_SECRET`), and `doctor` tells you when. A `jwt` server that has no `jwtSecret`, no
JWKS and no registry key refuses to start. Removing the secret has one side effect, because it
also keys them when set: `read_notes` continuation cursors become per-process (a cursor does not
survive a restart). It does not touch the HTTP elicit round trip (`requestState`): that is keyed
from the server-local secret (see [HITL Elicitation](/security/hitl-elicit/)), so it works the
same under `oidc`, under asymmetric-only `jwt`, and across a `jwtSecret` change.

### Tokens with no `jti`

A token with no `jti` (minted before this feature, or by another tool) cannot be revoked
individually; only rotating its signing key kills it. Set `auth.requireJti: true` to reject
such tokens outright on every path (HS256, JWKS, `/metrics`). `securityProfile: "hardened"` sets
it to `true` (an explicit `auth.requireJti: false` still wins). The schema default stays `false`
for now so existing tokens keep working; it is planned to flip to `true` at the next major
release. `obsidian-tc doctor` recommends `true` once the registry is in use (`token mint` always
sets a `jti`).

### Back up `<cacheDir>/auth.db`: it is not a cache

The registry lives in `<cacheDir>/auth.db` and the signing keys in `<cacheDir>/auth-keys/`.
Unlike `cache.db`, **neither is regenerable**: they hold your decisions to revoke a token or
retire a key. `rm <cacheDir>/cache.db*` (the documented way to reset the index), `compact`,
`reset_vault_cache` and every other cache wipe leave them alone; back both up with your other
operator state.

The server fails closed if the registry is lost, and it judges each part separately. Three marker
files sit in `auth-keys/`, outside the database: `.keys-initialized` (the first `mint` `rotate-key`; any
`*.key` file other than an `as` key's counts too), `.as-keys-initialized` (the first `rotate-key
--purpose as`; any `as-*.key` file counts too) and `.tokens-initialized` (the first `token mint` or
`revoke`). A part whose marker
exists but which now holds no rows, or an `<cacheDir>/auth.db` that is missing altogether, makes the
verifier refuse every HS256 bearer (reason `registry_lost`), the startup log and `doctor` name the
problem, and `auth *` and `token mint` refuse to run. That covers a partial restore too: an emptied
`auth_keys` no longer falls back to `auth.jwtSecret` (which would revive a retired key), and an emptied
`auth_tokens` no longer reads every revoked token as live. An `auth-keys/` that is a symlink (even to an
empty directory) or a plain file is refused the same way, and `doctor` names it. Recover by restoring
`<cacheDir>/auth.db` from backup.

**Destructive escape hatch.** If you accept that revoked tokens and retired keys become valid again,
remove BOTH `<cacheDir>/auth.db` and the `auth-keys/` directory (the markers live in it) to return to
`auth.jwtSecret` alone. This is intended, and it is the only way back to that state: there is no
setting that skips the check. Removing only one of the two leaves the registry lost.

### Signing-key files

A key file is trusted only if it is a regular file owned by the server user, not readable by
group or other (0600), reached without following a symlink, inside a real `auth-keys/` directory
(0700, not a symlink). The check runs on the open file descriptor and is repeated at least
once a second (a validated secret is reused for at most one second, so a `chmod` or symlink swap
after startup is noticed within that window), and keys are created with
`O_EXCL|O_NOFOLLOW`. On **Windows** there are no POSIX modes, owner check or `O_NOFOLLOW`, so
none of this is enforced: protect the directory with its ACL (`doctor` warns).

### What revocation does not cover

An external issuer's token is affected only by a `jti` you revoked (tombstone) or that is in the
registry. Work already queued as a background task keeps the scopes it was enqueued with:
revocation is checked when a request is authenticated, and a queued task has no request, so
revoking a token does not stop a task it already enqueued.

## The bundled authorization server (`auth.as`)

Opt-in (`auth.as.enabled`, default off; see [config](/configuration/config-yaml/#bundled-authorization-server-authas)).
This release adds the pieces that exist before any token is issued: the metadata, the signing key and the store.

- **Metadata.** `GET /.well-known/oauth-authorization-server` (and `/.well-known/openid-configuration`) returns
  the RFC 8414 document. Every URL in it is built from `auth.as.issuer`; the `Host` and `X-Forwarded-*` headers
  are never consulted, so a forged `Host` cannot move the issuer. It advertises `code_challenge_methods_supported:
  ["S256"]`, the RFC 9207 `iss` response parameter, `client_id_metadata_document_supported: true` and `none` as a
  client-authentication method (what Claude needs for Client ID Metadata Documents), and `registration_endpoint`
  only while `auth.as.dynamicRegistration` is on. `private_key_jwt` is never advertised. Protected Resource
  Metadata names the issuer first by default.
- **Signing key.** At boot with the AS enabled the server generates one `as`-purpose key
  ([Key purposes](#key-purposes-mint-and-as)) if there is none: idempotent, never in a lost registry, and never
  replacing an existing key because the configured algorithm changed (rotate with `auth rotate-key --purpose as`;
  `doctor` and a startup warning name the mismatch). Its public half is published at `/.well-known/jwks.json`.
- **A fourth store, `<cacheDir>/oauth.db`.** It holds the authorization server's own state (operator account,
  grants, refresh tokens, registered clients, pending requests). Unlike `<cacheDir>/auth.db` it is **fail-safe when lost**:
  a missing file is recreated empty, clients sign in again after the account is re-claimed, access tokens already
  issued expire on their own and revocations live in `<cacheDir>/auth.db`. Back it up anyway: **`<cacheDir>/oauth.db` (with `-wal`),
  `<cacheDir>/auth.db` and `auth-keys/` together**, so a restore never pairs a new key set with an old registry. Expired
  rows (sessions, pending requests, codes, access-token ids, refresh families past their cap, idle dynamic
  clients) are deleted at boot and by the maintenance sweep; grants and the operator account are kept.
- **Verification.** A token signed by the `as` key is accepted only while the AS is enabled
  (`iss` = the issuer, `aud` = `auth.resource`); with it off the same token is `misconfigured`. An `as` token
  must carry a string `sub`, `jti` and `client_id` and a numeric `iat`, and only fully qualified scopes
  (`read:notes`, not bare `read`) count. Hand-minted tokens keep their rules; a non-string `jti` on any token is
  now refused instead of being treated as absent, which would have made it impossible to revoke.
- **No JWKS duplicate.** A configured `auth.jwks` or `auth.jwksFile` holding the `as` key's public key stops the
  boot; a remote `auth.jwksUri` cannot be checked.

## Verifying an external OpenID Connect provider (`oidc` mode)

If you already run an identity provider (Keycloak, Auth0, Entra ID, Okta, Zitadel, Cloudflare Access), obsidian-tc
can verify the access tokens **it** issues instead of minting its own. This is verification only: the server never
issues, refreshes or registers anything.

```json
{
  "auth": {
    "mode": "oidc",
    "resource": "https://vault.example.com/mcp",
    "requireJti": true,
    "oidc": {
      "issuer": "https://your-tenant.eu.auth0.com/",
      "audience": "https://vault.example.com/mcp",
      "claimMapping": { "scopes": "permissions" }
    }
  }
}
```

That is an Auth0 API named `https://vault.example.com/mcp`, with RBAC enabled and "Add permissions in the access
token" on, so its tokens carry a `permissions` array holding your obsidian-tc scopes (`read:notes`, `write:notes`, ...).
Auth0's issuer ends with a `/` and must be written exactly that way. Only **fully-qualified** scope strings
(`family:resource`, for example `read:notes` or `write:*`) are taken from the scopes claim; see
[Mapping roles to scopes](#mapping-roles-to-scopes).

**Keycloak.** Use the realm URL as the issuer and map realm roles explicitly. A bare role name is *not* a scope:
obsidian-tc reads a scope with no colon as a wildcard over the whole family, so a realm role called `admin` would
otherwise mean `admin:*`.

```json
"oidc": {
  "issuer": "https://kc.example.com/realms/vault",
  "audience": "https://vault.example.com/mcp",
  "clientId": "vault-client",
  "claimMapping": {
    "scopes": "realm_access.roles",
    "scopeMap": {
      "vault-reader": ["read:notes", "read:search"],
      "vault-editor": ["read:notes", "write:notes"]
    }
  }
}
```

Keycloak puts `JWT` in the JOSE header of its access, ID and refresh tokens alike; the kind is in the payload
`typ` (`Bearer`, `ID`, `Refresh`), which obsidian-tc reads. Configure an audience mapper so access tokens carry
your API audience.

**Entra ID** (v2 endpoint): `"issuer": "https://login.microsoftonline.com/<tenant>/v2.0"`, and
`"claimMapping": { "scopes": "scp" }` with the API's delegated scopes named as obsidian-tc scopes, or
`"scopes": "roles"` plus a `scopeMap` for app roles. **Auth0 namespaced claims** (a claim whose *name* is a URL,
such as `https://vault.example.com/roles`) are written as an array holding the literal name, because a string is
always a dotted path into nested objects:

```json
"claimMapping": {
  "scopes": ["https://vault.example.com/roles"],
  "scopeMap": { "editor": ["read:notes", "write:notes"] }
}
```

### Mapping roles to scopes

- The scopes claim (`claimMapping.scopes`) may be a space-delimited string or an array. A value grants scopes only
  if it is in `scopeMap` (then exactly the listed scopes) or is a fully-qualified scope. Anything else, such as the
  role `admin`, the standard `openid` / `profile`, or `*`, grants nothing and is logged once per value.
- `claimMapping.subject`, `scopes`, `principal`, `vault`, `persona` and every `requiredClaims` name are a dotted
  path into **nested** claims (`realm_access.roles`) or an array of literal segments. A top-level claim that happens
  to be named `realm_access.roles` is never used in place of the nested one.
- `claimMapping.persona` and `claimMapping.vault` are bearer capabilities: setting either requires
  `allowedPersonas` / `allowedVaults`, and a token naming anything else (or a non-string) is refused, not ignored.
- `requiredClaims` is either a list of names, each of which must hold a truthy, non-empty value (so
  `email_verified: false` fails `["email_verified"]`), or an object of exact values
  (`{ "email_verified": true, "hd": "example.com" }`; an array claim satisfies it when it contains the value).

What to know before turning it on:

- **The issuer is compared exactly**, against every token's `iss` and against the `issuer` in the discovery document
  fetched from `<issuer>/.well-known/openid-configuration`. Discovery is https only, refuses redirects, and is
  size- and time-bounded. If it fails at boot the server does not start (`obsidian-tc doctor` runs the same probe).
- **Where the IdP may be.** The discovered `jwks_uri` must be on the issuer's origin, with no credentials in the
  URL; list another host in `allowedJwksHosts` (Google serves keys from `www.googleapis.com`) or set `jwksUri`
  yourself. Before every fetch the host is resolved and refused if any address is loopback, link-local (the cloud
  metadata address), private or reserved. For an identity provider on your own LAN set `allowPrivateNetwork: true`.
  The connection is pinned to the addresses that check validated (the name is not resolved again, so a DNS record
  that changes in between cannot redirect it), with TLS verified against the issuer's hostname; a pinned connection
  is direct, so `HTTPS_PROXY` is not used for the identity provider (with `allowPrivateNetwork: true` nothing is
  pinned and the ordinary fetch applies). IPv6 transition addresses that embed a blocked IPv4 (6to4, Teredo) are
  blocked too. `allowedJwksHosts` admits a hostname on the default https port only; a `jwks_uri` on another port needs
  `jwksUri`. A `jwks_uri` is shown in logs, errors and `doctor` as its origin only (its path and query string can carry a credential).
- **`audience` is required.** Register a dedicated API audience at the IdP. Using a client id as the audience would
  let an ID token through.
- **Algorithms are asymmetric only** (`allowedAlgs`, default RS256, ES256, EdDSA). HS256 and `none` cannot be
  configured, and a `jwtSecret` never verifies an OIDC bearer.
- **`typ`.** `at+jwt` (RFC 9068), `JWT`, `Bearer` and no `typ` are accepted in the JOSE header by default; anything
  else, and a header `typ` that is not a string, is refused. Because IdPs put `JWT` in the header of ID tokens too,
  the payload is read as well: a `typ` other than `Bearer`, a `nonce`, `at_hash` or `c_hash` claim, or a Cognito
  `token_use` other than `access` marks an ID or refresh token and is refused. Set `requireAtJwtType: true` if
  your IdP issues RFC 9068 tokens.
- **Clock skew** of `clockToleranceSeconds` (default 30, at most 300) is allowed on `exp`, `nbf` and `iat`.
- **Revocation.** An IdP token with a `jti` can be revoked with `obsidian-tc auth revoke <jti>`; `auth.requireJti`
  refuses tokens without one. A lost or partly lost auth registry refuses every token, with or without a `jti`, in
  `oidc` and `jwt` mode alike. Prefer short IdP token
  lifetimes: revocation here is a local deny list, not a call to the IdP.
- **Everything downstream is unchanged.** Scopes, folder ACLs, rule-scopes, vault binding (`claimMapping.vault`) and
  personas (`claimMapping.persona`) apply exactly as in `jwt` mode, once the token's claims have been mapped as
  above.

With `auth.resource` set, the Protected Resource Metadata document advertises the issuer as the authorization
server, so an MCP client can discover where to sign in. Whether that client can then register with your IdP is up to
the IdP.

## OAuth resource-server discovery (optional)

For clients that expect OAuth-style discovery, obsidian-tc can act as an OAuth 2.0
**resource server** (RFC 9728) without changing its HS256 token format. When you set
`auth.resource` (this server's canonical URI) plus one or more
`auth.authorizationServers`, the HTTP transport serves a Protected Resource Metadata
document at `/.well-known/oauth-protected-resource` (and the path-inserted `…/mcp`)
and returns `WWW-Authenticate: Bearer resource_metadata="…"` on a `401`, so a
spec-compliant client can discover the authorization server. This is opt-in and off
by default; there is no in-repo authorization server (token issuance, Dynamic Client
Registration, OIDC discovery) — point `authorizationServers` at your external AS, or use `oidc` mode
above, which advertises the issuer for you.

See also [Scopes & Folder ACLs](/security/acls/) and
[HITL Elicitation](/security/hitl-elicit/).
