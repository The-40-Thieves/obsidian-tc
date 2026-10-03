// egress.plain-http — every configured endpoint that would be sent over plain http://, with the
// address(es) its host resolves to right now and what the connect-time policy
// (gateway/plain-http.ts) will do with it:
//   allowed             loopback, or a listed host whose addresses are all private
//   allowed (listed tailnet/CGNAT)
//                       a listed host with at least one address in 100.64/10 and the rest private:
//                       the listing is the operator's statement that it is a tailnet peer (an
//                       unlisted host in that range is refused, never deprecated)
//   deprecated-unlisted a provider host that is NOT listed but resolves only to private addresses:
//                       works for one more release, refused from the next major
//   refused             a public / link-local / metadata address, an address that did not resolve,
//                       or (a TypeSafe judge block) a host that is not listed
// A plain-http request carries a bearer key and vault text in clear, so a host that has drifted onto
// a public address is visible here before the first request is refused. It also flags the
// deprecated `allowPlainHttp` flag. Resolution is a DNS lookup only: nothing is connected to.
//
// Two kinds of endpoint: the TypeSafe judge blocks, which list their own `plainHttpHosts` and refuse
// an unlisted host at config load, and every other provider client, which shares the root
// `network.plainHttpHosts` and keeps the deprecated unlisted-private path (provider-fetch.ts).

import { isIP } from "node:net";
import {
  classifyJudgeBaseUrl,
  isListedOnlyPrivateAddress,
  isLoopbackHost,
  isPlainHttpHostListed,
  isPrivateNetworkAddress,
  judgeBaseUrlHost,
  normalizeHostForBind,
} from "@the-40-thieves/obsidian-tc-shared";
import { resolveGatewayUrl } from "../gateway/client";
import type { ResolveHost } from "../gateway/plain-http";
import { unlistedPlainHttpMessage } from "../gateway/provider-fetch";
import type { Check, CheckStatus } from "./types";

export interface PlainHttpEndpointView {
  /** Config path of the block, e.g. "experiential.citationInfer.judge", "embeddings" or "wikiJudge". */
  field: string;
  baseUrl: string;
  /** The list that governs this endpoint: the block's own for a judge, `network.plainHttpHosts`
   *  for a provider. */
  plainHttpHosts?: readonly string[] | undefined;
  allowPlainHttp?: boolean | undefined;
  /** "provider" endpoints share `network.plainHttpHosts` and an unlisted private host still works
   *  (deprecated). Default "judge": an unlisted host is refused. */
  kind?: "judge" | "provider" | undefined;
}

export interface PlainHttpView {
  endpoints: readonly PlainHttpEndpointView[];
  resolveHost: ResolveHost;
}

export type PlainHttpStatus =
  | "allowed"
  | "allowed (listed tailnet/CGNAT)"
  | "deprecated-unlisted"
  | "refused";

export interface PlainHttpHostReport {
  field: string;
  host: string;
  /** Empty when the host did not resolve. */
  addresses: string[];
  status: PlainHttpStatus;
  /** Why, when the status is not "allowed" (names the host and the config to change). */
  reason?: string;
}

async function addressesOf(host: string, resolveHost: ResolveHost): Promise<string[] | undefined> {
  const bare = normalizeHostForBind(host);
  if (isIP(bare) !== 0) return [bare];
  try {
    const all = await resolveHost(bare);
    return all.map((a) => a.address);
  } catch {
    return undefined;
  }
}

function listField(ep: PlainHttpEndpointView): string {
  return ep.kind === "provider" ? "network.plainHttpHosts" : `${ep.field}.plainHttpHosts`;
}

/** The status of one plain-http endpoint. Mirrors gateway/plain-http.ts's decision on the same
 *  inputs, for a host name already resolved. */
export function classifyPlainHttpHost(
  ep: PlainHttpEndpointView,
  host: string,
  addrs: readonly string[],
): { status: PlainHttpStatus; reason?: string } {
  const loopback = isLoopbackHost(host);
  if (loopback) {
    const bad = addrs.find((a) => !isLoopbackHost(a));
    return bad === undefined
      ? { status: "allowed" }
      : {
          status: "refused",
          reason: `${ep.field}: ${host} resolves to ${bad}, which is not a loopback address; plain-http requests to it are refused`,
        };
  }
  if (addrs.length === 0) {
    return {
      status: "refused",
      reason: `${ep.field}: ${host} did not resolve, so every request to it will be refused`,
    };
  }
  const listed = ep.allowPlainHttp === true || isPlainHttpHostListed(host, ep.plainHttpHosts ?? []);
  // Tailscale / CGNAT (100.64/10) counts only for a LISTED host, exactly as in the transport.
  const bad = addrs.filter(
    (a) => !(isPrivateNetworkAddress(a) || (listed && isListedOnlyPrivateAddress(a))),
  );
  if (bad.length > 0) {
    // Listing helps only when it would admit EVERY refused address. With a public or metadata
    // answer alongside the CGNAT one the transport still refuses after listing, so the advice is
    // the plain refusal, never "list it".
    const cgnat = !listed && bad.every(isListedOnlyPrivateAddress);
    return {
      status: "refused",
      reason: cgnat
        ? `${ep.field}: ${host} resolves to ${bad.join(", ")}, a tailnet/CGNAT address; plain-http requests to it are refused unless the host is listed in ${listField(ep)} (list it only if it is a tailnet peer)`
        : `${ep.field}: ${host} resolves to ${bad.join(", ")}, which is not a private address (loopback, 10/8, 172.16/12, 192.168/16, fc00::/7, or a listed tailnet host in 100.64/10); plain-http requests to it are refused, listed or not: use https://`,
    };
  }
  if (listed) {
    return addrs.some((a) => !isPrivateNetworkAddress(a))
      ? { status: "allowed (listed tailnet/CGNAT)" }
      : { status: "allowed" };
  }
  if (ep.kind === "provider") {
    return {
      status: "deprecated-unlisted",
      reason: `${ep.field}: ${unlistedPlainHttpMessage(host, addrs.join(", "))}`,
    };
  }
  return {
    status: "refused",
    reason: `${ep.field}: ${host} is not listed in ${listField(ep)}`,
  };
}

