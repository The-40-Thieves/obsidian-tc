// How an OAuth-protected server behaves for a caller with no token (`auth.anonymousDiscovery`),
// over the real HTTP app (createHttpApp), on /mcp and on a profile URL (/mcp/essentials).
//
// Two hosted clients want opposite things, so the default and the opt-in are both pinned:
//   * grok.com starts OAuth ONLY when `tools/list` answers 401; if listing works anonymously every
//     call fails with "Auth required" and the sign-in never opens (Teamwork/mcp#555, 2026-09-22).
//     The default (`none`) therefore answers 401 + WWW-Authenticate to every request without a
//     token, `initialize` and `ping` included: one gate, no method carved out.
//   * ChatGPT "OAuth or no authentication" (mixed) mode calls initialize and tools/list anonymously,
//     reads each tool's `securitySchemes`, and links the user's account only when a tool error
//     carries `_meta["mcp/www_authenticate"]` with `error` and `error_description`.
//     Shapes verified against https://developers.openai.com/apps-sdk/build/auth and
//     https://developers.openai.com/apps-sdk/reference on 2026-10-10: `securitySchemes` is a
//     top-level tool field AND mirrored in `_meta.securitySchemes`; the `_meta` value is a string or
//     string[] of RFC 7235 challenges; scheme entries are `{type:"noauth"}` / `{type:"oauth2",scopes}`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFlows, type Flow, issue, makeFlow } from "./as-flow-harness";
import { ISSUER, RESOURCE } from "./as-operator-harness";

afterEach(cleanupFlows);

const MODERN = "2026-07-28";
const PATHS = ["/mcp", "/mcp/essentials"] as const;
const TOOLS = [{ name: "admin_probe", requiredScopes: ["admin:vault"] }];
const urlOf = (path: string) => `${ISSUER}${path}`;
const prmOf = (path: string) => `${ISSUER}/.well-known/oauth-protected-resource${path}`;

interface Rpc {
  status: number;
  www: string | null;
  json: any;
}

