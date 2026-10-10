// public-url.* (doctor) — can a hosted MCP client (claude.ai, ChatGPT, Gemini Enterprise, grok.com,
// Le Chat, Copilot Studio) actually use `auth.resource` from the vendor's cloud? It probes the URL the
// way those clients do: public DNS with an IPv4 A record, a publicly trusted certificate, a 401 whose
// WWW-Authenticate carries resource_metadata, the PRM document naming this exact URL, the
// authorization server's metadata, and no redirect to another host along the way. One probe run feeds
// six checks (ids below) so each verdict reads on its own. Opt-in (`doctor --probe`), network only,
// short deadlines, and nothing here throws. The fix for each verdict is a section of the deploy recipe
// (docs/src/content/docs/deployment/hosted-clients.md).
import { isIP } from "node:net";
import { isLoopbackHost, isPrivateNetworkAddress } from "@the-40-thieves/obsidian-tc-shared";
import { sameResource } from "../auth/as-clients";
import {
  PUBLIC_URL_TIMEOUT_MS,
  type PublicUrlDeps,
  PublicUrlRequestError,
  type PublicUrlResponse,
  type PublicUrlView,
} from "./public-url-http";
import type { Check, CheckResult, CheckStatus } from "./types";

export type { PublicUrlDeps, PublicUrlView } from "./public-url-http";

export const PUBLIC_URL_DOC = "https://obsidian-tc.the40thieves.io/deployment/hosted-clients/";
const CERT_WARN_MS = 14 * 86_400_000;
const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "obsidian-tc-doctor", version: "0" },
  },
});

const SUB_IDS = ["dns", "tls", "redirects", "challenge", "prm", "as-metadata"] as const;
type SubId = (typeof SUB_IDS)[number];
type Level = "pass" | "warn" | "fail";
interface Finding {
  level: Level;
  summary: string;
  /** Doc anchor (a heading in the recipe) plus the one-line fix. */
  fix?: { anchor: string; text: string };
  details?: Record<string, string | string[]>;
}
type Findings = Record<SubId, Finding>;

const STATUS: Record<Level, CheckStatus> = { pass: "ok", warn: "warning", fail: "fail" };
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown): string =>
  e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : "";
const notChecked = (why: string): Finding => ({ level: "warn", summary: `not checked: ${why}` });
const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();

