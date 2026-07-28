// THE-583: `notifications/tasks` — push task state instead of polling.
//
// Served by US, in front of the SDK handler, for a concrete upstream reason: the extension spec
// routes task notifications through `subscriptions/listen`, but the SDK's SubscriptionFilter is a
// strict four-key object (toolsListChanged / promptsListChanged / resourcesListChanged /
// resourceSubscriptions) and its ServerEvent union is closed over the same four. There is no key a
// client could send through it and no event a server could publish. Same seam and same reason as
// tasks/get, which the handler also rejects as an unknown method.
//
// The property that matters most is OWNERSHIP ON EVERY FRAME. A change feed is the easiest place to
// undo an isolation guarantee, because the push side is what nobody re-checks: `tasks/get` can be
// perfectly scoped while the stream quietly announces every caller's work to everyone.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { JobQueue } from "../src/scheduler/job-queue";
import { createHealthTool } from "../src/tools/admin/health";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";
const TASKS = "io.modelcontextprotocol/tasks";

async function boot(): Promise<{ handle: HttpHandle; queue: JobQueue }> {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
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
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    jobQueue: queue,
  });
  return { handle, queue };
}

async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scopes: ["*"], aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

/** Open a task subscription, run `act` once the ack lands, collect frames until the deadline. */
async function collect(
  port: number,
  jwt: string,
  act: () => void,
  deadlineMs = 3000,
): Promise<Array<Record<string, any>>> {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "subscriptions/listen",
      params: {
        notifications: { [TASKS]: true },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS]: {} } },
        },
      },
    }),
  });
  const frames: Array<Record<string, any>> = [];
  const reader = res.body?.getReader();
  if (!reader) return frames;
  const dec = new TextDecoder();
  let fired = false;
  const stop = setTimeout(() => ac.abort(), deadlineMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
      if (!fired) {
        fired = true;
        act();
      }
    }
  } catch {
    /* aborted at the deadline, which is the normal exit */
  }
  clearTimeout(stop);
  return frames;
}

describe("notifications/tasks (THE-583)", () => {
  it("acknowledges the task subscription and pushes the caller's own task changes", async () => {
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const job = queue.enqueue("mcp_tool_call", { owner: { vaultId: "v1", caller: "agent-1" } });
      const frames = await collect(handle.port, jwt, () => {
        queue.recordOutcome(job.id, { ok: true, result: { ran: true } });
      });
      const ack = frames.find((f) => f.method === "notifications/subscriptions/acknowledged");
      expect(ack?.params?.notifications?.[TASKS]).toBe(true);
      const push = frames.find((f) => f.method === "notifications/tasks");
      expect(push).toBeDefined();
      expect(push?.params?.taskId).toBe(job.id);
      // Full state on the frame — the point is eliminating the extra tasks/get round trip.
      expect(push?.params).toHaveProperty("status");
      expect(push?.params).toHaveProperty("ttlMs");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("NEVER pushes another caller's task", async () => {
    // The isolation case. tasks/get can be perfectly scoped while the push side announces
    // everyone's work to everyone — and nothing would look wrong from either end.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const theirs = queue.enqueue("mcp_tool_call", {
        owner: { vaultId: "v1", caller: "agent-2" },
      });
      const frames = await collect(handle.port, jwt, () => {
        queue.recordOutcome(theirs.id, { ok: true, result: {} });
      });
      expect(frames.some((f) => f.method === "notifications/tasks")).toBe(false);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("NEVER pushes internal maintenance work", async () => {
    // Every pre-existing enqueue call site is this case: no owner, never MCP-visible.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const internal = queue.enqueue("reconcile");
      const frames = await collect(handle.port, jwt, () => {
        queue.recordOutcome(internal.id, { ok: true, result: {} });
      });
      expect(frames.some((f) => f.method === "notifications/tasks")).toBe(false);
      expect(JSON.stringify(frames)).not.toContain("reconcile");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("leaves a core subscriptions/listen to the SDK untouched", async () => {
    // Only intercepted when the client actually asked for task notifications; shadowing the core
    // stream would be a regression in the feature this was built alongside.
    const { handle } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        signal: ac.signal,
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
            notifications: { toolsListChanged: true },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream body");
      const dec = new TextDecoder();
      setTimeout(() => ac.abort(), 1500);
      let text = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value);
        }
      } catch {
        /* deadline */
      }
      // The SDK's ack echoes the CORE filter, not the extension key.
      expect(text).toContain("notifications/subscriptions/acknowledged");
      expect(text).toContain("toolsListChanged");
    } finally {
      await handle.close();
    }
  }, 30_000);
});
