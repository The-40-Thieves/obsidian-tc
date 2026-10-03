// The root `network` block: connection policy shared by every outbound provider client (the
// inference gateway, embeddings, reranker, model tier, plur, the Obsidian bridge, telemetry). Leaf
// schema, same shape as gateway.schema.ts. The enforcement lives in server/src/gateway/plain-http.ts.
import { z } from "zod";
import { normalizePlainHttpHost } from "../net-host";

export const NetworkConfigSchema = z
  .object({
    plainHttpHosts: z
      .array(z.string())
      .default([])
      .describe(
        'Exact hostnames a plain http:// provider URL may name: gateway.baseUrl / OBSIDIAN_TC_GATEWAY_URL, embeddings.baseUrl, embeddings.modelTier.*.baseUrl, reranker.baseUrl, plur.endpoint, a vault\'s restApiUrl. Case-insensitive, IDNA/punycode-normalized; no wildcards, ports or paths. One list for all of them (the two TypeSafe judge blocks keep their own plainHttpHosts, which config load enforces). https:// and loopback need no entry. A listed host is still refused when a request is sent unless EVERY address it resolves to is loopback, RFC1918 (10/8, 172.16/12, 192.168/16) or IPv6 unique-local (fc00::/7): a public address, link-local, the 169.254.169.254 cloud metadata address and the other cloud metadata addresses (100.100.100.200, fd00:ec2::254, fd00:64:64:64::254, fd20:ce::254) are never allowed, listed or not. Requests go straight to that checked address (never through HTTP_PROXY / ALL_PROXY) with the original Host header, and redirects are refused (an https:// answer that redirects is refused too, so a 307/308 can never replay the key and vault text elsewhere). DEPRECATED, removed at the next major release: until then a host that is NOT listed but resolves only to private addresses still works, with a warning that names it (`obsidian-tc doctor` and `server_health` report it); list it here to silence the warning. Intended for a gateway on a host-local docker network or an encrypted overlay, e.g. `["litellm"]` for `http://litellm:4000`. The bearer key and vault text still travel in clear over that link.' +
          " A LISTED host may also resolve to the Tailscale/CGNAT range 100.64.0.0/10 (list only a host that is a tailnet peer: Tailscale traffic is WireGuard-encrypted, ISP CGNAT space is not); an unlisted host in that range is refused, with no deprecation path.",
      ),
  })
  .superRefine((c, ctx) => {
    c.plainHttpHosts.forEach((entry, i) => {
      if (normalizePlainHttpHost(entry) === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["plainHttpHosts", i],
          message: `network.plainHttpHosts entry ${JSON.stringify(entry)} is not an exact hostname — wildcards, ports, paths, userinfo and schemes are not accepted.`,
        });
      }
    });
  });