/** Certificate-verification failures: the host answered but its certificate cannot be trusted. */
const isCertError = (code: string): boolean =>
  /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)|HOSTNAME_MISMATCH|^ERR_(TLS|SSL)/.test(code);

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PublicUrlRequestError("ETIMEDOUT", `${what} timed out after ${ms} ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Not a public URL: a loopback or private host cannot be reached from a vendor cloud. */
function nonPublicHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return isLoopbackHost(bare) || (isIP(bare) !== 0 && isPrivateNetworkAddress(bare));
}

async function probeDns(host: string, d: PublicUrlDeps, ms: number): Promise<Finding> {
  const lookup = async (fn: (h: string) => Promise<string[]>): Promise<string[]> => {
    try {
      return await withDeadline(
        Promise.resolve().then(() => fn(host)),
        ms,
        `DNS lookup of ${host}`,
      );
    } catch {
      return [];
    }
  };
  const kind = isIP(host);
  const [a, aaaa] =
    kind === 4
      ? [[host], []]
      : kind === 6
        ? [[], [host]]
        : await Promise.all([lookup(d.resolve4), lookup(d.resolve6)]);
  const details = { a, aaaa };
  if (a.length > 0) return { level: "pass", summary: `${host} -> ${a.join(", ")} (IPv4)`, details };
  return {
    level: "fail",
    summary:
      aaaa.length > 0
        ? `${host} has only AAAA records (${aaaa.join(", ")}) and no IPv4 A record`
        : `${host} has no A or AAAA record`,
    fix: {
      anchor: "public-ipv4-address",
      text: "Anthropic's outbound range (160.79.104.0/21) is IPv4-only, so the host needs an IPv4 A record that is publicly resolvable.",
    },
    details,
  };
}

function tlsFinding(host: string, e: unknown): Finding {
  const code = codeOf(e);
  return isCertError(code)
    ? {
        level: "fail",
        summary: `${host} presents a certificate that is not publicly trusted (${code}: ${msg(e)})`,
        fix: {
          anchor: "publicly-trusted-certificate",
          text: "Gemini Enterprise and the other hosted clients reject self-signed or private-CA certificates: terminate TLS with a public CA (Cloudflare or Let's Encrypt).",
        },
      }
    : {
        level: "fail",
        summary: `could not complete a TLS connection to ${host} (${code || "error"}: ${msg(e)})`,
        fix: {
          anchor: "public-ipv4-address",
          text: "Check that the public hostname routes to the server (tunnel ingress or reverse proxy) and that port 443 is reachable from outside.",
        },
      };
}

/** `resource_metadata="..."` (or the bare token form) from a WWW-Authenticate value. */
function resourceMetadataOf(challenge: string | undefined): string | undefined {
  return /resource_metadata=(?:"([^"]+)"|([^\s,]+))/i
    .exec(challenge ?? "")
    ?.slice(1)
    .find(Boolean);
}

/** The RFC 8414 location (well-known inserted before the issuer path), then OIDC discovery. */
function asMetadataUrls(as: string): string[] {
  const u = new URL(as);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

const parseObject = (res: PublicUrlResponse): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(res.body);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

async function probe(resource: string, d: PublicUrlDeps): Promise<Findings> {
  const u = new URL(resource);
  const host = u.hostname.toLowerCase();
  const ms = d.timeoutMs ?? PUBLIC_URL_TIMEOUT_MS;
  const now = d.now ?? Date.now;
  const crossHost: string[] = [];
  const sameHost: string[] = [];
  let requests = 0;

  const get = async (
    url: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: string,
  ): Promise<PublicUrlResponse> => {
    requests += 1;
    const res = await withDeadline(
      Promise.resolve().then(() =>
        d.request({ url, method, headers, ...(body === undefined ? {} : { body }) }),
      ),
      ms,
      url,
    );
    const location = res.status >= 300 && res.status < 400 ? res.headers.location : undefined;
    if (location !== undefined) {
      let target: URL | undefined;
      try {
        target = new URL(location, url);
      } catch {
        target = undefined;
      }
      const line = `${hostOf(url)}${new URL(url).pathname} -> ${res.status} ${location}`;
      (target !== undefined && target.hostname.toLowerCase() !== hostOf(url)
        ? crossHost
        : sameHost
      ).push(line);
    }
    return res;
  };

  const out: Partial<Findings> = {};
  out.dns = await probeDns(host, d, ms);

  // 1. The MCP endpoint with no credentials: TLS verdict, redirect, challenge.
  let mcp: PublicUrlResponse | undefined;
  if (u.protocol !== "https:") {
    out.tls = {
      level: "fail",
      summary: `auth.resource is ${u.protocol.replace(":", "")}://, hosted clients require https`,
      fix: {
        anchor: "publicly-trusted-certificate",
        text: "Serve the endpoint over https with a public CA certificate.",
      },
    };
  } else {
    try {
      mcp = await get(
        resource,
        "POST",
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        INIT_BODY,
      );
      const left = mcp.certValidTo === undefined ? undefined : mcp.certValidTo - now();
      out.tls =
        left !== undefined && left < CERT_WARN_MS
          ? {
              level: "warn",
              summary: `certificate for ${host} expires in ${Math.max(0, Math.floor(left / 86_400_000))} day(s)`,
              fix: {
                anchor: "publicly-trusted-certificate",
                text: "Renew it; a lapsed certificate drops every hosted client at once.",
              },
            }
          : {
              level: "pass",
              summary: `${host} presents a certificate trusted by the system store`,
            };
    } catch (e) {
      out.tls = tlsFinding(host, e);
    }
  }

  let prmUrl: string | undefined;
  if (mcp === undefined) {
    out.challenge = notChecked("the endpoint could not be reached over verified TLS");
  } else if (mcp.status === 401) {
    prmUrl = resourceMetadataOf(mcp.headers["www-authenticate"]);
    out.challenge =
      prmUrl === undefined
        ? {
            level: "fail",
            summary:
              "401 without resource_metadata in WWW-Authenticate: clients cannot discover the authorization server",
            fix: {
              anchor: "challenge-and-discovery-documents",
              text: "Set auth.resource and auth.authorizationServers (the pointer is only sent once the document is complete), and make sure the proxy passes WWW-Authenticate through.",
            },
          }
        : { level: "pass", summary: `401 with resource_metadata ${prmUrl}` };
  } else {
    out.challenge = {
      level: "fail",
      summary:
        mcp.status >= 300 && mcp.status < 400
          ? `the endpoint redirected (${mcp.status}) instead of answering 401`
          : `the endpoint answered ${mcp.status} without credentials, expected 401`,
      fix: {
        anchor:
          mcp.status >= 300 && mcp.status < 400
            ? "no-cross-host-redirects"
            : "challenge-and-discovery-documents",
        text: "An unauthenticated request must reach the server and get 401 with a WWW-Authenticate challenge: check the tunnel ingress or proxy route for this path.",
      },
    };
  }

  // 2. The PRM document the challenge points at.
  let asUrl: string | undefined;
  if (prmUrl === undefined) {
    out.prm = notChecked("no resource_metadata pointer to follow");
  } else {
    try {
      const res = await get(prmUrl, "GET", { accept: "application/json" });
      const doc = res.status === 200 ? parseObject(res) : undefined;
      const servers = Array.isArray(doc?.authorization_servers)
        ? doc.authorization_servers.filter((s): s is string => typeof s === "string")
        : [];
      const advertised = typeof doc?.resource === "string" ? doc.resource : undefined;
      if (doc === undefined) {
        out.prm = {
          level: "fail",
          summary: `${prmUrl} answered ${res.status}, not a JSON document`,
          fix: {
            anchor: "challenge-and-discovery-documents",
            text: "The PRM route must be reachable on the public host and return JSON.",
          },
        };
      } else if (advertised === undefined || !sameResource(advertised, resource)) {
        out.prm = {
          level: "fail",
          summary: `PRM resource ${advertised ?? "(missing)"} does not equal the URL ${resource}`,
          fix: {
            anchor: "challenge-and-discovery-documents",
            text: "Clients compare the two exactly: set auth.resource to the public URL you give them (scheme, host, path).",
          },
        };
      } else if (servers.length === 0) {
        out.prm = {
          level: "fail",
          summary: "PRM lists no authorization_servers",
          fix: {
            anchor: "challenge-and-discovery-documents",
            text: "Set auth.authorizationServers (or enable auth.as).",
          },
        };
      } else {
        asUrl = servers[0];
        out.prm = {
          level: "pass",
          summary: `PRM resource equals the URL; authorization server ${asUrl}`,
          details: { authorizationServers: servers },
        };
      }
    } catch (e) {
      out.prm = {
        level: "fail",
        summary: `could not fetch ${prmUrl}: ${msg(e)}`,
        fix: {
          anchor: "challenge-and-discovery-documents",
          text: "The PRM URL must be reachable from the internet over verified TLS.",
        },
      };
    }
  }

  // 3. The authorization server's metadata (RFC 8414, then OpenID discovery).
  if (asUrl === undefined) {
    out["as-metadata"] = notChecked("no authorization server to look up");
  } else {
    const tried: string[] = [];
    let meta: Record<string, unknown> | undefined;
    let failure = "";
    for (const url of asMetadataUrls(asUrl)) {
      try {
        const res = await get(url, "GET", { accept: "application/json" });
        tried.push(`${url} -> ${res.status}`);
        meta = res.status === 200 ? parseObject(res) : undefined;
        if (meta !== undefined) break;
      } catch (e) {
        failure = msg(e);
        tried.push(`${url} -> ${failure}`);
      }
    }
    const trim = (s: string) => s.replace(/\/+$/, "");
    const endpoint = (k: string): string | undefined =>
      typeof meta?.[k] === "string" && (meta[k] as string).startsWith("https://")
        ? (meta[k] as string)
        : undefined;
    if (meta === undefined) {
      out["as-metadata"] = {
        level: "fail",
        summary: `no authorization-server metadata for ${asUrl}`,
        fix: {
          anchor: "challenge-and-discovery-documents",
          text: "Serve /.well-known/oauth-authorization-server (or openid-configuration) on the authorization server's public host.",
        },
        details: { tried },
      };
    } else if (typeof meta.issuer !== "string" || trim(meta.issuer) !== trim(asUrl)) {
      out["as-metadata"] = {
        level: "fail",
        summary: `metadata issuer ${String(meta.issuer)} is not the authorization server URL ${asUrl}`,
        fix: {
          anchor: "challenge-and-discovery-documents",
          text: "Clients reject a metadata issuer that differs from the URL it was fetched for.",
        },
        details: { tried },
      };
    } else if (
      endpoint("authorization_endpoint") === undefined ||
      endpoint("token_endpoint") === undefined
    ) {
      out["as-metadata"] = {
        level: "fail",
        summary: "metadata lacks an https authorization_endpoint or token_endpoint",
        fix: {
          anchor: "challenge-and-discovery-documents",
          text: "Both endpoints are needed for the authorization-code flow.",
        },
        details: { tried },
      };
    } else {
      const domains = [
        ...new Set([
          host,
          hostOf(endpoint("authorization_endpoint") as string),
          hostOf(endpoint("token_endpoint") as string),
        ]),
      ];
      out["as-metadata"] = {
        level: "pass",
        summary: `issuer ${asUrl} with authorization and token endpoints`,
        fix: {
          anchor: "egress-allowlists",
          text: `Gemini Enterprise's egress allowlist needs: ${domains.join(", ")}.`,
        },
        details: { allowlistDomains: domains },
      };
    }
  }

  out.redirects =
    crossHost.length > 0
      ? {
          level: "fail",
          summary: `${crossHost.length} response(s) redirect to another host: ${crossHost.join("; ")}`,
          fix: {
            anchor: "no-cross-host-redirects",
            text: "Hosted clients do not follow a redirect off the host they were given: serve the endpoint, PRM and metadata on the canonical host.",
          },
          details: { redirects: crossHost },
        }
      : sameHost.length > 0
        ? {
            level: "warn",
            summary: `${sameHost.length} response(s) redirect within the host: ${sameHost.join("; ")}`,
            fix: {
              anchor: "no-cross-host-redirects",
              text: "Some clients drop the method or body on a redirect: remove the trailing-slash or scheme rewrite in front of the server.",
            },
            details: { redirects: sameHost },
          }
        : { level: "pass", summary: `none of ${requests} request(s) redirected` };
  return out as Findings;
}

