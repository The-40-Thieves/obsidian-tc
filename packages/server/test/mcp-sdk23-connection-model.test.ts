// SDK 2.3 made two things strict: a `Server` serves ONE connection at a time (`connect()` rejects
// with ALREADY_CONNECTED), and a stateless Streamable HTTP transport serves ONE request. Both are
// invisible to a test that sends requests one after another, which is how the whole suite sends
// them. This drives the two shapes the rule actually bites on:
//
//   - two requests IN FLIGHT AT THE SAME TIME through the real `startHttp` handler (the
//     `createMcpHandler` factory must hand each its own server), proven by a rendezvous inside the
//     tool that can only complete if both requests are being served concurrently;
//   - a stdio round trip over the real `StdioServerTransport`, plus the refusal a second connect
//     gets, so the process-lifetime-single-connection assumption is pinned rather than implied.

import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { startHttp } from "../src/transports/http";
import { connectStdio } from "../src/transports/stdio";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

function rendezvousRegistry(parties: number) {
  const registry = new ToolRegistry();
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.register({
    name: "rendezvous",
    description: "test-only: completes only once `parties` requests are inside it together",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: async (_a: unknown, ctx: CallerContext) => {
      if (++arrived >= parties) release();
      await gate;
      return { caller: ctx.caller, arrived };
    },
  } as never);
  return registry;
}

async function bootHttp(registry: ToolRegistry) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "alpha", path: "/tmp/alpha" }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "alpha",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
}

async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scopes: ["read:notes"], aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

async function callRendezvous(port: number, jwt: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": "rendezvous",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rendezvous",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "overlap", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text || "{}");
  return { status: res.status, ...body };
}

describe("SDK 2.3 one-connection-per-server rule", () => {
  it(
    "serves two OVERLAPPING requests through the real HTTP handler, each on its own server",
    async () => {
      const handle = await bootHttp(rendezvousRegistry(2));
      try {
        const [a, b] = await Promise.all([
          callRendezvous(handle.port, await tokenFor("agent-a")),
          callRendezvous(handle.port, await tokenFor("agent-b")),
        ]);
        // Neither is an ALREADY_CONNECTED error: both completed a tool call, and the tool only
        // returns once both were inside it at once, so the two were genuinely concurrent.
        for (const [r, who] of [
          [a, "agent-a"],
          [b, "agent-b"],
        ] as const) {
          expect(r.status).toBe(200);
          expect(r.error).toBeUndefined();
          const result = r.result as { isError?: boolean; structuredContent?: { caller: string } };
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent?.caller).toBe(who);
        }
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "a stdio round trip works over the real transport, and a second connect is refused",
    async () => {
      const db = openMemoryDb();
      provisionCacheDb(db);
      const registry = new ToolRegistry();
      registry.register({
        name: "ping",
        description: "test-only",
        inputSchema: z.object({}),
        requiredScopes: [],
        handler: () => ({ pong: true }),
      } as never);
      const server = createMcpServer({
        name: "obsidian-tc",
        version: "0.0.0-test",
        registry,
        context: (): CallerContext => ({
          caller: "stdio",
          authenticated: true,
          grantedScopes: new Set(["*"]),
          vaultId: "v1",
          db,
        }),
        visibility: { grantedScopes: new Set(["*"]) },
      });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const lines: string[] = [];
      let pending = "";
      stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          lines.push(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      });
      const reply = async (id: number): Promise<Record<string, any>> => {
        for (let i = 0; i < 400; i++) {
          const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`no stdio reply for id ${id}`);
      };
      const send = (m: object) => stdin.write(`${JSON.stringify(m)}\n`);

      const transport = await connectStdio(server, { stdin, stdout });
      try {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "stdio-test", version: "1" },
          },
        });
        expect((await reply(1)).result.serverInfo.name).toBe("obsidian-tc");
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        });
        const call = (await reply(2)).result;
        expect(call.isError).toBeFalsy();
        expect(call.structuredContent).toEqual({ pong: true });

        // The rule itself: this server is spoken for until its transport closes.
        await expect(
          connectStdio(server, { stdin: new PassThrough(), stdout: new PassThrough() }),
        ).rejects.toThrow(/separate Server instance|already connected/i);
      } finally {
        await transport.close();
      }
    },
    stallTimeout(30_000),
  );
});

describe("SDK 2.3 prompts/get without `arguments`", () => {
  it("still renders a prompt whose arguments are all optional, and still refuses a missing required one", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const server = createMcpServer({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry: new ToolRegistry(),
      context: (): CallerContext => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "prompt-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      // `arguments` is omitted on the wire: prompts/get params are { name } only.
      const digest = await client.getPrompt({ name: "recent_changes_digest" });
      expect(digest.messages.length).toBeGreaterThan(0);
      await expect(client.getPrompt({ name: "summarize_note" })).rejects.toThrow(/path/);
    } finally {
      await client.close();
    }
  });
});
