import { localhostAllowedHostnames, validateHostHeader } from "@modelcontextprotocol/server";

/** The SDK matches on the HOSTNAME, while our config schema documents `allowedHosts` as "Host header
 *  VALUES" (which may include a port). Strip the port and IPv6 brackets so both forms work. */
export const hostnameOf = (v: string): string => v.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
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
