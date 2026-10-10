// No credential, and no usable identity, may hold a push stream or reach tool dispatch.
//
// `auth.anonymousDiscovery: "list"` admits a request with no token by METHOD (initialize, ping,
// server/discover, tools/list). The HTTP edge then opens the Tasks / advisory `subscriptions/listen`
// stream whenever `params.notifications` asks for it, whatever the method, and an anonymous caller is
// `null`, the same bucket as a verified JWT with no `sub`. So:
//   * the anonymous gate inspects params, not only the method (a stream opt-in is a 401);
//   * the Tasks stream refuses a null caller exactly like the advisory stream does;
//   * an unauthenticated context cannot dispatch ANY tool, scope-free ones included.
// Real HTTP app (createHttpApp), real JWT verification, a real job queue.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { JobQueue } from "../src/scheduler/job-queue";
import { createHttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const MODERN = "2026-07-28";
const RESOURCE = "https://vault.example.com/mcp";
const SECRET = "s".repeat(40);
const TASKS_KEY = "io.modelcontextprotocol/tasks";
const ADVISORY_KEY = "io.the40thieves.obsidian-tc/advisory";
const ADMITTED = [
  "initialize",
  "notifications/initialized",
  "ping",
  "server/discover",
  "tools/list",
];

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function boot(authOver: Record<string, unknown>) {
  const parsed = ServerConfigSchema.parse({
    vaults: [{ id: "v", path: "/tmp/v" }],
    auth: authOver,
  });
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
  const listen = vi.spyOn(queue, "onTaskChange");
  const probe = vi.fn(() => ({ ok: true }));
  const registry = new ToolRegistry();
  registry.register({
    name: "scope_free_probe",
    description: "test-only, declares no scopes (like server_health)",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: probe,
  } as never);
  const { app } = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry,
    auth: parsed.auth,
    db,
    vaultId: "v",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
    jobQueue: queue,
  } as Parameters<typeof createHttpApp>[0]);
  return { app, listen, probe };
}

const MIXED = {
  mode: "jwt",
  jwtSecret: SECRET,
  resource: RESOURCE,
  authorizationServers: ["https://as.example.com"],
  anonymousDiscovery: "list",
};

async function token(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scopes: ["*"], aud: RESOURCE, iat: now, exp: now + 600, ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

function post(
  app: ReturnType<typeof boot>["app"],
  body: unknown,
  opts: { jwt?: string; version?: string } = {},
) {
  const version = opts.version ?? MODERN;
  const { method, params } = body as { method: string; params?: { name?: string } };
  return app.request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
      ...(version === MODERN
        ? { "mcp-method": method, ...(params?.name ? { "mcp-name": params.name } : {}) }
        : {}),
      ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const rpc = (method: string, params: Record<string, unknown>, id: number | null = 1) => ({
  jsonrpc: "2.0",
  ...(id === null ? {} : { id }),
  method,
  params,
});

const STREAM_OPT_INS = [
  ["tasks", { [TASKS_KEY]: true }],
  ["advisory", { [ADVISORY_KEY]: true }],
  ["tasks key set to false", { [TASKS_KEY]: false }],
  ["an unknown notifications key", { "x.example/anything": true }],
  ["an empty notifications object", {}],
] as const;

describe("anonymous gate inspects params, not just the method", () => {
  it.each(ADMITTED.flatMap((m) => STREAM_OPT_INS.map(([n, notif]) => [m, n, notif] as const)))(
    "%s asking for %s is a 401, never a stream",
    async (method, _name, notifications) => {
      const { app, listen } = boot(MIXED);
      const res = await post(
        app,
        rpc(method, { notifications }, method.startsWith("notifications/") ? null : 1),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
      expect(listen).not.toHaveBeenCalled();
    },
  );

  it("the verbatim repro (tools/list, tasks opt-in, 2026-07-28, no Authorization) is a 401", async () => {
    const { app, listen } = boot(MIXED);
    const res = await app.request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"notifications":{"io.modelcontextprotocol/tasks":true}}}',
    });
    expect(res.status).toBe(401);
    expect(listen).not.toHaveBeenCalled();
  });

  it("the legacy protocol header does not bypass the params check", async () => {
    const { app, listen } = boot(MIXED);
    const res = await post(app, rpc("tools/list", { notifications: { [TASKS_KEY]: true } }), {
      version: "2025-11-25",
    });
    expect(res.status).toBe(401);
    expect(listen).not.toHaveBeenCalled();
  });

  it("control: a plain anonymous tools/list and server/discover are still answered", async () => {
    const { app } = boot(MIXED);
    for (const method of ["tools/list", "server/discover"]) {
      const res = await post(app, rpc(method, { _meta: META }));
      expect(res.status, method).toBe(200);
    }
  });

  it("an authenticated caller's stream opt-in is unaffected by the anonymous gate", async () => {
    const { app } = boot(MIXED);
    const jwt = await token({ sub: "agent-1" });
    const res = await post(
      app,
      rpc("subscriptions/listen", { notifications: { [TASKS_KEY]: true }, _meta: META }),
      { jwt },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    await res.body?.cancel();
  });
});

