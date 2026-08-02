import { serve } from "@hono/node-server";
import { normalizeHostForBind } from "@the-40-thieves/obsidian-tc-shared";
import type { Hono } from "hono";

/**
 * THE-659: the ONE place that decides how a Hono app is served. Every listener in the process must
 * go through here, and the reason is that the choice is not per-server — it is per-PROCESS.
 *
 * Starting `@hono/node-server` installs its Node-compat HTTP machinery process-wide. After that,
 * Hono's responses are the node-compat "lightweight" variant (`nativeResponse: undefined`), which
 * native `Bun.serve` refuses:
 *
 *     error: Expected a Response object, but received 'Response (lightweight) {
 *       status: 404, headers: Headers {}, ok: false, nativeResponse: undefined }'
 *
 * Bun then substitutes its own placeholder page — at **HTTP 200**, so a status-code liveness probe
 * calls the dead server healthy. In production this took down the whole MCP plane: THE-561 moved
 * the MCP transport to `Bun.serve`, `metrics/endpoint.ts` kept calling `@hono/node-server`, and
 * simply setting `observability.prometheus.enabled: true` made every request to :8765 return
 * "Welcome to Bun! To get started, return a Response object."
 *
 * Mixing the two is the bug, so neither call site gets to choose. Bun is the production runtime
 * (see the Dockerfile ENTRYPOINT) and handles keep-alive correctly, which THE-561's
 * `@hono/node-server` path did not (~25% ECONNRESET on a REUSED connection, which a pooling client
 * like LiteLLM's httpx hits constantly). Node stays supported because vitest runs there.
 */
export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** Minimal shape of a `Bun.serve` server — only what this module uses. */
interface BunServer {
  port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}
interface BunGlobal {
  serve(opts: {
    port: number;
    hostname: string;
    fetch: (req: Request) => Response | Promise<Response>;
    /** THE-697: seconds of inactivity before Bun closes a connection. Bun's default is 10, which
     *  this file inherited by not passing one. Bun accepts 0 (disabled) through 255. */
    idleTimeout: number;
  }): BunServer;
}

/**
 * THE-697 — the idle timeout Bun.serve applies to EVERY request this process serves.
 *
 * Bun's default is 10 seconds, and serveHono passed nothing, so the default applied to the whole
 * MCP plane. `index_vault` over a 1,147-note vault exceeds it comfortably even when incremental (it
 * walks every note to compare content hashes), and the caller saw `RemoteProtocolError: Server
 * disconnected without sending a response` while the container logged "request timed out after 10
 * seconds" and the indexing completed anyway. A successful operation reported as a hard failure,
 * with no result payload.
 *
 * 120s, chosen rather than maxed. Bun accepts up to 255 and 0 disables the timeout entirely, but
 * this is per-process and applies to every request — a disabled timeout leaks genuinely dead
 * connections, and 255 is a ceiling, not a design. 120s covers an incremental index and any normal
 * tool call with headroom while still reclaiming a wedged connection in bounded time.
 *
 * This does NOT make long indexing safe over HTTP, and must not be read as fixing that: a full
 * 13k-chunk reindex runs past any value Bun will accept. The operator path for that is the
 * `obsidian-tc index` CLI command (THE-697), and the composable path is the Tasks extension the
 * index_vault tool already opts into via `taskAugmentable`.
 */
export const BUN_IDLE_TIMEOUT_SECONDS = 120;

/**
 * Serve `app` on host:port with the runtime's native server. Pass port 0 for an ephemeral port;
 * the resolved handle reports the actual one.
 */
export function serveHono(app: Hono, opts: { host: string; port: number }): Promise<ServerHandle> {
  const hostname = normalizeHostForBind(opts.host);

  const bun = (globalThis as unknown as { Bun?: BunGlobal }).Bun;
  if (bun) {
    const server = bun.serve({
      port: opts.port,
      hostname,
      fetch: app.fetch,
      idleTimeout: BUN_IDLE_TIMEOUT_SECONDS,
    });
    return Promise.resolve({
      port: server.port,
      // stop(true) closes active connections so close() resolves promptly (parity with the Node
      // path's closeIdleConnections). Wrapped in Promise.resolve to tolerate both void and Promise.
      close: () => Promise.resolve(server.stop(true)).then(() => undefined),
    });
  }

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname, port: opts.port }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // THE-186: force idle keep-alive sockets shut so close() resolves promptly instead
            // of waiting out Node's ~4s keep-alive drain (the standalone SSE GET the stateless
            // server 405s leaves an idle socket behind; also tightens production shutdown).
            (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
          }),
      });
    });
  });
}
