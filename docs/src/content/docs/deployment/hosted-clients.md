---
title: Hosted clients (public URL recipe)
description: What claude.ai, ChatGPT, Gemini Enterprise, grok.com, Le Chat, Copilot Studio and the API connectors need from the public URL, with cloudflared, nginx and Caddy recipes and the doctor probe that checks them.
---

Hosted MCP surfaces call your server **from the vendor's cloud**, not from your machine. A server
that works from a laptop on the same network can still fail every one of them. This page lists what
they need, how to put a Cloudflare tunnel, nginx or Caddy in front of the server without breaking
it, and how `obsidian-tc doctor --probe` checks the result.

Run the server over HTTP first (see [Deployment](/deployment/) and
[Authentication](/security/auth-model/)), set `auth.resource` to the public URL clients are given
(for example `https://vault.example.com/mcp`), and keep the server itself bound to loopback.

## What hosted clients need

### Public IPv4 address

The vendor reaches the hostname over the public internet, so it must resolve publicly. Anthropic
publishes its outbound range as IPv4 only (`160.79.104.0/21`, no IPv6 outbound range is listed), so
the hostname needs an **A record**. A host with only an AAAA record is unreachable from Claude.
A proxied Cloudflare hostname (which a tunnel hostname is) answers with IPv4 and IPv6 addresses; a
DNS-only record you manage yourself needs the A record added explicitly.

### Publicly trusted certificate

The URL must be `https://` with a certificate from a publicly trusted CA. Gemini Enterprise states
that self-signed certificates are not supported, for public and private servers alike. A tunnel or
proxy that terminates TLS with a public CA (Cloudflare, Let's Encrypt via Caddy or certbot) is
enough; a private CA or a Tailscale-only certificate is not, and nothing you configure on your own
machines changes what the vendor's cloud accepts.

### No cross-host redirects

Serve the MCP endpoint, the Protected Resource Metadata (PRM) document and the authorization-server
metadata on the host you gave the client. Hosted clients do not follow a redirect to another host
(an `http` to `https` bounce, an apex to `www` redirect, a login page on a different domain in
front of the discovery documents). A same-host redirect such as a trailing-slash rewrite is also
worth removing: some clients drop the method or body when they follow it.

### Challenge and discovery documents

An unauthenticated `POST` to the MCP URL must reach the server and get `401` with
`WWW-Authenticate: Bearer ... resource_metadata="<PRM URL>"`. That pointer is sent only when
`auth.resource` and an authorization server (`auth.authorizationServers`, or the bundled `auth.as`)
are both configured. The PRM document's `resource` must equal the URL the client was given exactly,
and the authorization server's metadata (`/.well-known/oauth-authorization-server`, or OpenID
`openid-configuration`) must carry an `issuer` equal to the URL it was fetched for. Make sure the
proxy forwards the `WWW-Authenticate` header and the `/.well-known/` paths.

### Egress allowlists

Gemini Enterprise controls egress for custom MCP servers with organization-policy constraints, not
by source IP: its page lists none. When VPC Service Controls or project enforcement is on, add the
**domain names** (not full URLs) of the MCP server URL, the authorization URL and the token URL to
`allowedEgressFqdns`, and the custom MCP data source type to `allowedDataSources`. For a server on
`vault.example.com` with the bundled authorization server, that is the one host; with an external
IdP it is the server host plus the IdP's authorization and token hosts. `doctor --probe` prints the
list it derived from your authorization-server metadata (`allowlistDomains`).

### Streaming without buffering

Streamable HTTP answers a `POST` with either one JSON body or a Server-Sent Events (SSE) stream. A
proxy that buffers the response holds the first events back until the stream ends or a buffer
fills, which looks like a hung tool call. Everything in front of the server (a tunnel, nginx,
Caddy, a CDN) must pass the response through as it is produced and must not time out an idle stream
sooner than the longest tool call.

## Per-surface checklist

"Yes" means the requirement applies; the egress column says what the vendor documents. Rows marked
*not checked* were not verified against vendor documentation for this page: look at the vendor's
current connector documentation before relying on them.

