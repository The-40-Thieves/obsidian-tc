import type { ServerOptions } from "node:http";
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

const NODE_REQUEST_TIMEOUT_MS = BUN_IDLE_TIMEOUT_SECONDS * 1000;
const NODE_HEADERS_TIMEOUT_MS = 60_000;
/**
 * Node checks `requestTimeout` only on each `connectionsCheckingInterval` tick, and the default tick
 * is 30 s. At that default a stalled request is cut anywhere between the timeout and timeout + 30 s,
 * and the 300 s default timeout held a body that stopped mid-way for minutes. A 1 s tick keeps the
 * enforcement close to the number it is set to.
 */
const NODE_CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;

/** The Node branch's server options: the same request ceiling Bun applies, and a tick that enforces it. */
export const NODE_SERVER_OPTIONS: ServerOptions = {
  requestTimeout: NODE_REQUEST_TIMEOUT_MS,
  headersTimeout: NODE_HEADERS_TIMEOUT_MS,
  connectionsCheckingInterval: NODE_CONNECTIONS_CHECKING_INTERVAL_MS,
};

/**
 * Serve `app` on host:port with the runtime's native server. Pass port 0 for an ephemeral port;
 * the resolved handle reports the actual one. `nodeServerOptions` overrides {@linkcode NODE_SERVER_OPTIONS}
 * on the Node branch; only the tests pass it, to see a request timeout fire within a test's budget.
 */
export function serveHono(
  app: Hono,
  opts: { host: string; port: number; nodeServerOptions?: ServerOptions },
): Promise<ServerHandle> {
  const hostname = normalizeHostForBind(opts.host);
  const fetch = closeIfBodyUnread(app.fetch);

  const bun = (globalThis as unknown as { Bun?: BunGlobal }).Bun;
  if (bun) {
    const server = bun.serve({
      port: opts.port,
      hostname,
      fetch,
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
    const serverOptions = { ...NODE_SERVER_OPTIONS, ...opts.nodeServerOptions };
    const server = serve({ fetch, hostname, port: opts.port, serverOptions }, (info) => {
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

/**
 * Bytes of an unread request body the wrapper drains before it gives up and closes. 4 MiB is the
 * MCP SDK's request limit: `/mcp` reads a clone, so a valid body it accepted is still unread here
 * and must drain in full, or the connection closes on a request the server served.
 */
export const UNREAD_BODY_DRAIN_MAX_BYTES = 4 * 1024 * 1024;
/** Time the wrapper spends draining an unread request body before it gives up and closes. */
export const UNREAD_BODY_DRAIN_MS = 250;

/**
 * Close the connection when a response leaves the request body unread. Bun keeps such a socket
 * open for the whole idle timeout (120 s here), so a caller that declares a body and never sends it
 * can hold a connection. The leftover body is drained first, within a byte cap and a deadline: a
 * body the caller sent in full keeps its connection, which pooled `/mcp` clients depend on (their
 * handler reads a clone, so the original stays unread). A body still arriving at the bound closes.
 * A body the handler read directly is left alone (`bodyUsed`). A body read in part and then
 * abandoned is not visible here, so the webhook keeps its own per-route `Connection: close`.
 * Every argument after the request is forwarded: Hono reads the runtime's second argument as
 * `c.env`, which the client-IP helper needs.
 */
export function closeIfBodyUnread<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const res = await handler(req, ...rest);
    if (!declaresBody(req) || req.bodyUsed) return res;
    if (res.headers.has("connection")) {
      // The handler chose its own Connection (an SSE stream keeps alive). The unread original is
      // cancelled, not drained, so a tee branch the handler read through a clone is not held open.
      void req.body?.cancel().catch(() => {});
      return res;
    }
    if (await drainUnreadBody(req)) return res;
    try {
      res.headers.set("connection", "close");
      return res;
    } catch {
      // Immutable headers (a fetch or redirect Response): copy them onto a mutable Response. The
      // body stays a stream, so an SSE response is still never buffered. A status outside 200-599
      // cannot be rebuilt (the Response constructor refuses it), so it goes back unchanged.
      if (res.status < 200 || res.status > 599) return res;
      const headers = new Headers(res.headers);
      headers.set("connection", "close");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  };
}

/**
 * Read and discard the request body the handler left unread. True when it ended within both bounds;
 * false when the cap or the deadline was hit or the read failed, and the body is cancelled.
 */
async function drainUnreadBody(req: Request): Promise<boolean> {
  const length = req.headers.get("content-length");
  if (length !== null && Number(length) > UNREAD_BODY_DRAIN_MAX_BYTES) return false;
  // No stream for a declared body (a GET the runtime gave no body), or a body the handler locked:
  // neither can be drained, so the caller closes.
  const reader = lockBody(req.body);
  if (!reader) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), UNREAD_BODY_DRAIN_MS);
  });
  // Never rejects: a failed read is a `false`, so no rejection outlives a deadline that won the race.
  const read = (async () => {
    try {
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        total += value.byteLength;
        if (total > UNREAD_BODY_DRAIN_MAX_BYTES) return false;
      }
    } catch {
      return false;
    }
  })();
  try {
    const drained = await Promise.race([read, deadline]);
    // Not awaited: on a tee branch the cancel settles only once the other branch is cancelled too.
    if (!drained) void reader.cancel().catch(() => {});
    return drained;
  } finally {
    clearTimeout(timer);
  }
}

function lockBody(body: ReadableStream<Uint8Array> | null) {
  try {
    return body?.getReader();
  } catch {
    return undefined;
  }
}

/**
 * Only an absent Content-Length, or the exact "0", with no Transfer-Encoding, declares no body. A
 * malformed length counts as one, and the drain bounds it like any other.
 */
function declaresBody(req: Request): boolean {
  if (req.headers.has("transfer-encoding")) return true;
  const length = req.headers.get("content-length");
  return length !== null && length !== "0";
}
