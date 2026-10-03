// Where JWT mode's remote key set (`auth.jwksUri`) is allowed to be, and the one decision the fetch,
// the startup line, `doctor` and `server_health` all read. jose used to fetch it itself: resolve the
// name, then connect to the name again, so a record that flips in between (DNS rebinding) could
// point the request at a private or metadata address. The decision here resolves ONCE and the fetch
// connects only to the addresses it validated (createPinnedFetch, via fetchBoundedText's `target`).
//
// The rules are the provider rules (gateway/plain-http.ts, `network.plainHttpHosts`), plus the OIDC
// default for a public host:
//   public            https, and every answer a public address. The default.
//   loopback          a loopback host (literal or name): no entry needed, http or https.
//   private-listed    the exact host is listed in `network.plainHttpHosts` and every answer is
//                     loopback / RFC1918 / unique-local, or 100.64/10 (a listed host is the
//                     operator's statement that it is a tailnet peer). http or https.
//   private-unlisted  the same addresses, host NOT listed: still works for ONE release with a
//                     deprecation (an existing config with an http or LAN key set), refused after.
// Everything else is refused, listed or not: plain http to a public host (a key set read in clear
// can be forged in transit), a public/private mix, link-local, and every cloud metadata address.
import { isIP } from "node:net";
import {
  isLoopbackHost,
  isPlainHttpHostListed,
  normalizeHostForBind,
} from "@the-40-thieves/obsidian-tc-shared";
import {
  defaultResolveHost,
  PlainHttpRefusedError,
  type ResolvedAddress,
  type ResolveHost,
  resolveLoopbackTarget,
  resolvePlainHttpTarget,
} from "../gateway/plain-http";
import { OidcFetchError } from "./oidc-discovery";
import { isBlockedAddress } from "./oidc-network";

export type JwksFetchMode = "public" | "loopback" | "private-listed" | "private-unlisted";

export interface JwksNetworkPolicy {
  /** `network.plainHttpHosts`. A function is read per fetch, so a verifier built before the config
   *  is final still follows it. */
  plainHttpHosts: readonly string[] | (() => readonly string[]);
  /** Test seam: the addresses a host resolves to. Defaults to the system resolver. */
  resolveHost?: ResolveHost | undefined;
  /** Where the once-per-host deprecation goes. Default: stderr. */
  warn?: ((message: string) => void) | undefined;
}

export interface JwksTarget {
  host: string;
  secure: boolean;
  mode: JwksFetchMode;
  /** Every address the host resolved to, all of which passed: the pinned transport tries them in order. */
  addresses: ResolvedAddress[];
}

/** The deprecation for an unlisted private key-set host. Names the host and the config to add and
 *  never the path or query (a key-set URL can carry a credential). One definition for the fetch, the
 *  startup line, the doctor and server_health. */
export function unlistedJwksMessage(host: string, secure: boolean, addresses?: string): string {
  const quoted = JSON.stringify(host);
  return (
    `auth.jwksUri host ${host}${addresses === undefined ? "" : ` (${addresses})`} is fetched only because it resolves to a private address; ` +
    `add ${quoted} to network.plainHttpHosts (network: { plainHttpHosts: [${quoted}] }) to keep it working. ` +
    `An unlisted private-network key-set host is refused from the next major release.${secure ? "" : " It is fetched over plain http, so anyone on the path can forge the keys."}`
  );
}

const refuse = (message: string): never => {
  throw new OidcFetchError(`JWKS fetch refused: ${message}`);
};

/**
 * Decide whether `url` may be fetched and return the validated addresses to connect to.
 * @throws OidcFetchError (a refusal: the message names the host and address, never the path).
 */
