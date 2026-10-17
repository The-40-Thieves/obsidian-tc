// CORS for browser clients (opt-in: `transports.http.cors.allowedOrigins`). Off by default: an empty
// set makes the middleware a no-op, so no response changes. Listed origins are matched EXACTLY on
// scheme, host and port (the config schema has already refused wildcards, paths and trailing slashes).

import type { MiddlewareHandler } from "hono";

/** The routes a browser client calls with fetch: the MCP endpoint, every `/.well-known/*` metadata
 *  document, and the authorization server's token, registration and revocation endpoints. The
 *  browser-navigation pages (authorize, login, consent, setup, account) are deliberately absent:
 *  they are top-level navigations, and CORS there would only widen the surface. */
const OAUTH_API_PATHS = new Set(["/oauth/token", "/oauth/register", "/oauth/revoke"]);

export function isCorsPath(path: string): boolean {
  return (
    path === "/mcp" ||
    /^\/mcp\/[^/]+$/.test(path) ||
    path.startsWith("/.well-known/") ||
    OAUTH_API_PATHS.has(path)
  );
}

const ALLOW_HEADERS = "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version";
/** Response headers a page may read: the 401 challenge and the session id are not in the safelist. */
const EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate, Mcp-Protocol-Version";

/** The configured origins as a browser sends them in `Origin` (scheme and host lowercased, default
 *  port dropped). The schema has already validated each entry as an exact web origin. */
export function corsOriginSet(origins: readonly string[]): ReadonlySet<string> {
  return new Set(origins.map((origin) => new URL(origin).origin));
}

/** Never `*`: an allowed origin is echoed back exactly. No `Access-Control-Allow-Credentials` is
 *  ever sent, because the bearer travels in `Authorization`, not in a cookie, so a page needs no
 *  credentialed request and none is granted. */
export function corsMiddleware(
  allowed: ReadonlySet<string>,
  /** The rebinding guard's Host check. A preflight answers before any route runs, so it applies the
   *  check itself: a Host the guard refuses gets no CORS answer, exactly like the POST behind it. */
  hostAllowed: (rawHost: string) => boolean = () => true,
): MiddlewareHandler {
  return async (c, next) => {
    if (allowed.size === 0 || !isCorsPath(c.req.path)) return next();
    const origin = c.req.header("origin");
    const ok =
      origin !== undefined && allowed.has(origin) && hostAllowed(c.req.header("host") ?? "");
    if (ok && c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": c.req.path.startsWith("/.well-known/") ? "GET" : "POST",
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Max-Age": "600",
      });
    }
    // After `next()` so error responses (401 challenge, 403, 429) carry the headers too: a browser
    // cannot read a `WWW-Authenticate` it is not allowed to see.
    await next();
    if (!/(^|,)\s*origin\s*(,|$)/i.test(c.res.headers.get("vary") ?? "")) {
      c.header("Vary", "Origin", { append: true });
    }
    if (ok) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    }
  };
}