describe("the Tasks stream refuses a caller with no usable identity", () => {
  it("a verified JWT with no `sub` gets 403 and no listener (default 401 mode, no anonymous list)", async () => {
    const { app, listen } = boot({ ...MIXED, anonymousDiscovery: undefined });
    const jwt = await token({});
    const res = await post(
      app,
      rpc("subscriptions/listen", { notifications: { [TASKS_KEY]: true }, _meta: META }),
      { jwt },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(listen).not.toHaveBeenCalled();
  });

  it("a verified JWT with no `sub` cannot open it in list mode either", async () => {
    const { app, listen } = boot(MIXED);
    const jwt = await token({});
    const res = await post(
      app,
      rpc("subscriptions/listen", { notifications: { [TASKS_KEY]: true }, _meta: META }),
      { jwt },
    );
    expect(res.status).toBe(403);
    expect(listen).not.toHaveBeenCalled();
  });

  it("the advisory stream already refuses it (the shape the Tasks refusal mirrors)", async () => {
    const { serveAdvisorySubscription } = await import("../src/mcp/advisories");
    const res = serveAdvisorySubscription(
      rpc("subscriptions/listen", {}),
      { subscribe: () => () => undefined } as never,
      { vaultId: "v", caller: null },
      new AbortController().signal,
    );
    expect(res.status).toBe(403);
  });
});

describe("an unauthenticated context dispatches no tool", () => {
  it("anonymous tools/call of a scope-free tool is a tool error and the handler never runs", async () => {
    const { app, probe } = boot(MIXED);
    const res = await post(
      app,
      rpc("tools/call", { name: "scope_free_probe", arguments: {}, _meta: META }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: { isError: boolean; _meta: Record<string, unknown> };
    };
    expect(json.result.isError).toBe(true);
    expect(json.result._meta["mcp/www_authenticate"]).toBeDefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("registry dispatch refuses authenticated:false even for requiredScopes []", async () => {
    const registry = new ToolRegistry();
    const probe = vi.fn(() => ({ ok: true }));
    registry.register({
      name: "scope_free_probe",
      description: "test-only",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: probe,
    } as never);
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ctx = {
      caller: null,
      transport: "http",
      grantedScopes: new Set(["read:*"]),
      vaultId: "v",
      vaultBound: true,
      db,
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    };
    const denied = await registry.dispatch("scope_free_probe", {}, {
      ...ctx,
      authenticated: false,
    } as never);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("unauthorized");
    expect(probe).not.toHaveBeenCalled();
    const allowed = await registry.dispatch("scope_free_probe", {}, {
      ...ctx,
      authenticated: true,
    } as never);
    expect(allowed.ok).toBe(true);
  });

  it("auth.mode none over HTTP: a scope-free tool still dispatches with no token", async () => {
    const { app, probe } = boot({ mode: "none" });
    const res = await post(
      app,
      rpc("tools/call", { name: "scope_free_probe", arguments: {}, _meta: META }),
    );
    expect(res.status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
