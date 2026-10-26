import { isIP } from "node:net";
import {
  localhostAllowedHostnames,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";

/** The SDK matches on the HOSTNAME, while our config schema documents `allowedHosts` as "Host header
 *  VALUES" (which may include a port). Canonicalize the way the SDK does (`new URL(...).hostname`):
 *  IPv6 keeps its brackets, IDN is punycoded, IPv4 shorthand is expanded. A value the URL parser
 *  rejects, or that is more than an authority (a path, query, fragment, userinfo or whitespace),
 *  keeps the port strip it always had. Brackets come off only around an IPv6 literal, so a bracketed
 *  name such as `[trusted.example]` stays bracketed and matches no bare Host. */
export const hostnameOf = (v: string): string => {
  if (!/[/?#@\\\s]/.test(v)) {
    try {
      return new URL(`http://${v}`).hostname;
    } catch {}
  }
  const bare = v.replace(/:\d+$/, "");
  const inner = bare.replace(/^\[|\]$/g, "");
  return isIP(inner) === 6 ? inner : bare;
};
export const bothForms = (vs: readonly string[]): string[] => vs.flatMap((v) => [v, hostnameOf(v)]);

/**
 * DNS-rebinding Host check (THE-271, THE-583), shared by the MCP route and `/metrics`: true when
 * `rawHost` is loopback or one of `allowedHosts`. Validation is the SDK's (`validateHostHeader`),
 * which parses IPv6 brackets and ports properly rather than by regex.
 */
export function isHostAllowed(rawHost: string, allowedHosts: readonly string[] = []): boolean {
  return validateHostHeader(rawHost, [...localhostAllowedHostnames(), ...bothForms(allowedHosts)])
    .ok;
}

/** Origin half of the same check: same-origin stays allowed (the request's own Host is the origin a
 *  browser would send), plus the operator's `allowedOrigins`. A `corsOrigins` entry passes by EXACT
 *  match only and is never added to the hostname list, so `https://app.example.com` does not admit
 *  `http://app.example.com` or a port variant. */
export function isOriginAllowed(
  origin: string,
  rawHost: string,
  allowedOrigins: readonly string[] = [],
  corsOrigins: ReadonlySet<string> = new Set(),
): boolean {
  if (corsOrigins.has(origin)) return true;
  const hosts = [
    hostnameOf(rawHost),
    ...bothForms(allowedOrigins).map((o) => hostnameOf(o.replace(/^\w+:\/\//, ""))),
  ];
  return validateOriginHeader(origin, hosts).ok;
}
