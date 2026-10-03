// The ONE transport every outbound provider client uses by default: the gateway client, the
// embedding / reranker / model-tier HTTP adapter (embeddings/http.ts's postJson), the plur and
// Obsidian bridge client, and the telemetry sender. A client takes its `fetchFn` from the caller
// (tests) and otherwise from here, so no client carries a policy of its own.
//
// It is createPlainHttpPolicyFetch (gateway/plain-http.ts) with the process-wide host list from the
// top-level `network.plainHttpHosts`:
//   - https:// goes through the ordinary fetch, with redirects refused;
//   - every http:// request is sent directly (never through HTTP_PROXY), to a checked address, with
//     redirects refused; an https:// answer that redirects (any 3xx with a Location) is refused
//     too, so a 307/308 can never replay the key and vault text to an unchecked destination;
//   - a loopback host needs no entry;
//   - a non-loopback host is refused when it resolves to ANYTHING but loopback / RFC1918 / IPv6
//     ULA, listed or not: a public address, link-local and the cloud metadata address never get
//     the bearer key or vault text;
//   - a non-loopback host that resolves only to private addresses but is NOT listed is still sent
//     to for ONE release (every http:// provider URL worked before this policy existed), with a
//     warning that names the host and the config to add. DEPRECATED: the next major refuses it.
//
// The list lives here, not in each client's options, because every client is built from a
// different slice of the config (embeddings, reranker, gateway, a vault's restApiUrl) and none of
// those slices carries a root-level key. config/load.ts's finalizeConfig, the one place every
// config path passes through, hands the list over (the same shape as
// embeddings/provider-explicit.ts); a process that never loads a config has an empty list, and
// then only loopback and the deprecated unlisted-private path work.
import { createPlainHttpPolicyFetch, defaultResolveHost, type ResolveHost } from "./plain-http";

let plainHttpHosts: readonly string[] = [];
let resolveOverride: ResolveHost | undefined;
const warned = new Set<string>();

/** Test seam: a stubbed DNS answer for the provider transport. Production code never sets it. */
export function setProviderResolveHostForTest(fn: ResolveHost | undefined): void {
  resolveOverride = fn;
}

/** Set the process-wide `network.plainHttpHosts`. Called by finalizeConfig; a test resets it. */
export function configureProviderPlainHttp(hosts: readonly string[]): void {
  plainHttpHosts = [...hosts];
  warned.clear();
}

/** The hosts currently configured. */
export function providerPlainHttpHosts(): readonly string[] {
  return plainHttpHosts;
}

/** The deprecation text for an unlisted private host: names the host and the config to add. One
 *  definition for the request-time warning, the doctor and server_health. */
export function unlistedPlainHttpMessage(host: string, address?: string): string {
  const quoted = JSON.stringify(host);
  return (
    `plain http to ${host}${address === undefined ? "" : ` (${address})`} works only because it resolves to a private address; ` +
    `add ${quoted} to network.plainHttpHosts (network: { plainHttpHosts: [${quoted}] }). ` +
    "An unlisted plain-http host is refused from the next major release. The key and vault text travel in clear over this link."
  );
}

/** The resolver the provider transport uses. The doctor and server_health classify endpoints with
 *  THIS one, so their verdict is the transport's verdict (same DNS, same test seam). */
export const providerResolveHost: ResolveHost = (host) =>
  (resolveOverride ?? defaultResolveHost)(host);

export const providerFetch: typeof fetch = createPlainHttpPolicyFetch({
  plainHttpHosts: () => plainHttpHosts,
  resolveHost: providerResolveHost,
  allowUnlistedPrivate: true,
  onUnlistedPrivate: ({ host, address }) => {
    if (warned.has(host)) return;
    warned.add(host);
    console.warn(`[obsidian-tc] DEPRECATED: ${unlistedPlainHttpMessage(host, address)}`);
  },
});
