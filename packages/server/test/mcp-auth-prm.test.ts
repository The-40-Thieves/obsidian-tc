import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);
const AS = "https://as.example.com";
const RES = "https://mcp.example.com/mcp";
const POST = {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
};

function authOf(input: unknown): ServerConfig["auth"] {
  return ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: input }).auth;
}
async function boot(auth: ServerConfig["auth"]) {
  const db = openMemoryDb();
  db.exec(schemaSql);
  const registry = new ToolRegistry();
  registry.register(
    createHealthTool({
      version: "t",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
    }),
  );
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "t",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

describe("THE-278 Protected Resource Metadata (RFC 9728)", () => {
  it("serves the PRM document at both well-known paths when resource + AS are configured", async () => {
    const { handle, base } = await boot(
      authOf({
        mode: "none",
        resource: RES,
        authorizationServers: [AS],
        scopesSupported: ["read:notes"],
        resourceName: "obsidian-tc",
      }),
    );
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      const doc = (await r.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(RES);
      expect(doc.authorization_servers).toEqual([AS]);
      expect(doc.scopes_supported).toEqual(["read:notes"]);
      expect(doc.resource_name).toBe("obsidian-tc");
    }
    await handle.close();
  });

  it("does not serve a PRM document when unconfigured (404)", async () => {
    const { handle, base } = await boot(authOf({ mode: "none" }));
    const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(404);
    await handle.close();
  });

  it("emits WWW-Authenticate resource_metadata on 401 only when PRM is configured", async () => {
    const secret = "s".repeat(40);
    const withPrm = await boot(
      authOf({ mode: "jwt", jwtSecret: secret, resource: RES, authorizationServers: [AS] }),
    );
    const r1 = await fetch(`${withPrm.base}/mcp`, POST);
    expect(r1.status).toBe(401);
    expect(r1.headers.get("www-authenticate") ?? "").toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    );
    await withPrm.handle.close();

    const noPrm = await boot(authOf({ mode: "jwt", jwtSecret: secret }));
    const r2 = await fetch(`${noPrm.base}/mcp`, POST);
    expect(r2.status).toBe(401);
    expect(r2.headers.get("www-authenticate")).toBeNull();
    await noPrm.handle.close();
  });
});
