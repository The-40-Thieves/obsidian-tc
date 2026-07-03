import { serve } from "@hono/node-server";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import { verifyJwt } from "../auth/jwt";
import type { MetricsRecorder } from "./registry";

type AuthConfig = ServerConfig["auth"];

/** Loopback binds serve an open local scrape; any other bind is treated as network-exposed. */
function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

export interface MetricsEndpointOptions {
  recorder: MetricsRecorder;
  bind: string;
  port: number;
  auth: AuthConfig;
}

export interface MetricsHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Build the Hono app that serves the Prometheus exposition at `GET /metrics`. On a loopback
 * bind the scrape is open (local-only, the V1 default). On any non-loopback bind a valid JWT
 * is mandatory — the same hardcoded floor as the MCP HTTP transport (G2.2 commitment 8 /
 * G2.4 §Prometheus). Metric values themselves carry no caller identity, so a scrape only
 * needs to prove it is an authorized operator, not a specific caller.
 */
export function createMetricsApp(opts: MetricsEndpointOptions): Hono {
  const app = new Hono();
  const requireAuth = !isLoopback(opts.bind);
  app.get("/metrics", async (c) => {
    if (requireAuth) {
      const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
      const token = m?.[1];
      if (!token || opts.auth.mode !== "jwt" || !opts.auth.jwtSecret) {
        return c.text("unauthorized", 401);
      }
      try {
        await verifyJwt(token, opts.auth.jwtSecret, { maxAgeSeconds: opts.auth.tokenTtlSeconds });
      } catch {
        return c.text("unauthorized", 401);
      }
    }
    return c.body(await opts.recorder.metrics(), 200, {
      "content-type": opts.recorder.contentType,
    });
  });
  return app;
}

/**
 * Serve the /metrics app on bind:port via @hono/node-server. Hardcoded refusal (G2.2
 * commitment 8): a non-loopback bind under `auth.mode: none` is rejected at startup with no
 * config override. Pass port 0 for an ephemeral port; the handle reports the actual port.
 */
export function startMetricsEndpoint(opts: MetricsEndpointOptions): Promise<MetricsHandle> {
  if (!isLoopback(opts.bind) && opts.auth.mode === "none") {
    throw new Error(
      "metrics endpoint refuses a non-localhost bind with auth.mode 'none' (G2.2 commitment 8)",
    );
  }
  const app = createMetricsApp(opts);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: opts.bind, port: opts.port }, (info) => {
      resolve({
        port: info.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
