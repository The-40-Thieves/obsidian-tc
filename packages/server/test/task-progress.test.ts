// Claude Code aborts a remote call after five minutes without progress, and most SDK clients reset
// their per-request timeout on every `notifications/progress`. So a long tool has to emit them
// whenever the caller supplied a `progressToken` (and only then: an unsolicited progress
// notification names a token the client never issued).
//
// Two paths carry a long call: a plain synchronous dispatch, and the budgeted wait on a task job
// (task-budget.test.ts). Both are covered. The handlers report through `ctx.progress`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { JobQueue } from "../src/scheduler/job-queue";
import { makeStartTask } from "../src/scheduler/task-call-runner";
import { openMemoryDb } from "./helpers";

interface Update {
  progress: number;
  total?: number;
  message?: string;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function rig(augmentable: boolean) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
  const registry = new ToolRegistry();
  registry.register({
    name: "walker",
    description: "reports three steps",
    inputSchema: z.object({ vault: z.string().optional() }),
    requiredScopes: [],
    taskAugmentable: augmentable,
    handler: async (_i: unknown, ctx: CallerContext) => {
      for (const step of [1, 2, 3]) {
        ctx.progress?.({ progress: step, total: 3, message: `step ${step}` });
        // Let the notification leave before the next step, as a real batch loop does.
        await new Promise((r) => setTimeout(r, 5));
      }
      return { done: true, sawProgressHook: ctx.progress !== undefined };
    },
  } as unknown as ToolDefinition);
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    acl,
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode: "flat",
    jobQueue: queue,
    startTask: makeStartTask({ registry, db, acl, queue }, "test-runner"),
    taskBudgetMs: 2_000,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(ct);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callWalker(client: Client, withToken: boolean) {
  const updates: Update[] = [];
  const res = await client.callTool(
    { name: "walker", arguments: {} },
    undefined,
    withToken ? { onprogress: (p) => updates.push(p as Update) } : undefined,
  );
  return { res, updates };
}

describe("notifications/progress", () => {
  for (const [label, augmentable] of [
    ["a plain synchronous call", false],
    ["a budgeted wait on a task job", true],
  ] as const) {
    it(`is emitted for ${label} when the caller sent a progressToken`, async () => {
      const client = await rig(augmentable);
      const { res, updates } = await callWalker(client, true);
      expect((res.structuredContent as { done?: boolean }).done).toBe(true);
      expect(updates.map((u) => u.progress)).toEqual([1, 2, 3]);
      expect(updates.at(-1)).toMatchObject({ total: 3, message: "step 3" });
    });

    it(`is NOT emitted for ${label} without a progressToken`, async () => {
      const client = await rig(augmentable);
      const { res, updates } = await callWalker(client, false);
      expect(updates).toEqual([]);
      // No token: the handler is given no hook at all, so a tool never builds a payload for nobody.
      expect((res.structuredContent as { sawProgressHook?: boolean }).sawProgressHook).toBe(false);
    });
  }
});
