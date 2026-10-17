import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const handles: HttpApp[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

function app(
  extra: { enableDnsRebindingProtection?: boolean; allowedHosts?: string[] } = {},
): HttpApp {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
    },
  }).auth;
  const handle = createHttpApp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: new ToolRegistry(),
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    ...extra,
  });
  handles.push(handle);
  return handle;
}

const healthz = (handle: HttpApp, init?: RequestInit) =>
  handle.app.request("http://127.0.0.1:8765/healthz", init);

describe("GET /healthz", () => {
  it("returns the exact liveness response without Authorization under required JWT auth", async () => {
    const response = await healthz(app(), { headers: { host: "127.0.0.1:8765" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a disallowed Host when DNS-rebinding protection is on", async () => {
    const response = await healthz(app(), { headers: { host: "evil.example" } });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("host not allowed");
  });

  it("allows a Host the operator listed in allowedHosts", async () => {
    const response = await healthz(app({ allowedHosts: ["vault.example.com"] }), {
      headers: { host: "vault.example.com" },
    });

    expect(response.status).toBe(200);
  });

  it("allows a disallowed Host when DNS-rebinding protection is off", async () => {
    const response = await healthz(app({ enableDnsRebindingProtection: false }), {
      headers: { host: "evil.example" },
    });

    expect(response.status).toBe(200);
  });
});

describe("other /healthz methods", () => {
  it("serves HEAD from GET with an empty body", async () => {
    const response = await healthz(app(), {
      method: "HEAD",
      headers: { host: "127.0.0.1:8765" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("does not serve POST", async () => {
    const response = await healthz(app(), {
      method: "POST",
      headers: { host: "127.0.0.1:8765" },
    });

    expect(response.status).not.toBe(200);
  });
});
