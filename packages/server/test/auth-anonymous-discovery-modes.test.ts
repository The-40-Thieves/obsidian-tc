// `auth.anonymousDiscovery` under auth.mode jwt (external authorization server) and oidc: the same
// behaviour as the bundled-AS flow in auth-anonymous-discovery.test.ts, because one resolveAuth and
// one anonymous gate (transports/anonymous-discovery.ts) serve every mode. Real HTTP app, no mocks of
// the gate itself; the oidc verifier talks to the local mock IdP.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { createOidcVerifier } from "../src/auth/oidc";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { AUDIENCE, ISSUER, publicResolver, startMockIdp } from "./oidc-mock-provider";

const RESOURCE = "https://vault.example.com/mcp";
const PRM_URL = "https://vault.example.com/.well-known/oauth-protected-resource/mcp";

const rpcBody = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

async function boot(auth: Record<string, unknown>, withIdp: boolean) {
  const parsed = ServerConfigSchema.parse({ vaults: [{ id: "v", path: "/tmp/v" }], auth });
  const idp = withIdp ? await startMockIdp() : undefined;
  const verifier = idp
    ? await createOidcVerifier(parsed.auth, { fetch: idp.fetch, resolveHost: publicResolver })
    : undefined;
  const registry = new ToolRegistry();
  registry.register({
    name: "read_probe",
    description: "test-only",
    inputSchema: z.object({}),
    requiredScopes: ["read:notes"],
    handler: () => ({}),
  } as never);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const { app } = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry,
    auth: parsed.auth,
    db,
    vaultId: "v",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
    ...(verifier ? { verifier } : {}),
  } as Parameters<typeof createHttpApp>[0]);
  const post = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await app.request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(rpcBody(method, params)),
    });
    // A legacy-era answer may come as one SSE frame (`event: message\ndata: {...}`).
    const text = await res.text();
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
    return {
      status: res.status,
      www: res.headers.get("www-authenticate"),
      json: JSON.parse(data) as any,
    };
  };
  return { post, close: async () => idp?.close() };
}

const JWT = {
  mode: "jwt",
  jwtSecret: "s".repeat(40),
  resource: RESOURCE,
  authorizationServers: ["https://as.example.com"],
};
const OIDC = { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE }, resource: RESOURCE };
const MODES = [
  ["jwt", JWT, false],
  ["oidc", OIDC, true],
] as const;

describe.each(MODES)("auth.mode %s", (_name, auth, withIdp) => {
  it("default: 401 + challenge to initialize, ping, tools/list and tools/call", async () => {
    const { post, close } = await boot({ ...auth }, withIdp);
    for (const method of ["initialize", "ping", "tools/list", "tools/call"]) {
      const r = await post(method, { name: "read_probe", arguments: {} });
      expect(r.status, method).toBe(401);
      expect(r.www, method).toContain(`resource_metadata="${PRM_URL}"`);
    }
    await close();
  });

  it("list: tools/list is open, tools/call is a tool error with the challenge, the rest is 401", async () => {
    const { post, close } = await boot({ ...auth, anonymousDiscovery: "list" }, withIdp);
    const listed = await post("tools/list");
    expect(listed.status).toBe(200);
    expect(listed.json.result.tools.map((t: { name: string }) => t.name)).toContain("read_probe");
    const call = await post("tools/call", { name: "read_probe", arguments: {} });
    expect(call.status).toBe(200);
    expect(call.json.result.isError).toBe(true);
    expect(call.json.result._meta["mcp/www_authenticate"][0]).toContain(
      `resource_metadata="${PRM_URL}"`,
    );
    expect((await post("resources/list")).status).toBe(401);
    await close();
  });
});

describe("list mode needs a complete Protected Resource Metadata", () => {
  it("resource without an authorization server stays a plain 401 (no challenge to link from)", async () => {
    const { post } = await boot(
      { mode: "jwt", jwtSecret: "s".repeat(40), resource: RESOURCE, anonymousDiscovery: "list" },
      false,
    );
    const r = await post("tools/list");
    expect(r.status).toBe(401);
    expect(r.www).toBeNull();
  });
});