| Surface | Calls from | Public HTTPS, trusted CA | A record | No cross-host redirect | Registration it supports | Vendor egress documentation |
| --- | --- | --- | --- | --- | --- | --- |
| claude.ai and the Claude apps (custom connector) | Anthropic cloud | Yes | **Yes**: outbound range `160.79.104.0/21` is IPv4 only | Yes | Dynamic Client Registration (DCR) and client metadata documents | Published range, see below |
| Claude API MCP connector | Anthropic cloud | Yes | **Yes** (same range) | Yes | Static bearer in `authorization_token` | Published range, see below |
| ChatGPT (apps and connectors) | OpenAI cloud | Yes | Yes | Yes | OAuth (DCR or metadata documents), no header option | Not checked |
| Gemini Enterprise | Google Cloud | **Yes, and self-signed is rejected** | Yes | Yes | OAuth with a pre-registered client | Domain allowlist (above); no static IPs documented |
| Gemini app | Google cloud | Yes | Yes | Yes | DCR only | Not checked |
| grok.com | xAI cloud | Yes | Yes | Yes | DCR only; needs the `401` on `tools/list` (keep `auth.anonymousDiscovery: none`) | Not checked |
| Le Chat | Mistral cloud | Yes | Yes | Yes | DCR only | Not checked |
| Copilot Studio | Microsoft cloud | Yes | Yes | Yes | API-key header option | Not checked |

Sources, fetched 2026-10-10:

