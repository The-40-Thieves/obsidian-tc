// THE-583 (SEP-2575): `subscriptions/listen` — the single long-lived stream that REPLACED the HTTP
// GET endpoint and resources/subscribe/unsubscribe.
//
// This is the feature the persistent-handler restructure exists for. It was unreachable before, and
// not because it was unimplemented — the SDK routes the method and owns the wire semantics. It was
// unreachable because the handler serving the stream was closed the instant the request that
// created it returned (`finally { handler.close() }`), so the stream died at birth.
//
// The trap this caught, worth keeping: the handler acknowledges a subscription only for types the
// SERVER declared via `listChanged` capabilities. Without them the stream opens, returns HTTP 200
// and a well-formed ack carrying `notifications: {}` — an EMPTY filter — and every subsequent
// publish reaches zero listeners. Nothing errors on either side; the client simply waits forever.
// Mutation-verified: dropping `tools.listChanged` turns the first test below red.
//
// What is worth asserting here is DELIVERY, not registration: that a stream opened by one request
// receives an event published by something outside any request at all (the vault watcher's real
// case). A test that only checked the method routes would have passed against the old per-request
// handler too, right up until a client tried to hold the stream open.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

async function boot(): Promise<HttpHandle> {
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
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
}

async function token(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "agent-1",
    scopes: ["*"],
    aud: "http://test",
    iat: now,
    exp: now + 600,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

/** Open a listen stream and collect frames until `want` arrive or the deadline passes. */
async function listen(
  port: number,
  jwt: string,
  subscriptions: Record<string, unknown>,
  onOpen: () => void,
  want: number,
  deadlineMs = 8000,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "subscriptions/listen",
      params: {
        notifications: subscriptions,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "sub-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const reader = res.body?.getReader();
  if (!reader) return [];
  const frames: Array<Record<string, unknown>> = [];
  const decoder = new TextDecoder();
  const started = Date.now();
  let opened = false;
  let buf = "";
  while (frames.length < want && Date.now() - started < deadlineMs) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 1500),
      ),
    ]);
    if (chunk.value) buf += decoder.decode(chunk.value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        frames.push(JSON.parse(line.slice(6)));
      } catch {
        /* partial frame; the next chunk completes it */
      }
    }
    buf = buf.includes("\n") ? buf.slice(buf.lastIndexOf("\n") + 1) : buf;
    // The ack lands first; publish only once the stream is actually registered, or the event
    // races ahead of the listener and is delivered to nobody.
    if (!opened && frames.length > 0) {
      opened = true;
      onOpen();
    }
    if (chunk.done && chunk.value === undefined && frames.length >= want) break;
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

describe("subscriptions/listen (SEP-2575)", () => {
  it("acknowledges the subscription and DELIVERS an event published outside any request", async () => {
    const handle = await boot();
    const jwt = await token();
    try {
      const frames = await listen(
        handle.port,
        jwt,
        { toolsListChanged: true },
        // The real case: nothing is in flight when the vault watcher fires. Publishing through the
        // handle is the only path an out-of-band change has to an open stream.
        () => handle.notify.toolsChanged(),
        2,
      );
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const methods = frames.map((f) => (f as { method?: string }).method);
      expect(methods).toContain("notifications/tools/list_changed");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("does not deliver a type the client did not opt into", async () => {
    // Opt-in is the whole point of the mechanism: a stream that receives everything is the old
    // standalone SSE endpoint this replaced.
    const handle = await boot();
    const jwt = await token();
    try {
      const frames = await listen(
        handle.port,
        jwt,
        { toolsListChanged: true },
        () => handle.notify.promptsChanged(),
        2,
        4000,
      );
      const methods = frames.map((f) => (f as { method?: string }).method);
      expect(methods).not.toContain("notifications/prompts/list_changed");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("publishing with no stream open is a no-op, not a throw", async () => {
    // The common case by far: the watcher fires constantly and nobody is listening.
    const handle = await boot();
    try {
      expect(() => handle.notify.toolsChanged()).not.toThrow();
      expect(() => handle.notify.resourcesChanged()).not.toThrow();
      expect(() => handle.notify.resourceUpdated("obsidian://v1/x.md")).not.toThrow();
    } finally {
      await handle.close();
    }
  }, 20_000);
});
