import { grantsScope, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import { effectiveAudience } from "../auth/protected-resource";
import type { AuthRegistry } from "../auth/registry";
import { createTokenVerifier, type TokenVerifier } from "../auth/verifier";
import type { ServerHandle } from "../transports/serve";
import { serveHono } from "../transports/serve";
import type { MetricsRecorder } from "./registry";

type AuthConfig = ServerConfig["auth"];

/** Loopback binds serve an open local scrape; any other bind is treated as network-exposed. */
function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

/** The scope a remote scrape token must hold: the one `get_metrics` already requires, so the tool
 *  and the endpoint are governed by the same grant. Checked with `grantsScope`, so `*`, `admin:*`
 *  and `admin` satisfy it exactly as they do for a tool call. */
export const METRICS_SCOPE = "admin:metrics";

export interface MetricsEndpointOptions {
  recorder: MetricsRecorder;
  bind: string;
  port: number;
  auth: AuthConfig;
  /** When set, a scrape token must be signed by a live registry key and not be revoked. */
  registry?: AuthRegistry;
  /** Under `auth.mode: oidc`: the SAME verifier the MCP edge uses (built once at boot), so a scrape
   *  token is an IdP token checked exactly like a bearer. Absent under oidc: every remote scrape is
   *  refused. Ignored in jwt mode, which builds its own from `registry`. */
  verifier?: TokenVerifier;
}

export type MetricsHandle = ServerHandle;

/**
 * Build the Hono app that serves the Prometheus exposition at `GET /metrics`. On a loopback
 * bind the scrape is open (local-only, the V1 default). On any non-loopback bind a valid JWT
 * is mandatory — the same hardcoded floor as the MCP HTTP transport (G2.2 commitment 8 /
 * G2.4 §Prometheus) — and it must also hold `admin:metrics` and be UNBOUND.
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
  const requireAuth = !isLoopback(opts.bind);
  // The same verifier as the MCP HTTP edge (algorithm chosen by the registry row, revocation and
  // key retirement from the registry), so the two cannot disagree about which tokens are accepted.
  // It has no external JWKS: a scrape token is one this server issued. With a registry the
  // configured secret is optional (it can be removed once the `config` key is retired).
  const verifier: TokenVerifier | undefined =
    opts.auth.mode === "oidc"
      ? opts.verifier
      : opts.auth.mode === "jwt" && (opts.auth.jwtSecret || opts.registry)
        ? createTokenVerifier({
            secret: opts.auth.jwtSecret,
            registry: opts.registry,
            maxAgeSeconds: opts.auth.tokenTtlSeconds,
            // Same audience/issuer binding as the MCP HTTP edge: a token minted for another
            // service, or by another issuer, must not scrape this one.
            audience: effectiveAudience(opts.auth),
            issuer: opts.auth.issuer,
            // The same algorithm allowlist as the MCP edge: `["EdDSA"]` refuses HS256 here too.
            algorithms: opts.auth.algorithms,
            requireJti: opts.auth.requireJti,
          })
        : undefined;
  app.get("/metrics", async (c) => {
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
  if (!isLoopback(opts.bind) && opts.auth.mode === "none") {
    throw new Error(
      "metrics endpoint refuses a non-localhost bind with auth.mode 'none' (G2.2 commitment 8)",
    );
  }
  return serveHono(createMetricsApp(opts), { host: opts.bind, port: opts.port });
}
