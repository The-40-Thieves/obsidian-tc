// THE-583: `tasks/get` and `tasks/cancel` over the wire.
//
// The projection and the ownership filter are unit-tested in mcp-tasks.test.ts. What can only be
// tested here is that the extension is actually REACHABLE and actually ISOLATED end to end: that
// the methods route at all (they are not in the SDK's registry — the types do not even admit them),
// that they are absent on a 2025 connection, and that the ownership check runs on the real caller
// context rather than on whatever the test hands it.
//
// The isolation cases are the point. A `tasks/get` that answered for someone else's id would look
// completely normal in a passing suite — the queue would return a job, the projection would render
// it, and nothing would throw.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { JobQueue } from "../src/scheduler/job-queue";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "tasks-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function boot() {
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

/** A token for `sub`, bound to vault v1 (the server default when the token names none). */
async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scopes: ["*"], aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

async function rpc(
  port: number,
  jwt: string,
  method: string,
  params: Record<string, unknown>,
  version = MODERN,
): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": version,
      ...(version === MODERN ? { "mcp-method": method } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: version === MODERN ? { ...params, _meta: META } : params,
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text || "{}");
}

describe("tasks/get over the wire (THE-583)", () => {
  it("returns a task the caller owns", async () => {
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const job = queue.enqueue("caller_work", { owner: { vaultId: "v1", caller: "agent-1" } });
      const r = await rpc(handle.port, jwt, "tasks/get", { taskId: job.id });
      expect(r.error).toBeUndefined();
      expect(r.result.taskId).toBe(job.id);
      expect(r.result.status).toBe("working");
      expect(r.result.pollInterval).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  }, 25_000);

  it("HIDES internal maintenance work — the jobs nobody asked for", async () => {
    // Reconcile, contradiction, synthesis, audit: all enqueued with no owner. Their payload and
    // last_error carry vault paths and error text, and they are not the caller's tasks.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const internal = queue.enqueue("reconcile");
      const r = await rpc(handle.port, jwt, "tasks/get", { taskId: internal.id });
      expect(r.result).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("reconcile");
    } finally {
      await handle.close();
    }
  }, 25_000);

  it("HIDES another caller's task, indistinguishably from a missing one", async () => {
    // Identical answers, deliberately: a different error for "exists but not yours" confirms an id
    // is real, which is enough to enumerate another caller's ids by probing.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const theirs = queue.enqueue("caller_work", { owner: { vaultId: "v1", caller: "agent-2" } });
      const foreign = await rpc(handle.port, jwt, "tasks/get", { taskId: theirs.id });
      const missing = await rpc(handle.port, jwt, "tasks/get", { taskId: "no-such-task" });
      expect(foreign.result).toBeUndefined();
      expect(missing.result).toBeUndefined();
      expect(foreign.error?.code).toBe(missing.error?.code);
      expect(foreign.error?.message).toBe(missing.error?.message);
    } finally {
      await handle.close();
    }
  }, 25_000);

  it("is NOT served on a 2025 connection — Tasks does not exist in that revision", async () => {
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const job = queue.enqueue("caller_work", { owner: { vaultId: "v1", caller: "agent-1" } });
      const r = await rpc(handle.port, jwt, "tasks/get", { taskId: job.id }, LEGACY);
      expect(r.result).toBeUndefined();
      expect(r.error).toBeDefined();
    } finally {
      await handle.close();
    }
  }, 25_000);
});

describe("tasks/cancel over the wire (THE-583)", () => {
  it("requests cancellation and reports the task still WORKING until it stops", async () => {
    // The queue honours cancellation at the runner's next checkpoint. Reporting `cancelled` the
    // instant it is requested would tell the client the work has stopped while it is still running
    // — and still mutating the vault.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const job = queue.enqueue("caller_work", { owner: { vaultId: "v1", caller: "agent-1" } });
      const r = await rpc(handle.port, jwt, "tasks/cancel", { taskId: job.id });
      expect(r.error).toBeUndefined();
      expect(r.result.status).toBe("working");
      // The request itself did land, which is what the client asked for.
      expect(queue.isCancelRequested(job.id)).toBe(true);
    } finally {
      await handle.close();
    }
  }, 25_000);

  it("refuses to cancel a task the caller does not own", async () => {
    // The one that matters most: cancelling someone else's work is a write, not a read.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const theirs = queue.enqueue("caller_work", { owner: { vaultId: "v1", caller: "agent-2" } });
      const r = await rpc(handle.port, jwt, "tasks/cancel", { taskId: theirs.id });
      expect(r.result).toBeUndefined();
      expect(queue.isCancelRequested(theirs.id)).toBe(false);
    } finally {
      await handle.close();
    }
  }, 25_000);

  it("refuses to cancel internal maintenance work", async () => {
    // Otherwise any caller could stop the server's own reconcile.
    const { handle, queue } = await boot();
    const jwt = await tokenFor("agent-1");
    try {
      const internal = queue.enqueue("reconcile");
      const r = await rpc(handle.port, jwt, "tasks/cancel", { taskId: internal.id });
      expect(r.result).toBeUndefined();
      expect(queue.isCancelRequested(internal.id)).toBe(false);
    } finally {
      await handle.close();
    }
  }, 25_000);
});
