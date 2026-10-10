// resources/list must ALWAYS carry a `resources` array (BerriAI/litellm #29826: LiteLLM's gateway
// parses `ListResourcesResult.resources` as required, so a server that answers `{}` on an empty
// vault is dropped from federation and every probe waits ~30s on it). Asserted ON THE WIRE (raw
// JSON-RPC over real HTTP, modern era), not through the SDK client, because the client's own schema
// parse can mask a missing field behind a default.
//
// Cases: an empty vault, a caller who may not read notes, and a cursor past the end of the list.
// The no-vault server is pinned separately: it declares no `resources` capability at all, so a
// compliant client never asks (production always has a vault registry; see mcp/server.ts).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { createHealthTool } from "../src/tools/admin/health";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

let handle: HttpHandle;
let vaultRoot: string;
let fullJwt: string;
let noReadJwt: string;

async function sign(scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "a", scopes, aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

beforeAll(async () => {
  vaultRoot = makeTempDir("obsidian-tc-reslist-"); // deliberately EMPTY: no notes at all
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  registry.register(
    createHealthTool({
      version: "0.0.0-test",
      vaults: ["v1"],
      startedAt: Date.now(),
      nativeLoaded: false,
      vecEnabled: false,
    }),
  );
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    vaultRegistry: new VaultRegistry([{ id: "v1", path: vaultRoot }]),
  });
  fullJwt = await sign(["*"]);
  noReadJwt = await sign(["write:notes"]);
}, stallTimeout(30_000));

afterAll(async () => {
  await handle?.close();
  if (vaultRoot) rmTemp(vaultRoot);
});

async function rawList(jwt: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "resources/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "litellm-probe", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text) as {
    result?: { resources?: unknown; nextCursor?: unknown };
    error?: unknown;
  };
}

describe("resources/list always carries a `resources` array (LiteLLM #29826)", () => {
  it(
    "an empty vault: the array is present (the catalog row), never `{}`",
    async () => {
      const r = await rawList(fullJwt);
      expect(r.error).toBeUndefined();
      expect(Array.isArray(r.result?.resources)).toBe(true);
      const rows = (r.result?.resources ?? []) as Array<{ uri: string }>;
      expect(rows.map((x) => x.uri)).toEqual(["obsidian-tc://catalog"]);
    },
    stallTimeout(20_000),
  );

  it(
    "a caller without read:notes gets an EMPTY array, not an error and not a missing field",
    async () => {
      const r = await rawList(noReadJwt);
      expect(r.error).toBeUndefined();
      expect(r.result).toBeDefined();
      expect("resources" in (r.result ?? {})).toBe(true);
      expect(r.result?.resources).toEqual([]);
    },
    stallTimeout(20_000),
  );

  it(
    "a cursor past the end of the list answers an empty array",
    async () => {
      writeFileSync(join(vaultRoot, "a.md"), "# A");
      const r = await rawList(fullJwt, { cursor: "9999" });
      expect(r.error).toBeUndefined();
      expect(r.result?.resources).toEqual([]);
      expect(r.result?.nextCursor).toBeUndefined();
    },
    stallTimeout(20_000),
  );

  it(
    "templates/list is also an array on an empty server",
    async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${fullJwt}`,
          "mcp-protocol-version": MODERN,
          "mcp-method": "resources/templates/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "resources/templates/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": { name: "litellm-probe", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      const body = JSON.parse(line ? line.slice(6) : text) as {
        result?: { resourceTemplates?: unknown };
      };
      expect(body.result?.resourceTemplates).toEqual([]);
    },
    stallTimeout(20_000),
  );
});

describe("a server with no vault registry", () => {
  it("declares no `resources` capability, so resources/list is never part of its contract", async () => {
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: new ToolRegistry(),
      context: () => ({
        caller: "t",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db: {} as never,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await client.close();
    await server.close();
  });
});
