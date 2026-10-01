import { grantsScope, isLoopbackHost, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import type { TokenVerifier } from "../auth/verifier";
import { isHostAllowed } from "../transports/host-guard";
import type { ServerHandle } from "../transports/serve";
import { serveHono } from "../transports/serve";
import type { MetricsRecorder } from "./registry";

type AuthConfig = ServerConfig["auth"];

/** The scope a remote scrape token must hold: the one `get_metrics` already requires, so the tool
 *  and the endpoint are governed by the same grant. Checked with `grantsScope`, so `*`, `admin:*`
 *  and `admin` satisfy it exactly as they do for a tool call. */
export const METRICS_SCOPE = "admin:metrics";

export interface MetricsEndpointOptions {
  recorder: MetricsRecorder;
  bind: string;
  port: number;
  auth: AuthConfig;
  /** The ONE bearer verifier built at boot and shared with the MCP HTTP edge (jwt: `buildJwtVerifier`,
   *  oidc: the discovered IdP verifier), so a scrape token is checked exactly like a bearer: same
   *  key sources, audience, issuer, algorithms and registry revocation. Absent under jwt/oidc:
   *  every scrape is refused. Unused under `auth.mode: none`. */
  verifier?: TokenVerifier;
  /** Extra Host header values accepted by the rebinding guard (the MCP route's `allowedHosts`):
   *  put the public name a tunnel or reverse proxy forwards here. */
  allowedHosts?: readonly string[];
  /** Same switch as the MCP route's `enableDnsRebindingProtection`; on unless exactly `false`. */
  enableDnsRebindingProtection?: boolean;
}

export type MetricsHandle = ServerHandle;

/**
 * Build the Hono app that serves the Prometheus exposition at `GET /metrics`.
 *
 * Authentication is decided by `auth.mode`, NOT by the bind address alone: a loopback bind cannot
 * tell a local scraper from a caller that a Cloudflare Tunnel, Tailscale Serve, an SSH reverse
 * forward or a reverse proxy relayed to 127.0.0.1. So under `jwt` / `oidc` a verified bearer is
 * mandatory on EVERY bind, loopback included (the same floor as the MCP HTTP transport, G2.2
 * commitment 8 / G2.4 §Prometheus), and it must also hold `admin:metrics` and be UNBOUND. Only
 * `auth.mode: none` keeps the open scrape, and only on a loopback bind (a non-loopback bind under
 * `none` is refused at startup).
 *
 * On a loopback bind the Host header is also validated with the MCP route's DNS-rebinding guard
 * (`isHostAllowed`): a browser drive-by against the local listener names its own Host. Allowed:
 * loopback names, the bind host, and `allowedHosts` (the public name a tunnel forwards).
 *
 * Every series here is process-wide and computed without any per-caller ACL (queue depths, call
 * counts and ACL-denial counts for every vault), so a verified bearer alone is not authorization:
 * without the scope check a token with `scopes: []` bound to one vault read every other vault's
 * activity. A token bound to a vault, or to a persona (which always resolves to one), is refused
 * rather than filtered: several families carry a bounded SUBSYSTEM name in their `vault` label
 * (`index`, `scheduler`, cache names) and others carry no vault at all, so a label filter cannot
 * be made exact. The per-vault view is `get_metrics`, which pins a bound caller to its own vault.
 */
export function createMetricsApp(opts: MetricsEndpointOptions): Hono {
  const app = new Hono();
  const loopbackBind = isLoopbackHost(opts.bind);
  const requireAuth = opts.auth.mode !== "none" || !loopbackBind;
  // The verifier is injected, never built here: it is the same instance the MCP HTTP edge uses
  // (built once at boot), so the two cannot disagree about which tokens are accepted.
  const verifier = opts.verifier;
  const guardHost = loopbackBind && opts.enableDnsRebindingProtection !== false;
  app.get("/metrics", async (c) => {
    // Before auth, like the MCP route: a cross-origin request never reaches the pipeline. A server
    // always sends Host; the request URL (built from it by the adapter) covers a bare in-process
    // `app.request()`, which sets no header.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (guardHost && !isHostAllowed(host, [...(opts.allowedHosts ?? []), opts.bind]))
      return c.text("forbidden: host not allowed", 403);
    if (requireAuth) {
      const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
      const token = m?.[1];
      if (!token || verifier === undefined) return c.text("unauthorized", 401);
      let identity: Awaited<ReturnType<TokenVerifier["verify"]>>;
      try {
        identity = await verifier.verify(token);
      } catch {
        return c.text("unauthorized", 401);
      }
      if (!grantsScope(identity.scopes, METRICS_SCOPE)) {
        // RFC 6750 §3.1: a verified token that lacks the scope is 403, not 401.
        c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${METRICS_SCOPE}"`);
        return c.text("forbidden: insufficient_scope", 403);
      }
      if (identity.vault !== undefined || identity.persona !== undefined) {
        return c.text("forbidden: vault-bound token", 403);
      }
    }
    return c.body(await opts.recorder.metrics(), 200, {
      "content-type": opts.recorder.contentType,
    });
  });
  return app;
}

/**
 * Serve the /metrics app on bind:port. Hardcoded refusal (G2.2 commitment 8): a non-loopback bind
 * under `auth.mode: none` is rejected at startup with no config override. Pass port 0 for an
 * ephemeral port; the handle reports the actual port.
 *
 * THE-659: this MUST go through `serveHono`, not `@hono/node-server` directly. This endpoint is the
 * process's SECOND listener, and starting a Node-compat server here made every response from the
 * MCP transport's `Bun.serve` on :8765 unusable — turning `observability.prometheus.enabled: true`
 * into a total outage of the MCP plane that still reported HTTP 200.
 */
export function startMetricsEndpoint(opts: MetricsEndpointOptions): Promise<MetricsHandle> {
  if (!isLoopbackHost(opts.bind) && opts.auth.mode === "none") {
    throw new Error(
      "metrics endpoint refuses a non-localhost bind with auth.mode 'none' (G2.2 commitment 8)",
    );
  }
  return serveHono(createMetricsApp(opts), { host: opts.bind, port: opts.port });
}
