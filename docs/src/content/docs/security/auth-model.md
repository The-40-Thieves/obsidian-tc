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
`typ: at+jwt`, a non-empty `client_id`, `aud` equal to `auth.resource` or to one of its
[profile URLs](#profile-urls-and-oauth) (a single string; an `auth.audience` override does
not apply), and a `jti` (required even with `auth.requireJti` off).
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

### Rotating the server secret

The server-local secret (`<cacheDir>/server-secrets/wiki-generated.key`) keys the HITL confirmation
state and seals generated wiki pages; it is not a bearer credential. There is no rotate command:
**stop every process that shares the `cacheDir`** (a worker still running keeps the old key in
memory and keeps accepting state minted with it, which matters most when the key was disclosed),
**delete the file once**, then restart them all. A new key is generated on the first start, and the
others adopt it.
Consequences: every pending confirmation is refused once (the client is offered a fresh one), and
every generated wiki page then reads as edited (its seal no longer verifies) and is regenerated, so
copy out any hand edit you want to keep first.

Delete the file rather than `chmod 600` it when the server refuses it for being readable by group or
other. The server cannot know who read it while it was open, so a key that was ever exposed is
replaced, never re-adopted. A corrupt or empty file is regenerated automatically; processes that
start at the same moment settle on one key.

A corrupt key is repaired under a lock (`wiki-generated.key.repair-lock/`, a directory beside the
key). A waiter takes that lock over only when its holder is provably dead: the same host, and a pid
that no longer exists (or now belongs to a process that started at another time). A holder that is
merely slow or stopped is never taken over, since it could still act on a stale view and leave two
servers on two keys. When the holder is on another host, or cannot be judged, the start fails after
15 seconds with an error naming the lock and its holder. Stop every process sharing the `cacheDir`,
delete that directory (and any `wiki-generated.key.repair-lock.takeover.*` file beside it), and start
again.

Keep `server-secrets/` on the same persistent volume as `auth-keys/` (mount the whole `cacheDir`).
Back it up with them.

### What revocation does not cover

An external issuer's token is affected only by a `jti` you revoked (tombstone) or that is in the
registry. Work already queued as a background task keeps the scopes it was enqueued with:
revocation is checked when a request is authenticated, and a queued task has no request, so
revoking a token does not stop a task it already enqueued.

## The bundled authorization server (`auth.as`)

