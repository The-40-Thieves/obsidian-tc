import { serve } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { Hono } from "hono";
import type { FolderAcl } from "../acl";
import { verifyJwt } from "../auth/jwt";
import type { Database } from "../db/types";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { createMcpServer } from "../mcp/server";

type AuthConfig = ServerConfig["auth"];

export interface HttpAppOptions {
  name: string;
  version: string;
  registry: ToolRegistry;
  auth: AuthConfig;
  db: Database;
  acl: FolderAcl;
  vaultId: string;
}

type AuthOutcome =
  | { ok: true; caller: string | null; scopes: Set<string> }
  | { ok: false; status: 401 | 500 | 501; reason: string };

function bearer(header: string | undefined): string | null {
  const m = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return m?.[1] ?? null;
}

// The HTTP edge authenticates only: it verifies the token and derives caller +
// scopes. Authorization (scope/ACL/HITL) stays in registry.dispatch.
async function resolveAuth(header: string | undefined, auth: AuthConfig): Promise<AuthOutcome> {
  if (auth.mode === "none") {
    return { ok: true, caller: "http-local", scopes: new Set(["*"]) };
  }
  if (auth.mode === "jwt") {
    const token = bearer(header);
    if (!token) return { ok: false, status: 401, reason: "missing bearer token" };
    if (!auth.jwtSecret)
      return { ok: false, status: 500, reason: "jwt mode misconfigured: no secret" };
    try {
      const id = await verifyJwt(token, auth.jwtSecret);
      return { ok: true, caller: id.caller, scopes: id.scopes };
    } catch {
      return { ok: false, status: 401, reason: "invalid or expired token" };
    }
  }
  return { ok: false, status: 501, reason: `auth mode '${auth.mode}' is not implemented` };
}

/**
 * Build the Hono app exposing the MCP server over Streamable HTTP at POST /mcp.
 * Each request is stateless: the edge resolves auth, then a fresh MCP server +
 * transport are assembled with a CallerContext for that request and torn down
 * when the response closes. Node req/res are bridged from Hono's Fetch Request
 * via fetch-to-node, so the same app runs under Node or Bun.
 */
export function createHttpApp(opts: HttpAppOptions): Hono {
  const app = new Hono();

  app.post("/mcp", async (c) => {
    const authz = await resolveAuth(c.req.header("authorization"), opts.auth);
    if (!authz.ok) {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32001, message: authz.reason }, id: null },
        authz.status,
      );
    }

    let body: unknown;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null },
        400,
      );
    }

    const context = (): CallerContext => ({
      caller: authz.caller,
      authenticated: true,
      grantedScopes: authz.scopes,
      vaultId: opts.vaultId,
      db: opts.db,
      acl: opts.acl,
    });

    const server = createMcpServer({
      name: opts.name,
      version: opts.version,
      registry: opts.registry,
      context,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const { req, res } = toReqRes(c.req.raw);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return toFetchResponse(res);
  });

  // Stateless mode has no standalone SSE stream or server-side session to delete.
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "method not allowed (stateless)" },
        id: null,
      },
      405,
    ),
  );

  return app;
}

export interface HttpHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Serve the HTTP app on host:port via @hono/node-server (Node-first). Pass
 * port 0 for an ephemeral port; the resolved handle reports the actual port.
 * Bun-native serving is a follow-up.
 */
export function startHttp(
  opts: HttpAppOptions & { host: string; port: number },
): Promise<HttpHandle> {
  const app = createHttpApp(opts);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