function asResult(id: SubId, f: Finding): CheckResult {
  return {
    status: STATUS[f.level],
    summary: `public-url.${id}: ${f.summary}`,
    ...(f.details === undefined ? {} : { details: f.details }),
    ...(f.fix === undefined
      ? {}
      : { remediation: `${f.fix.text} See ${PUBLIC_URL_DOC}#${f.fix.anchor}` }),
    ...(f.level === "pass" ? {} : { issues: [f.summary] }),
  };
}

const single = (result: CheckResult): Check[] => [
  { id: "public-url", category: "network", run: () => result },
];

/** The public-URL checks for `view`. Without a URL, or without `--probe`, or for a non-public host,
 *  one `public-url` check says so and does no I/O. Otherwise one check per verdict. */
export function publicUrlChecks(view: PublicUrlView): Check[] {
  const resource = view.resource;
  if (resource === undefined || resource === "") {
    return single({ status: "ok", summary: "public-url: skipped, no auth.resource configured" });
  }
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return single({
      status: "fail",
      summary: "public-url: auth.resource is not a valid URL",
      issues: [resource],
    });
  }
  if (nonPublicHost(u.hostname)) {
    return single({
      status: "ok",
      summary: `public-url: skipped, ${u.hostname} is not a public host`,
    });
  }
  const d = view.probe;
  if (d === undefined) {
    return single({
      status: "ok",
      summary: `public-url: ${resource} not probed (run doctor --probe)`,
    });
  }
  let memo: Promise<Findings> | undefined;
  const once = (): Promise<Findings> =>
    (memo ??= probe(resource, d).catch((e: unknown) => {
      const f: Finding = { level: "fail", summary: `probe failed unexpectedly: ${msg(e)}` };
      return Object.fromEntries(SUB_IDS.map((id) => [id, f])) as Findings;
    }));
  return SUB_IDS.map((id) => ({
    id: `public-url.${id}`,
    category: "network",
    run: async () => asResult(id, (await once())[id]),
  }));
}
