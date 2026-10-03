// egress.plain-http — every configured endpoint that would be sent over plain http://, with the
// address(es) its host resolves to right now. A plain-http request carries a bearer key and vault
// text in clear, and the connect-time policy (gateway/plain-http.ts) only lets it reach a listed
// host whose addresses are ALL private; this lists what that policy will see, so a host that has
// drifted onto a public address is visible before the first judge call is refused. It also flags
// the deprecated `allowPlainHttp` flag. Resolution is a DNS lookup only: nothing is connected to.

import { isIP } from "node:net";
import {
  classifyJudgeBaseUrl,
  isPlainHttpHostListed,
  isPrivateNetworkAddress,
  judgeBaseUrlHost,
  normalizeHostForBind,
} from "@the-40-thieves/obsidian-tc-shared";
import type { ResolveHost } from "../gateway/plain-http";
import type { Check, CheckStatus } from "./types";

export interface PlainHttpEndpointView {
  /** Config path of the block, e.g. "experiential.citationInfer.judge" or "wikiJudge". */
  field: string;
  baseUrl: string;
  plainHttpHosts?: readonly string[] | undefined;
  allowPlainHttp?: boolean | undefined;
}

export interface PlainHttpView {
  endpoints: readonly PlainHttpEndpointView[];
  resolveHost: ResolveHost;
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

/** The configured TypeSafe judge blocks as plain-http endpoint views (only a block whose provider
 *  is "typesafe" sends anything to its baseUrl). */
export function plainHttpEndpoints(cfg: {
  experiential: {
    citationInfer: {
      judge?:
        | {
            provider?: string | undefined;
            baseUrl: string;
            plainHttpHosts?: readonly string[] | undefined;
            allowPlainHttp?: boolean | undefined;
          }
        | undefined;
    };
  };
  wikiJudge: {
    provider?: string | undefined;
    baseUrl: string;
    plainHttpHosts?: readonly string[] | undefined;
    allowPlainHttp?: boolean | undefined;
  };
}): PlainHttpEndpointView[] {
  const cj = cfg.experiential.citationInfer.judge;
  return [
    ...(cj?.provider === "typesafe" ? [{ field: "experiential.citationInfer.judge", ...cj }] : []),
    ...(cfg.wikiJudge.provider === "typesafe" ? [{ field: "wikiJudge", ...cfg.wikiJudge }] : []),
  ];
}

/** The deprecation line for one block, shared with server_health. */
export function allowPlainHttpDeprecation(field: string): string {
  return `${field}.allowPlainHttp is deprecated and will be removed in the next major release: list the exact host in ${field}.plainHttpHosts instead`;
}

/** Deprecation lines for every TypeSafe judge block that still sets `allowPlainHttp`: what
 *  server_health reports, and what the doctor check above leads with. Config-only, no I/O. */
export function plainHttpDeprecations(cfg: {
  experiential?: {
    citationInfer?: { judge?: { provider?: string; allowPlainHttp?: boolean } | undefined };
  };
  wikiJudge?: { provider?: string; allowPlainHttp?: boolean };
}): string[] {
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

export function plainHttpCheck(view: PlainHttpView): Check {
  return {
    id: "egress.plain-http",
    category: "config",
    run: async () => {
      const lines: string[] = [];
      const issues: string[] = [];
      for (const ep of view.endpoints) {
        if (ep.allowPlainHttp) issues.push(allowPlainHttpDeprecation(ep.field));
        if (classifyJudgeBaseUrl(ep.baseUrl) !== "http-remote") continue;
        const host = judgeBaseUrlHost(ep.baseUrl) ?? "?";
        const listed =
          host !== "?" &&
          (ep.allowPlainHttp === true || isPlainHttpHostListed(host, ep.plainHttpHosts ?? []));
        const addrs = await addressesOf(host, view.resolveHost);
        if (addrs === undefined || addrs.length === 0) {
          lines.push(`${ep.field}: ${host} -> (did not resolve)`);
          issues.push(
            `${ep.field}: ${host} did not resolve, so every request to it will be refused`,
          );
          continue;
        }
        const bad = addrs.filter((a) => !isPrivateNetworkAddress(a));
        lines.push(
          `${ep.field}: ${host} -> ${addrs.join(", ")}${bad.length > 0 ? " (NOT PRIVATE)" : ""}`,
        );
        if (bad.length > 0) {
          issues.push(
            `${ep.field}: ${host} resolves to ${bad.join(", ")}, which is not a private address (loopback, 10/8, 172.16/12, 192.168/16, fc00::/7); plain-http requests to it are refused`,
          );
        }
        if (!listed) {
          issues.push(`${ep.field}: ${host} is not listed in ${ep.field}.plainHttpHosts`);
        }
      }
      const status: CheckStatus = issues.length > 0 ? "warning" : "ok";
      return {
        status,
        summary:
          lines.length === 0
            ? "plain http: no configured endpoint uses plain http://"
            : `plain http: ${lines.length} endpoint(s) send the key and vault text in clear`,
        ...(lines.length > 0 ? { details: { endpoints: lines } } : {}),
        ...(issues.length > 0
          ? {
              issues,
              remediation:
                "Use https://, or list the exact hostname in <block>.plainHttpHosts and make sure it resolves only to private addresses (a Docker bridge such as 172.18.0.0/16, an RFC1918 LAN, or an encrypted overlay). Link-local (169.254/16, the cloud metadata range) is never allowed.",
            }
          : {}),
      };
    },
  };
}