/** One report row per endpoint that uses plain http://, with DNS resolved through `resolveHost`. */
export async function plainHttpReports(view: PlainHttpView): Promise<PlainHttpHostReport[]> {
  const out: PlainHttpHostReport[] = [];
  for (const ep of view.endpoints) {
    const cls = classifyJudgeBaseUrl(ep.baseUrl);
    if (cls !== "http-remote" && cls !== "http-loopback") continue;
    const host = judgeBaseUrlHost(ep.baseUrl) ?? "?";
    const resolved = await addressesOf(host, view.resolveHost);
    // `localhost` with no answer means 127.0.0.1 to the transport (resolveLoopbackTarget).
    const addresses =
      resolved && resolved.length > 0 ? resolved : cls === "http-loopback" ? ["127.0.0.1"] : [];
    const { status, reason } = classifyPlainHttpHost(ep, host, addresses);
    out.push({
      field: ep.field,
      host,
      addresses,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return out;
}

interface JudgeBlockView {
  provider?: string | undefined;
  baseUrl?: string | undefined;
  plainHttpHosts?: readonly string[] | undefined;
  allowPlainHttp?: boolean | undefined;
}

/** The slice of the loaded config the plain-http endpoint list reads. Every part is optional so a
 *  partial config (a test, server_health's boot wiring) can be passed as it stands. */
export interface PlainHttpConfigView {
  experiential?: { citationInfer?: { judge?: JudgeBlockView | undefined } | undefined } | undefined;
  wikiJudge?: JudgeBlockView | undefined;
  network?: { plainHttpHosts?: readonly string[] | undefined } | undefined;
  gateway?: { baseUrl?: string | undefined } | undefined;
  embeddings?:
    | {
        provider?: string | undefined;
        baseUrl?: string | undefined;
        modelTier?:
          | {
              dense?: { baseUrl?: string | undefined } | undefined;
              full?: { baseUrl?: string | undefined } | undefined;
            }
          | undefined;
      }
    | undefined;
  reranker?: { provider?: string | undefined; baseUrl?: string | undefined } | undefined;
  plur?: { endpoint?: string | undefined } | undefined;
  vaults?: readonly { id: string; restApiUrl?: string | undefined }[] | undefined;
}

/** The configured TypeSafe judge blocks (only a block whose provider is "typesafe" sends anything
 *  to its baseUrl) and every provider client's baseUrl, as plain-http endpoint views. */
export function plainHttpEndpoints(cfg: PlainHttpConfigView): PlainHttpEndpointView[] {
  const cj = cfg.experiential?.citationInfer?.judge;
  const hosts = cfg.network?.plainHttpHosts ?? [];
  const provider = (field: string, baseUrl: string | undefined): PlainHttpEndpointView[] =>
    baseUrl === undefined || baseUrl === ""
      ? []
      : [{ field, baseUrl, plainHttpHosts: hosts, kind: "provider" }];
  const judge = (field: string, b: JudgeBlockView | undefined): PlainHttpEndpointView[] =>
    b?.provider === "typesafe" && b.baseUrl !== undefined
      ? [{ ...b, field, baseUrl: b.baseUrl }]
      : [];
  const emb = cfg.embeddings;
  const embProvider = emb?.provider ?? "local";
  const rrProvider = cfg.reranker?.provider;
  const usesModelTier = embProvider === "model-tier" || rrProvider === "model-tier";
  const gatewayUrl = resolveGatewayUrl(cfg.gateway?.baseUrl);
  return [
    ...judge("experiential.citationInfer.judge", cj),
    ...judge("wikiJudge", cfg.wikiJudge),
    ...provider(cfg.gateway?.baseUrl ? "gateway.baseUrl" : "OBSIDIAN_TC_GATEWAY_URL", gatewayUrl),
    // `local` and `module` embedders never send to baseUrl; model-tier reads modelTier.* instead.
    ...(["local", "module", "model-tier"].includes(embProvider)
      ? []
      : provider("embeddings.baseUrl", emb?.baseUrl)),
    ...(usesModelTier
      ? [
          ...provider("embeddings.modelTier.dense.baseUrl", emb?.modelTier?.dense?.baseUrl),
          ...provider("embeddings.modelTier.full.baseUrl", emb?.modelTier?.full?.baseUrl),
        ]
      : []),
    ...(rrProvider !== undefined &&
    !["model-tier", "local", "module", "gateway"].includes(rrProvider)
      ? provider("reranker.baseUrl", cfg.reranker?.baseUrl)
      : []),
    ...provider("plur.endpoint", cfg.plur?.endpoint),
    ...(cfg.vaults ?? []).flatMap((v) => provider(`vaults[${v.id}].restApiUrl`, v.restApiUrl)),
  ];
}

/** The deprecation line for one block, shared with server_health. */
export function allowPlainHttpDeprecation(field: string): string {
  return `${field}.allowPlainHttp is deprecated and will be removed in the next major release: list the exact host in ${field}.plainHttpHosts instead`;
}

/** Deprecation lines for the config alone: every TypeSafe judge block that still sets
 *  `allowPlainHttp`. No I/O, no host names. What server_health reports first; the per-endpoint
 *  advice (which needs DNS) is `plainHttpEndpointDeprecations`. */
export function plainHttpDeprecations(cfg: PlainHttpConfigView): string[] {
  const out: string[] = [];
  const cj = cfg.experiential?.citationInfer?.judge;
  if (cj?.provider === "typesafe" && cj.allowPlainHttp) {
    out.push(allowPlainHttpDeprecation("experiential.citationInfer.judge"));
  }
  if (cfg.wikiJudge?.provider === "typesafe" && cfg.wikiJudge.allowPlainHttp) {
    out.push(allowPlainHttpDeprecation("wikiJudge"));
  }
  return out;
}

/** Per-endpoint advice for every provider client whose plain-http endpoint the transport does not
 *  simply allow, from the SAME resolver and the SAME classification the doctor check uses
 *  (`classifyPlainHttpHost`), so it can never advise what the transport then refuses or, worse,
 *  advise listing a host the transport would then send to:
 *    - resolves only to RFC1918 / ULA, not listed: told to list it (works today, refused from the
 *      next major release);
 *    - resolves to 100.64/10, not listed: refused; list it ONLY if it is a tailnet peer;
 *    - resolves to anything else (public, link-local, metadata, did not resolve): refused, use https.
 *  Names hosts, addresses and vault ids: server_health shows it only to a caller that may see every
 *  vault. Resolves each host once, bounded by `timeoutMs` (a timeout reads as "did not resolve"). */
export async function plainHttpEndpointDeprecations(
  cfg: PlainHttpConfigView,
  resolveHost: ResolveHost,
  timeoutMs = 3_000,
): Promise<string[]> {
  const bounded: ResolveHost = (host) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs);
      resolveHost(host).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  const endpoints = plainHttpEndpoints(cfg).filter((ep) => ep.kind === "provider");
  const reports = await plainHttpReports({ endpoints, resolveHost: bounded });
  return reports.flatMap((r) =>
    (r.status === "deprecated-unlisted" || r.status === "refused") && r.reason !== undefined
      ? [r.reason]
      : [],
  );
}

export function plainHttpCheck(view: PlainHttpView): Check {
  return {
    id: "egress.plain-http",
    category: "config",
    run: async () => {
      const issues: string[] = [];
      for (const ep of view.endpoints) {
        if (ep.allowPlainHttp) issues.push(allowPlainHttpDeprecation(ep.field));
      }
      const reports = await plainHttpReports(view);
      const lines = reports.map(
        (r) =>
          `${r.field}: ${r.host} -> ${r.addresses.length > 0 ? r.addresses.join(", ") : "(did not resolve)"} [${r.status}]`,
      );
      for (const r of reports) if (r.reason !== undefined) issues.push(r.reason);
      const status: CheckStatus = issues.length > 0 ? "warning" : "ok";
      const remote = reports.filter((r) => !isLoopbackHost(r.host)).length;
      return {
        status,
        summary:
          reports.length === 0
            ? "plain http: no configured endpoint uses plain http://"
            : remote === 0
              ? `plain http: ${reports.length} loopback endpoint(s), nothing leaves this machine`
              : `plain http: ${remote} endpoint(s) send the key and vault text in clear`,
        ...(lines.length > 0 ? { details: { endpoints: lines } } : {}),
        ...(issues.length > 0
          ? {
              issues,
              remediation:
                "Use https://, or list the exact hostname in network.plainHttpHosts (a TypeSafe judge block: <block>.plainHttpHosts) and make sure it resolves only to private addresses (a Docker bridge such as 172.18.0.0/16, an RFC1918 LAN, or an encrypted overlay). Public and link-local (169.254/16, the cloud metadata range) addresses are never allowed.",
            }
          : {}),
      };
    },
  };
}