Opt-in (`auth.as.enabled`, default off; see [config](/configuration/config-yaml/#bundled-authorization-server-authas)).
It issues tokens itself: the metadata, the signing key, the store, the authorize, consent, token and revoke routes,
and the client registrations below.

- **Metadata, once the server can issue.** `GET /.well-known/oauth-authorization-server` (and
  `/.well-known/openid-configuration`) returns the RFC 8414 document, and Protected Resource Metadata names the
  issuer first by default, only when the authorize and token routes are actually served (a build without them
  changes nothing a client discovers: no metadata, no PRM default, no `resource_metadata` pointer in a 401
  challenge). Every URL in the document is built from `auth.as.issuer`; the `Host` and `X-Forwarded-*` headers are
  never consulted, so a forged `Host` cannot move the issuer. It carries `code_challenge_methods_supported:
  ["S256"]`, the RFC 9207 `iss` response parameter, `none` as a client-authentication method, the `refresh_token`
  grant, `offline_access` among the scopes, `revocation_endpoint` and `client_id_metadata_document_supported: true`;
  `registration_endpoint` appears unless `auth.as.dynamicRegistration` is turned off. `private_key_jwt` is never
  advertised.
- **Clients registered by Dynamic Client Registration (on by default).** DCR is on unless you set
  `auth.as.dynamicRegistration: false` (owner decision, 2026-10-09): many MCP surfaces (Cursor, Windsurf,
  Antigravity, grok.com, Grok Build, Le Chat, n8n, the Gemini app) only support DCR, so a default-off server did
  not work with them out of the box. To disable it, set the flag to `false`; `/oauth/register` is then a 404 and
  `registration_endpoint` is not advertised. `POST /oauth/register` (RFC 7591, JSON) creates a public client: `token_endpoint_auth_method` must be `none` (or
  absent), no secret is ever issued, and the server picks the `client_id` (a `client_id` in the request is ignored,
  so a registration cannot take a static client's id or a metadata-document URL). `redirect_uris` must hold an
  https or loopback URI; a private-use scheme such as Cursor's `cursor://...` is dropped from the registration,
  not refused, while one usable URI remains. DCR is deprecated by the MCP authorization spec and lets anyone who can
  reach the server create rows and put a name in front of you, so it is bounded: `auth.as.dcr.perIpPerHour`
  registrations per source (the TCP peer, an IPv6 address as its /64; behind a same-host proxy or tunnel every client
  shares one bucket, as for metadata documents), `auth.as.dcr.maxClients` rows (a full table first drops
  registrations never used within a day, then answers `503`), and registrations unused for `auth.as.dcr.unusedDays`
  are deleted (until a trusted-proxy setting exists, that shared bucket means one noisy client can use up the
  hourly budget for every other client behind the same proxy). A registered client's consent page warns that it registered itself and has never been approved. The
  server logs one info line at boot naming these limits while DCR is on, and `securityProfile: "hardened"` forces
  it off even when the flag is set to `true` (the loader says so). Claude (claude.ai, Claude Code) and ChatGPT support both registration methods and prefer a metadata
  document when the server advertises one, which this server does, so they do not need DCR; it is for clients
  with no metadata-document support. The registered `grant_types` are honored: a client that lists `refresh_token`
  gets a refresh token, one that lists only `authorization_code` (or nothing: the RFC 7591 default) gets none, and
  the `201` echoes exactly what will be served. A registration counts as used only when a sign-in succeeded (a code
  issued or a refresh token rotated), never because someone looked its `client_id` up, so a full table can always
  reclaim registrations that were only ever probed.
- **Clients registered by a metadata document (CIMD).** A `client_id` that is an `https://` URL with a path is
  fetched, and the document served there is the client's registration (Claude Code, Codex and ChatGPT register this
  way). The fetch is the same bounded one OIDC discovery uses: https only, no redirects, every resolved address
  public (loopback, private, link-local and cloud-metadata targets are refused, and there is no private-network
  opt-in for a document), the connection pinned to the addresses just checked, 5 KiB and 5 s. The document's
  `client_id` must equal the URL, `redirect_uris` must hold an https or loopback URI, and `logo_uri`, `jwks_uri` and
  `client_uri` are never fetched. The list `token_endpoint_auth_methods_supported` decides the client-authentication
  method; the singular `token_endpoint_auth_method` counts only when the list is absent, so ChatGPT's document
  (singular `private_key_jwt`, list `["private_key_jwt", "none"]`) resolves to `none`, and a document that permits
  only `private_key_jwt` is refused. The client is then bound to `none`: a secret, a Basic header or a client
  assertion at the token or revocation endpoint is `invalid_client`. A document is cached for its `Cache-Control:
  max-age` clamped to 5 minutes to 24 hours (errors are never cached, the table is capped, and only the validated
  fields are kept). `auth.as.cimd.allowedHosts` limits which hosts may be client ids. The consent page names the host
  the client is registered at, warns loudly when the redirect it was asked to use is on this machine (any `127.0.0.0/8`
  address, `::1` or `localhost`, over http or https), and warns when the operator has never approved a
  metadata-document client before, since anyone can publish a document under any name. A callback on this machine
  is remembered like any other once you have approved the client: the grant is kept without the port, so Claude Code
  and Codex sign in again without a click. The trade-off is plain: a callback's port is chosen at run time and nothing
  proves which local process is behind it, so with the default a malicious process on the same machine can start
  its own sign-in for an approved client and obtain a token without a prompt. Such a process could typically already
  read the stored tokens of those CLIs. Set `auth.as.consent.loopback: prompt` to show the consent page on every
  sign-in that returns to a loopback address (the warning above is on it), whichever port it uses, even for a client and
  path you approved a minute ago. A lookup is bounded: one 5 s deadline covers the name lookup, the connection and the
  body, one source may start five uncached lookups a minute and have two running at once (an IPv6 address counts as
  its /64; a peer with no usable address, such as a reverse proxy or tunnel on the same host, is one shared source
  that may start ten a minute, not an exemption, so behind a tunnel every client shares that allowance), a request that is already malformed never
  starts one, and the sign-in page says only that the client cannot be used, whatever the reason (the log has it).
  The approval re-reads the client, so a document that drops the redirect after the page was shown issues no code.
  The client's name is shown with control, format and bidirectional characters removed.
- **Refresh tokens and revocation.** Every code exchange returns a refresh token (opaque, 32 random bytes, stored
  only as a SHA-256), except to a dynamically registered client that did not register the `refresh_token` grant. It rotates on every use and its family ends `auth.as.refreshTokenDays` after the exchange.
  A client that lost a refresh response may retry the previous token until its successor has been used, and is
  handed the same response again (the same access token and refresh token, nothing new minted; once that access
  token has expired the retry is refused and the client signs in again). Clients that refresh from several
  windows or processes sharing one token (Zed, Claude Code, Gemini CLI) hit the same race one step later, when
  the first window has already used the successor. So for `auth.as.refreshReuseGraceSeconds` (default 30) after
  the family first used a token's successor, presenting that token again is answered with the same successor and
  access token, once more minting nothing and forking nothing, and it revokes nothing; the family then carries on
  from its newest token. The grace covers one used step only: an older token, a presentation after the window,
  or one made after the successor's own successor was used **revokes the family** like any other reuse, and it
  never applies to another client's request. **Residual risk:** inside that window rotation's theft detection does
  not fire for the previous token, so a thief who holds a stolen token and its `client_id` and replays it within
  seconds of the legitimate client's next refresh gets the same pair that client already holds (no new branch,
  nothing the owner lacks) and is not detected by that request. The next use of either copy of the family's newest
  token is detected as usual. Set `refreshReuseGraceSeconds: 0` for strict rotation: the previous token is then
  accepted only until its successor is used. Any
  older token, or the previous one after that, **revokes the family**: the refresh token and every access token
  issued from it stop working. Only the owning client's request can do that, and every refresh failure is the
  same `invalid_grant`. A refresh token belongs to the server secret that minted it: replacing the secret retires
  every family (the next use of any token is `invalid_grant` and revokes it). Revoking a family or a grant is
  recorded durably before the registry is told, so a busy token registry database cannot leave a revoked family's access tokens
  live. The account's `scopes_allowed` / `vaults_allowed` are applied again at each refresh.
  `POST /oauth/revoke` (RFC 7009) revokes a refresh token's family or an access token's `jti`, and answers an empty
  200 for anything else. On the host, `obsidian-tc auth as grants list [--all]` shows what has been granted and
  `auth as grants revoke <id>` kills a grant's refresh tokens and live access tokens at once.
- **Signing key.** At boot with the AS enabled the server generates one `as`-purpose key
  ([Key purposes](#key-purposes-mint-and-as)) if there is none: idempotent, never in a lost registry, and never
  replacing an existing key because the configured algorithm changed (rotate with `auth rotate-key --purpose as`;
  `doctor` and a startup warning name the mismatch). Its public half is published at `/.well-known/jwks.json`.
- **A fourth store, `<cacheDir>/oauth.db`.** It holds the authorization server's own state (operator account,
  grants, refresh tokens, registered clients, pending requests), created owner-only (0600, with its `-wal` and
  `-shm`, and so is `<cacheDir>/auth.db`). Unlike `<cacheDir>/auth.db` it is **fail-safe when lost**:
  a missing file is recreated empty, clients sign in again after the account is re-claimed, access tokens already
  issued expire on their own and revocations live in `<cacheDir>/auth.db`. Back it up anyway: **`<cacheDir>/oauth.db` (with `-wal`),
  `<cacheDir>/auth.db` and `auth-keys/` together**, so a restore never pairs a new key set with an old registry. Expired
  rows (sessions, pending requests, codes, access-token ids, refresh families past their cap, idle dynamic
  clients) are deleted at boot and by the maintenance sweep; grants and the operator account are kept.
- **Operator login.** One operator account signs in to the server's own pages; there is no other way in.
  See [Operator login](#operator-login-and-claiming-the-server) below.
- **Verification.** A token signed by the `as` key is accepted only while the AS is enabled
  (`iss` = the issuer, `aud` = `auth.resource`); with it off the same token is `misconfigured`. An `as` token
  must carry a string `sub`, `jti` and `client_id` and a numeric `iat`, and only fully qualified scopes
  (`read:notes`, not bare `read`) count. Hand-minted tokens keep their rules: enabling the AS does not start
  binding an `aud` to them (a hand-minted HS256 token without `aud` still gets a 200; set `auth.audience` to bind
  one). A `jti` that is present but not a non-empty string is refused on every path instead of being treated as
  absent, which would have made it impossible to revoke.
- **No JWKS duplicate.** A configured `auth.jwks` or `auth.jwksFile` holding the `as` key's public key stops the
  boot; a remote `auth.jwksUri` cannot be checked.

### Operator login and claiming the server

The bundled server has one operator account, stored in `<cacheDir>/oauth.db` (the `users` table is multi-row, but
adding users is a later change). Until it exists the server is **unclaimed**: `/oauth/login` answers `503`
"not claimed", and so do `/oauth/authorize`, `/oauth/token` and `/oauth/register`. The server logs a notice at boot
while it is unclaimed. Claim it one of two ways.

- **From the host.** `obsidian-tc auth as set-password [--user <name>] [--stdin]` asks for a password twice
  without echo, or reads one line from standard input with `--stdin` (the only way without a terminal). The
  default account name is `operator`. Run again, it changes that operator's password and ends their sessions. It
  needs `auth.as.enabled` and Node 24.7 or later (or Bun).
- **From a browser, with a setup token.** Put a random value of at least 24 characters in the environment variable
  named by `auth.as.setupTokenEnv` (default `OBSIDIAN_TC_AS_SETUP_TOKEN`; for example `openssl rand -base64 32`),
  start the server and open `<issuer>/oauth/setup`. The token is read from the environment on each request and is
  never logged. It works **once**: its SHA-256 is recorded as used, so the same value is refused afterwards even if
  the account is later removed (set a new one). It also stops working 24 hours after the server started (restart to
  open it again), and ten wrong guesses lock the page for a while. With the variable unset, empty or too short,
  `/oauth/setup` does not exist (`404`). Remove the variable once you have claimed the server.

Two claims at once have exactly one winner, whether they arrive by the CLI or the page, from one process or
several: the claim is a single `BEGIN IMMEDIATE` transaction in `oauth.db`.

**Passwords** are at least 12 characters and are stored as Argon2id (`node:crypto.argon2`, the OWASP minimum:
19 MiB, 2 passes, 1 lane) in a PHC string, so the parameters can be raised later with a rehash at the next login.
A Node older than 24.7 has no `crypto.argon2`; with `auth.as.enabled` the server then refuses to start, naming
the version it needs (the rest of the server does not need it).

**Sign-in** is `/oauth/login`. The session cookie is `__Host-otc_as` (`HttpOnly; Secure; SameSite=Lax; Path=/`);
only on a loopback `http` issuer is it the un-prefixed `otc_as` without `Secure`, since a `__Host-` cookie
cannot be set over plain http. The value is a random id that exists only in the browser: the server keeps its
SHA-256, a fresh id is issued at every login (one the client supplied is never adopted, and the one it presented is
retired), and the row is deleted at sign-out, so an old cookie is dead server-side. A session ends after 30 minutes
without a request or 12 hours after login, and when its account is disabled. Sign-out is `POST /oauth/logout`.

**Brute force.** After `auth.as.login.maxFailuresPerWindow` wrong passwords for one name within
`windowSeconds`, that name is locked: 30 s, doubling with each further failure, never longer than the window,
and even the right password is refused until it passes (`429` with `Retry-After`). Attempts made while locked
do not extend it. The counter is keyed on the submitted name whether or not the account exists, an unknown name
gets the same answer as a wrong password and still costs one password verification, so neither the response nor
the lock shows which names are real. One peer address is also limited, to four times that budget across all
names; the address is the TCP peer, never `X-Forwarded-For`, and a loopback peer (a reverse proxy or tunnel on the
same host) is not counted, so behind one the per-name limit is the one that applies. At most four verifications
run at once; beyond that login answers `503`. Counters are in memory and reset at restart.

**The pages** carry `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'` (the one script is the server's own passkey script,
below; no inline script or style, no CDN), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`, on every response including errors and redirects. Every form is protected
against cross-site requests three ways: a token bound to the form and to the browser (before sign-in a per-browser
cookie, after it the session), an `Origin` header equal to the issuer's origin (a request without one is refused),
and the urlencoded content type; bodies are capped at 16 KiB. A successful POST answers `303`, never a status
a browser would repeat the POST for. The server logs only that something happened (claimed, login failed,
locked, signed out) with the peer address: never a name, password, token, cookie or query string.

### Passkeys and recovering a lost one

The operator can add **passkeys** (WebAuthn) beside the password; they never replace it, so the password stays a
way back in. Sign in with the password, open `/oauth/account` (linked from the signed-in page) and choose **Add a
passkey**. The account page lists each passkey with when it was added and last used, and removes any of them.
Adding or removing one needs a sign-in within the last 5 minutes. At `/oauth/login` the username field offers the
passkey in the browser's autofill (conditional UI), so no username or password is typed; a **Sign in with a
passkey** button covers browsers without it, and a browser without WebAuthn JSON support simply shows the password
form. A passkey login opens the same session a password login does.

The server asks for a discoverable credential with user verification required and accepts **attestation `none`
only**: a `packed`, `tpm`, `android-*`, `apple` or `fido-u2f` statement is refused before any of it is parsed as a
certificate. The relying-party id is the issuer's host and the only accepted origin is the issuer's origin, so a
credential registered for another host fails, and **a change of issuer host orphans every passkey** (sign in with the
password and enrol again, or use the reset below). The authenticator's signature counter is stored: a login whose
counter is not greater than a stored non-zero value is refused as a possible clone (a constant `0`, as synced
passkeys report, is accepted). Each challenge is single-use and lives five minutes. Passkeys are verified with
`@simplewebauthn/server` (pure JavaScript); the browser half is a small script served by the server itself at
`/oauth/assets/passkey.js`, using the browser's own WebAuthn JSON API.

**Lost the passkey and the password** (or the host changed)? On the host run
`obsidian-tc auth as reset-credentials [--user <name>] [--stdin] [--revoke-grants]`. It sets a new password, deletes
the operator's passkeys and ends every session, in one transaction. With `--revoke-grants` it also revokes every
grant of the operator, with its refresh-token families and live access tokens, **in that same transaction** (the
access-token revocations are queued in the durable outbox and paid to the registry right after the commit). Shell
access to the host and write access to `<cacheDir>` are the credential, exactly as for `set-password`. Then sign in
with the new password and enrol a new passkey.

**A reset ends what was already running, too.** The operator account carries a *credential generation* that the
reset (and `set-password`) moves on in that transaction, and every session records the generation it was opened
under. A passkey registration, an enrolment challenge or a consent that was already underway on an old session
re-checks, inside its own write transaction, that the session still exists and still carries the account's
generation: after a reset it writes nothing (a registration is refused, a consent is sent back to sign in), and a
grant made just before the reset is revoked by it. This is the same check a password login makes before it opens a
session.

**What an anonymous caller can spend.** `POST /oauth/passkey/login/options` is open to anyone who loads the login
page, so it is budgeted: a burst of 20 challenges per source, refilling at 20 a minute (answer `429` with
`Retry-After`), and one shared, larger bucket for callers the server cannot tell apart (an unknown or loopback
address, as behind a Cloudflare tunnel on the same host). Pending challenges are capped per purpose (400 login, 100
enrolment), so a flood of login challenges cannot take the room enrolment needs. Failed passkey logins are counted
per source **and per credential** (the same budget as one password account); a caller whose address is hidden is
bound only by its credential keys and by the single-use challenge each attempt needs, so failures on credentials
that are not the operator's cannot lock the operator out. Without a trusted-proxy setting the server cannot tell
clients behind a loopback proxy apart: a determined flood there can still exhaust the shared bucket and delay
passkey sign-in (the password form is unaffected) until it refills.

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
by default. Point `authorizationServers` at an external AS, use `oidc` mode above (which advertises
the issuer for you), or enable [the bundled authorization server](#the-bundled-authorization-server-authas).

### Profile URLs and OAuth

The [tool-budget profile URLs](/tools/#tool-budget-profiles) (`/mcp/essentials`, `core`, `full`,
`triad`, `domain`) sign in like `/mcp`. With `auth.resource` set to the `/mcp` URL (R), a client
may be given R or R plus any of those names:

- The `401` on `R/<name>` points `resource_metadata` at a document that is served at the
  path-inserted URL (`/.well-known/oauth-protected-resource/mcp/<name>`) and whose `resource`
  is the URL the client was given, which is what clients compare. R keeps today's behaviour. An unknown
  name stays `404` everywhere and is never a resource.
- The bundled authorization server accepts a `resource` indicator equal to R or to `R/<name>`
  (an exact match against that set, never a prefix), issues `aud` equal to the one requested, and a
  refresh keeps it. The resource server accepts a token whose `aud` is any member of the set **on
  every surface**: a profile changes only what is advertised, so the audience is one set of names for
  one resource, not a per-path binding, and scopes and folder ACLs apply identically everywhere.
- With an external authorization server (`auth.mode: jwt` and `auth.resource` with
  `auth.authorizationServers`, no `auth.audience`), the audience bound is that same set, so
  an RFC 8707 server that issues `aud` for the URL the client was given is accepted. An explicit
  `auth.audience` (and the `oidc` audience) is taken exactly as written: if your server issues per-URL
  audiences there, list them (`auth.audience` takes an array).
- An `auth.resource` that is itself a profile URL (`https://host/mcp/essentials`) is one profile's
  URL: its metadata is served at that path and nothing is derived from it. Prefer R = the bare `/mcp` URL.

See also [Scopes & Folder ACLs](/security/acls/) and
[HITL Elicitation](/security/hitl-elicit/).