- Anthropic, [IP addresses](https://platform.claude.com/docs/en/api/ip-addresses): outbound requests
  such as MCP tool calls come from `160.79.104.0/21` (IPv4); the previously published `34.162.x.x`
  addresses are phased out. Re-read the page before allowlisting: the range is the vendor's to change.
- Google, [Set up your custom MCP server data store](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server)
  (page updated 2026-10-07): Streamable HTTP only, an `https` URL, a certificate from a publicly
  trusted CA, `allowedEgressFqdns` / `allowedDataSources`, redirect URI
  `https://vertexaisearch.cloud.google.com/oauth-redirect`.

Which registration methods each surface supports, and where each puts a static token, is in
[Authentication](/security/auth-model/).

## Cloudflare tunnel

`cloudflared` runs next to the server and dials out to Cloudflare, so nothing listens on a public
port, the certificate is Cloudflare's (publicly trusted), and the hostname has A and AAAA records.

```yaml
# /etc/cloudflared/config.yml (locally managed tunnel)
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: vault.example.com
    service: http://127.0.0.1:3000
    originRequest:
      connectTimeout: 10s
      # Leave disableChunkedEncoding at its default (false): chunked transfer is how a
      # streamed response reaches the client.
  - service: http_status:404
```

- **Keep the Host header stable.** `httpHostHeader` defaults to empty, which forwards the public
  hostname unchanged. List that hostname in `transports.http.allowedHosts`. If you override
  `httpHostHeader` (to `localhost`, say), the server sees a different `Host` than the one clients
  use: add what it sees to `allowedHosts`, and never rely on it for URLs (`auth.resource` is the
  canonical origin and is never derived from a request).
- **Pass the response through unbuffered.** Do not set `disableChunkedEncoding: true` for this
  hostname. Cloudflare returns `524` when the origin sends nothing within its proxy read timeout
  (125 seconds by default), so a tool call that streams nothing for longer will be cut; send
  progress or keep calls shorter. Test with `curl -N` as shown below.
- **Trusted proxy setting.** cloudflared connects over loopback, and Cloudflare sets
  `CF-Connecting-IP` to the visitor's address:

  ```yaml
  transports:
    http:
      enabled: true
      host: 127.0.0.1
      port: 3000
      allowedHosts: [vault.example.com]
      trustedProxies: ["127.0.0.1", "::1"]
      forwardedHeader: cf-connecting-ip
  ```

  Without `trustedProxies`, every hosted client is counted as one unattributed source by the
  per-source limits (client metadata lookups, authorize admission, password-login failures). Full
  explanation: [Running behind a proxy or tunnel](/security/auth-model/#running-behind-a-proxy-or-tunnel).
- **The Cloudflare IP list caveat.** Behind a tunnel the TCP peer is `cloudflared` on loopback (or
  a docker bridge address if it runs in a container), **not** a Cloudflare edge address, so list
  that peer in `trustedProxies` and nothing else. Do not paste Cloudflare's published edge ranges
  into `trustedProxies`: that list changes over time (Cloudflare adds ranges to
  [cloudflare.com/ips](https://www.cloudflare.com/ips/) before using them), a stale copy silently
  stops matching, and a range you do not control is exactly what the setting warns against. The
  ranges matter only if you expose the origin port directly and accept Cloudflare-proxied traffic
  there; then restrict the port to them at the firewall, not in `trustedProxies`.
- **Cloudflare Access in front of the hostname breaks hosted clients**: the vendor cloud cannot
  complete an interactive login. Exempt the MCP, `.well-known` and OAuth paths, or authenticate
  with the server's own OAuth only.

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name vault.example.com;
    # ssl_certificate / ssl_certificate_key: a publicly trusted certificate (certbot, ACME, ...)

    location / {
        proxy_pass http://127.0.0.1:3000;

        # Streamable HTTP / SSE: pass events through as they are produced.
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;

        # An idle stream must outlive the longest tool call (default is 60s between reads).
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Stable Host, and the client address the server reads from a trusted proxy:
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name vault.example.com;
    # Only a redirect to the SAME host; never to another domain.
    return 301 https://$host$request_uri;
}
```

- `proxy_buffering off` is what turns buffering off for every response on the location.
  `X-Accel-Buffering: no` is the per-response form: nginx honours that header when the *upstream
  sends it*, and `proxy_ignore_headers X-Accel-Buffering` turns that off. It is not something you
  can add from the nginx side with `add_header` (that header goes to the client, after the buffering
  decision), so rely on `proxy_buffering off` here and do not assume the server sets the header.
- Without `proxy_http_version 1.1` nginx talks HTTP/1.0 to the upstream and cannot stream a chunked
  response; the empty `Connection` header keeps the upstream connection alive.
- `proxy_read_timeout` is the time between two reads, not the whole response, so a stream that keeps
  producing events never hits it.
- Keep the `X-Forwarded-For $remote_addr` overwrite shown here (not `$proxy_add_x_forwarded_for`)
  and list the proxy's address in `transports.http.trustedProxies` with
  `forwardedHeader: x-forwarded-for`.
- The `http` to `https` redirect on port 80 is fine (same host); a redirect to a different domain is not.

## Caddy

```caddyfile
vault.example.com {
    reverse_proxy 127.0.0.1:3000 {
        # Flush each write to the client immediately (-1), so SSE events are not held back.
        flush_interval -1
    }
}
```

Caddy obtains and renews a publicly trusted certificate by itself and passes the `Host` header
through unchanged. `flush_interval -1` is low-latency mode: no response buffering, a flush after
every write. Caddy already flushes at once for `text/event-stream` responses and when the content
length is unknown, but the explicit setting removes any doubt. Its upstream `read_timeout` and
`response_header_timeout` default to no timeout, so a long-idle stream is only cut by whatever sits
in front of Caddy (do not add a short `read_timeout` to the `transport http` block). Caddy overwrites `X-Forwarded-For` for a client it does not trust, so
list `127.0.0.1` and `::1` in `transports.http.trustedProxies` with the default
`forwardedHeader: x-forwarded-for`.

## Check it

From a machine outside your network (not the server itself):

```bash
curl -sS -i -X POST https://vault.example.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# expect: HTTP/2 401 and a www-authenticate header with resource_metadata="https://vault.example.com/..."
dig +short A vault.example.com        # must print an IPv4 address
```

To see whether a stream arrives unbuffered, send a request that streams (a tool call with a valid
token) with `curl -N` and watch whether events print as they are produced or all at once at the end.

On the server host, `obsidian-tc doctor --probe` runs the same checks from inside:

| Check id | Passes when |
| --- | --- |
| `public-url.dns` | the hostname has an IPv4 A record (AAAA-only fails) |
| `public-url.tls` | the certificate verifies against the system trust store (warns inside 14 days of expiry) |
| `public-url.challenge` | an unauthenticated `POST` to `auth.resource` gets `401` with `resource_metadata` |
| `public-url.prm` | the PRM document's `resource` equals `auth.resource` and it lists an authorization server |
| `public-url.as-metadata` | the authorization server's metadata is served and its `issuer` matches |
| `public-url.redirects` | no request redirected to another host (a same-host redirect warns) |

Without `--probe`, or when `auth.resource` is unset or names a loopback or private host, doctor
reports one skipped `public-url` check and makes no request. Each failing check names this page's
section that fixes it. The probe only makes requests when you run `doctor --probe` (no tool call
can start it), never follows a redirect, and refuses to fetch any host, including the ones it
reads from the PRM and the challenge, that is not https or resolves to a loopback, private,
link-local, CGNAT or otherwise non-public address; it connects to the address it validated. The probe runs from your server's network, so it cannot see a firewall that
only blocks the vendor's addresses, and it does not yet test SSE buffering (that needs a token and a
streaming tool).