async function rpc(
  flow: Flow,
  path: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Rpc> {
  const res = await flow.app.request(urlOf(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, www: res.headers.get("www-authenticate"), json };
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const modern = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) => ({
  body: {
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method,
    params: { ...params, _meta: MODERN_META },
  },
  headers: { "mcp-protocol-version": MODERN, "mcp-method": method } as Record<string, string>,
});
const legacy = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) => ({
  jsonrpc: "2.0",
  ...(id === null ? {} : { id }),
  method,
  params,
});

/** The SDK client, with or without a token, over the in-process app. */
function clientFor(flow: Flow, path: string, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(urlOf(path)), {
    fetch: (input, init) =>
      Promise.resolve(flow.app.request(input as string | URL | Request, init)),
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  return { client: new Client({ name: "t", version: "1" }), transport };
}

const challengeFor = (path: string) =>
  `Bearer realm="obsidian-tc", resource_metadata="${prmOf(path)}"`;

describe("default (anonymousDiscovery: none): 401 + challenge for every request without a token", () => {
  const METHODS = [
    "initialize",
    "notifications/initialized",
    "ping",
    "server/discover",
    "tools/list",
    "tools/call",
    "resources/list",
    "prompts/list",
  ];
  it.each(PATHS)("%s: all methods are challenged, none is answered", async (path) => {
    const flow = await makeFlow({ tools: TOOLS });
    for (const method of METHODS) {
      const id = method.startsWith("notifications/") ? null : 1;
      const r = await rpc(flow, path, legacy(method, { name: "list_vaults", arguments: {} }, id));
      expect(r.status, method).toBe(401);
      expect(r.www, method).toBe(challengeFor(path));
      const m = modern(method, { name: "list_vaults", arguments: {} }, id);
      const rm = await rpc(flow, path, m.body, undefined, m.headers);
      expect(rm.status, `modern ${method}`).toBe(401);
      expect(rm.www, `modern ${method}`).toBe(challengeFor(path));
    }
  });

  it.each(PATHS)(
    "%s: an SDK client with no token is sent to sign in (grok.com / Claude)",
    async (path) => {
      const flow = await makeFlow();
      const { client, transport } = clientFor(flow, path);
      await expect(client.connect(transport)).rejects.toMatchObject({ code: 401 });
    },
  );

  it.each(PATHS)("%s: a garbage token is a 401 with the challenge too", async (path) => {
    const flow = await makeFlow();
    const m = modern("tools/list");
    const r = await rpc(flow, path, m.body, "not.a.jwt", m.headers);
    expect(r.status).toBe(401);
    expect(r.www).toBe(challengeFor(path));
  });
});

describe("anonymousDiscovery: list (ChatGPT mixed auth)", () => {
  it.each(PATHS)("%s: anonymous initialize, ping and tools/list are answered", async (path) => {
    const flow = await makeFlow({ anonymousDiscovery: "list", tools: TOOLS });
    const { client, transport } = clientFor(flow, path);
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.length).toBeGreaterThan(0);
    await client.ping();
    await client.close();
    const m = modern("tools/list");
    const r = await rpc(flow, path, m.body, undefined, m.headers);
    expect(r.status).toBe(200);
    expect(r.json.result.tools.length).toBeGreaterThan(0);
  });

  it.each(PATHS)(
    "%s: every listed tool declares securitySchemes, mirrored in _meta",
    async (path) => {
      // Raw wire JSON: the SDK client's own result schema drops fields it does not know.
      const flow = await makeFlow({ anonymousDiscovery: "list", tools: TOOLS });
      const m = modern("tools/list");
      const r = await rpc(flow, path, m.body, undefined, m.headers);
      expect(r.status).toBe(200);
      const tools = r.json.result.tools as any[];
      expect(tools.map((t) => t.name)).toContain("list_vaults");
      for (const t of tools) {
        expect(Array.isArray(t.securitySchemes), t.name).toBe(true);
        expect(t.securitySchemes, t.name).toEqual([{ type: "oauth2", scopes: expect.any(Array) }]);
        expect(t._meta?.securitySchemes, t.name).toEqual(t.securitySchemes);
      }
      const vaults = tools.find((t) => t.name === "list_vaults");
      expect(vaults.securitySchemes).toEqual([{ type: "oauth2", scopes: ["read:vault"] }]);
    },
  );

  it.each(PATHS)(
    "%s: the anonymous list is exactly what a default-scope caller sees (no admin tool)",
    async (path) => {
      const flow = await makeFlow({ anonymousDiscovery: "list", tools: TOOLS });
      const anon = clientFor(flow, path);
      await anon.client.connect(anon.transport);
      const anonymous = (await anon.client.listTools()).tools.map((t) => t.name).sort();
      await anon.client.close();

      // The AS's own default: a sign-in that names no scope is granted `read:*`.
      const { access } = await issue(flow, { scope: undefined });
      const authed = clientFor(flow, path, access);
      await authed.client.connect(authed.transport);
      const granted = (await authed.client.listTools()).tools.map((t) => t.name).sort();
      await authed.client.close();

      expect(anonymous).toEqual(granted);
      expect(anonymous).not.toContain("admin_probe");
      expect(anonymous).toContain("list_vaults");

      // The control (on /mcp, the full surface; /mcp/essentials advertises a fixed subset): a caller
      // holding the admin scope does see it, so the scope filter is what hid it.
      if (path === "/mcp") {
        const { access: admin } = await issue(flow, { scope: "admin:vault read:vault" });
        const ac = clientFor(flow, path, admin);
        await ac.client.connect(ac.transport);
        const names = (await ac.client.listTools()).tools.map((t) => t.name);
        await ac.client.close();
        expect(names).toContain("admin_probe");
      }
    },
  );

  it.each(PATHS)(
    "%s: anonymous tools/call is a tool error carrying the same challenge the 401 would",
    async (path) => {
      const flow = await makeFlow({ anonymousDiscovery: "list", tools: TOOLS });
      const { client, transport } = clientFor(flow, path);
      await client.connect(transport);
      const result: any = await client.callTool({ name: "list_vaults", arguments: {} });
      await client.close();
      expect(result.isError).toBe(true);
      const challenges = result._meta?.["mcp/www_authenticate"];
      expect(Array.isArray(challenges)).toBe(true);
      expect(challenges).toHaveLength(1);
      expect(challenges[0].startsWith(challengeFor(path))).toBe(true);
      expect(challenges[0]).toMatch(/error="[a-z_]+"/);
      expect(challenges[0]).toMatch(/error_description="[^"]+"/);
      // Byte-identical to the header the 401 carries, plus the two attributes OpenAI requires.
      const denied = await rpc(await makeFlow({ tools: TOOLS }), path, legacy("tools/list"));
      expect(challenges[0].startsWith(denied.www as string)).toBe(true);
    },
  );

  it.each(PATHS)(
    "%s: the raw modern-era tools/call answers 200 with the tool error",
    async (path) => {
      const flow = await makeFlow({ anonymousDiscovery: "list" });
      const m = modern("tools/call", { name: "list_vaults", arguments: {} }, 7);
      const r = await rpc(flow, path, m.body, undefined, m.headers);
      expect(r.status).toBe(200);
      expect(r.json.id).toBe(7);
      expect(r.json.result.isError).toBe(true);
      expect(r.json.result.content[0].type).toBe("text");
      expect(r.json.result._meta["mcp/www_authenticate"][0]).toContain(
        `resource_metadata="${prmOf(path)}"`,
      );
    },
  );

  it.each(PATHS)("%s: nothing else is open to an anonymous caller", async (path) => {
    const flow = await makeFlow({ anonymousDiscovery: "list", tools: TOOLS });
    for (const method of [
      "resources/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
      "tasks/get",
      "subscriptions/listen",
      "logging/setLevel",
      "completion/complete",
      "tools/nope",
    ]) {
      const r = await rpc(flow, path, legacy(method));
      expect(r.status, method).toBe(401);
      expect(r.www, method).toBe(challengeFor(path));
    }
    // A batch smuggling a call behind an allowed method is refused whole.
    const batch = await rpc(flow, path, [
      legacy("tools/list", {}, 1),
      legacy("tools/call", { name: "list_vaults", arguments: {} }, 2),
    ]);
    expect(batch.status).toBe(401);
    // A tools/call that is a notification (no id) has nowhere to put a tool error.
    const note = await rpc(flow, path, legacy("tools/call", { name: "list_vaults" }, null));
    expect(note.status).toBe(401);
  });

  it.each(PATHS)("%s: a bad token is never downgraded to anonymous", async (path) => {
    const flow = await makeFlow({ anonymousDiscovery: "list" });
    for (const method of ["initialize", "tools/list", "tools/call", "ping"]) {
      const r = await rpc(flow, path, legacy(method, { name: "list_vaults" }), "not.a.jwt");
      expect(r.status, method).toBe(401);
      expect(r.www, method).toBe(challengeFor(path));
    }
  });

  it.each(PATHS)("%s: an oversized anonymous body is refused unparsed", async (path) => {
    const flow = await makeFlow({ anonymousDiscovery: "list" });
    const big = { ...legacy("tools/list"), padding: "x".repeat(200 * 1024) };
    const r = await rpc(flow, path, big);
    expect(r.status).toBe(401);
    expect(r.www).toBe(challengeFor(path));
  });

  it("a facade surface declares the default scopes on its meta-tools", async () => {
    const flow = await makeFlow({ anonymousDiscovery: "list", tools: TOOLS });
    const m = modern("tools/list");
    const r = await rpc(flow, "/mcp/triad", m.body, undefined, m.headers);
    expect(r.status).toBe(200);
    const tools = r.json.result.tools as any[];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.securitySchemes, t.name).toEqual([{ type: "oauth2", scopes: ["read:*"] }]);
    }
  });

  it("with scopesSupported the anonymous list is still exactly the default-scope list", async () => {
    const scopesSupported = ["read:vault", "write:notes"];
    const flow = await makeFlow({ anonymousDiscovery: "list", scopesSupported, tools: TOOLS });
    const names = async (token?: string) => {
      const c = clientFor(flow, "/mcp", token);
      await c.client.connect(c.transport);
      const out = (await c.client.listTools()).tools.map((t) => t.name).sort();
      await c.client.close();
      return out;
    };
    const { access } = await issue(flow, { scope: undefined });
    expect(await names()).toEqual(await names(access));
    // admin:vault is outside the advertised vocabulary, so the anonymous list never shows it.
    expect(await names()).not.toContain("admin_probe");
  });

  it.each(PATHS)("%s: a credential of another scheme is not anonymous either", async (path) => {
    const flow = await makeFlow({ anonymousDiscovery: "list" });
    for (const authorization of ["Basic dXNlcjpwYXNz", "Token abc", "Bearerx"]) {
      const r = await rpc(flow, path, legacy("tools/list"), undefined, { authorization });
      expect(r.status, authorization).toBe(401);
    }
    // A bare `Bearer` carries no credential: anonymous, like no header at all.
    const bare = await rpc(flow, path, legacy("tools/list"), undefined, {
      authorization: "Bearer",
    });
    expect(bare.status).toBe(200);
  });

  it.each(PATHS)("%s: a signed-in caller keeps working, with the same schemes", async (path) => {
    const flow = await makeFlow({ anonymousDiscovery: "list" });
    const { access } = await issue(flow, { scope: "read:vault" });
    const m = modern("tools/list");
    const listed = await rpc(flow, path, m.body, access, m.headers);
    const tools = listed.json.result.tools as { securitySchemes?: unknown }[];
    if (path === "/mcp") expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.securitySchemes).toBeDefined();
    expect(listed.json.result.tools[0].securitySchemes).toBeDefined();
    const { client, transport } = clientFor(flow, path, access);
    await client.connect(transport);
    const result: any = await client.callTool({ name: "list_vaults", arguments: {} });
    await client.close();
    expect(result.isError).not.toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toBeUndefined();
  });
});

describe("auth.anonymousDiscovery config", () => {
  const parse = (auth: Record<string, unknown>) =>
    ServerConfigSchema.safeParse({ vaults: [{ id: "v", path: "/tmp/v" }], auth });
  const jwt = { mode: "jwt", jwtSecret: "x".repeat(40), resource: RESOURCE };

  it("is unset by default (none) and accepts list with OAuth + resource", () => {
    const none = parse(jwt);
    expect(none.success && none.data.auth.anonymousDiscovery).toBeUndefined();
    expect(none.success).toBe(true);
    const list = parse({ ...jwt, anonymousDiscovery: "list" });
    expect(list.success && list.data.auth.anonymousDiscovery).toBe("list");
  });

  it("refuses list without OAuth, without a resource, or an unknown value", () => {
    expect(parse({ mode: "none", anonymousDiscovery: "list" }).success).toBe(false);
    expect(
      parse({ mode: "jwt", jwtSecret: "x".repeat(40), anonymousDiscovery: "list" }).success,
    ).toBe(false);
    expect(parse({ ...jwt, anonymousDiscovery: "all" }).success).toBe(false);
  });
});