export async function resolveJwksTarget(url: URL, policy: JwksNetworkPolicy): Promise<JwksTarget> {
  const host = url.hostname;
  const bare = normalizeHostForBind(host);
  const secure = url.protocol === "https:";
  const literal = isIP(bare);
  let addresses: ResolvedAddress[];
  if (literal === 4 || literal === 6) {
    addresses = [{ address: bare, family: literal }];
  } else {
    try {
      addresses = await (policy.resolveHost ?? defaultResolveHost)(bare);
    } catch (e) {
      return refuse(
        `${host} could not be resolved (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    // `localhost` with no answer means 127.0.0.1 to the transport (resolveLoopbackTarget).
    if (addresses.length === 0 && isLoopbackHost(host)) {
      addresses = [{ address: "127.0.0.1", family: 4 }];
    }
    if (addresses.length === 0) return refuse(`${host} did not resolve to any address`);
  }
  if (addresses.every((a) => !isBlockedAddress(a.address))) {
    if (!secure) {
      return refuse(
        `${host} resolves only to public addresses and the key set would be read over plain http; use https:// (the keys could be forged in transit)`,
      );
    }
    return { host, secure, mode: "public", addresses };
  }
  // At least one address is not public: only a loopback or private-network key set may go on, and
  // the provider rules judge it from the SAME answer (a replayed resolver, so no second lookup).
  const frozen: ResolveHost = async () => addresses;
  try {
    if (isLoopbackHost(host)) {
      await resolveLoopbackTarget(url, frozen);
      return { host, secure, mode: "loopback", addresses };
    }
    const hosts =
      typeof policy.plainHttpHosts === "function" ? policy.plainHttpHosts() : policy.plainHttpHosts;
    const listed = isPlainHttpHostListed(host, hosts);
    await resolvePlainHttpTarget(url, {
      plainHttpHosts: hosts,
      resolveHost: frozen,
      allowUnlistedPrivate: true,
    });
    return { host, secure, mode: listed ? "private-listed" : "private-unlisted", addresses };
  } catch (e) {
    if (e instanceof PlainHttpRefusedError) return refuse(e.message);
    throw e;
  }
}

/** A `target` for fetchBoundedText: the decision above, warning once per host about a deprecated
 *  unlisted private one. Each call to this factory owns its own once-per-host memory. */
export function jwksTargetResolver(
  policy: JwksNetworkPolicy,
): (url: URL) => Promise<readonly ResolvedAddress[]> {
  const warned = new Set<string>();
  const warn = policy.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  return async (url) => {
    const t = await resolveJwksTarget(url, policy);
    if (t.mode === "private-unlisted" && !warned.has(t.host)) {
      warned.add(t.host);
      warn(
        `auth: DEPRECATED: ${unlistedJwksMessage(t.host, t.secure, t.addresses.map((a) => a.address).join(", "))}`,
      );
    }
    return t.addresses;
  };
}

export type JwksDescription =
  | { ok: true; host: string; secure: boolean; mode: JwksFetchMode; addresses: string[] }
  | { ok: false; host: string; reason: string };

/** The decision for a configured `auth.jwksUri`, as data (never throws): what the startup line,
 *  `doctor` and `server_health` report, from the same resolver and rules the fetch applies. */
export async function describeJwksTarget(
  uri: string,
  policy: JwksNetworkPolicy,
): Promise<JwksDescription> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, host: "?", reason: "auth.jwksUri is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, host: url.hostname, reason: "auth.jwksUri must be an http(s) URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      host: url.hostname,
      reason: "auth.jwksUri must not carry credentials in the URL",
    };
  }
  try {
    const t = await resolveJwksTarget(url, policy);
    return {
      ok: true,
      host: t.host,
      secure: t.secure,
      mode: t.mode,
      addresses: t.addresses.map((a) => a.address),
    };
  } catch (e) {
    return { ok: false, host: url.hostname, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** One human line for a description: the startup line, and the `doctor` summary. */
export function jwksModeLine(d: JwksDescription): string {
  if (!d.ok) return `auth.jwksUri REFUSED (every asymmetric token will be rejected): ${d.reason}`;
  const where = `${d.host} -> ${d.addresses.join(", ")}`;
  switch (d.mode) {
    case "public":
      return `auth.jwksUri pinned to the validated public address (https, public-only): ${where}`;
    case "loopback":
      return `auth.jwksUri loopback (${d.secure ? "https" : "plain http"}, connected to the loopback address): ${where}`;
    case "private-listed":
      return `auth.jwksUri host listed in network.plainHttpHosts (${d.secure ? "https" : "plain http"}, private-network addresses only, pinned): ${where}`;
    case "private-unlisted":
      return `auth.jwksUri DEPRECATED: ${unlistedJwksMessage(d.host, d.secure, d.addresses.join(", "))}`;
  }
}
