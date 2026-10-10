// Where the time budget applies. The budget decision lives in `dispatchToResult`, the one choke
// point direct, facade (`call_capability`) and domain calls all pass through, so:
//
//   * a long tool reached THROUGH the facade (the default triad) gets the same budget as a direct
//     call; it used to be looked up by the outer tool name and never fired;
//   * stdio (`servesTaskMethods: false`) neither advertises the Tasks extension nor hands a handle
//     to a client that declares it: it has no `tasks/get` route, so that handle could never be polled;
//   * index_vault's output schema admits the handle (a client validates structuredContent against
//     it) without losing a single key of the real result, and reports progress.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { pendingTaskResult } from "../src/mcp/task-budget";
import { JobQueue } from "../src/scheduler/job-queue";
import { makeStartTask } from "../src/scheduler/task-call-runner";
import { IndexVaultOutput } from "../src/tools/m2/index-tools";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function rig(opts: {
  facadeMode: "flat" | "triad";
  servesTaskMethods?: boolean;
  declareTasks?: boolean;
}) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const registry = new ToolRegistry();
  const tool = (name: string, handler: ToolDefinition["handler"]): ToolDefinition =>
    ({
      name,
      description: `test tool ${name}`,
      inputSchema: z.object({ vault: z.string().optional() }),
      requiredScopes: [],
      taskAugmentable: true,
      handler,
    }) as unknown as ToolDefinition;
  registry.register(
    tool("slow_op", async () => {
      await gate;
      return { finished: true };
    }),
  );
  registry.register(tool("fast_op", () => ({ finished: true, fast: true })));
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
    facadeMode: opts.facadeMode,
    jobQueue: queue,
    startTask: makeStartTask({ registry, db, acl, queue }, "test-runner"),
    taskBudgetMs: 40,
    ...(opts.servesTaskMethods === undefined ? {} : { servesTaskMethods: opts.servesTaskMethods }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client(
    { name: "c", version: "0" },
    opts.declareTasks
      ? { capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } as never }
      : {},
  );
  await client.connect(ct);
  open.push(async () => {
    release();
    await client.close();
    await server.close();
  });
  return { client };
}

const structured = (r: unknown) =>
  (r as { structuredContent: Record<string, unknown> }).structuredContent;

describe("the budget through the facade", () => {
  it("call_capability on a long tool answers with a handle after the budget", async () => {
    const { client } = await rig({ facadeMode: "triad" });
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "slow_op", args: {} },
    });
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toMatchObject({
      status: "working",
      tool: "slow_op",
      poll_tool: "get_task_status",
    });
  });

  it("call_capability on a fast tool returns the real result", async () => {
    const { client } = await rig({ facadeMode: "triad" });
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "fast_op", args: {} },
    });
    expect(structured(res)).toEqual({ finished: true, fast: true });
  });
});

describe("a server that does not serve tasks/get (stdio)", () => {
  it("does not advertise the Tasks extension, and one that serves them does", async () => {
    const stdio = await rig({ facadeMode: "flat", servesTaskMethods: false });
    const http = await rig({ facadeMode: "flat" });
    const ext = (c: Client) => (c.getServerCapabilities() as { extensions?: object }).extensions;
    expect(ext(stdio.client)).toBeUndefined();
    expect(ext(http.client)).toHaveProperty("io.modelcontextprotocol/tasks");
  });

  it("answers a client that declares Tasks with the result, never an unpollable handle", async () => {
    const { client } = await rig({
      facadeMode: "flat",
      servesTaskMethods: false,
      declareTasks: true,
    });
    const res = await client.callTool({ name: "fast_op", arguments: {} });
    expect(structured(res)).toEqual({ finished: true, fast: true });
    expect(structured(res)).not.toHaveProperty("resultType");
  });
});

describe("index_vault", () => {
  const RESULT_KEYS = [
    "chunks_deleted",
    "chunks_dedup_unresolved",
    "chunks_upserted",
    "dimensions",
    "embed_batch_rejections",
    "fts_enabled",
    "model",
    "frontmatter_failures",
    "notes_embed_failed",
    "notes_epoch_stale_skipped",
    "notes_frontmatter_failed",
    "notes_indexed",
    "notes_seen",
    "notes_stale_skipped",
    "secrets_skipped",
    "vault",
    "vec_enabled",
  ];

  it("a real result and the handle both round-trip the union with every key kept", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta" } });
    try {
      const r = await v.call("index_vault", { vault: v.id });
      if (!r.ok) throw new Error(r.error.message);
      const parsed = IndexVaultOutput.parse(r.data);
      // Zod objects are not strict: an entry missing from the schema is stripped and still parses,
      // and a union snapshots as no keys at all, so compare the key sets themselves.
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(r.data as object).sort());
      expect(Object.keys(parsed)).toEqual(expect.arrayContaining(RESULT_KEYS));

      const handle = structured(
        pendingTaskResult("index_vault", { id: "job-1" } as Parameters<
          typeof pendingTaskResult
        >[1]),
      );
      const parsedHandle = IndexVaultOutput.parse(handle);
      expect(Object.keys(parsedHandle).sort()).toEqual(Object.keys(handle).sort());
      expect(parsedHandle).toMatchObject({ status: "working", poll_tool: "get_task_status" });
    } finally {
      v.cleanup();
    }
  });

  it("reports progress in notes, with the total, when the caller supplied a hook", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta", "c.md": "# C\n\ngamma" },
    });
    try {
      const updates: Array<{ progress: number; total?: number; message?: string }> = [];
      const r = await v.call("index_vault", { vault: v.id }, { progress: (u) => updates.push(u) });
      expect(r.ok).toBe(true);
      expect(updates.length).toBeGreaterThan(0);
      const last = updates.at(-1);
      expect(last).toMatchObject({ progress: 3, total: 3 });
      expect(last?.message).toContain("3/3 notes");
      const values = updates.map((u) => u.progress);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    } finally {
      v.cleanup();
    }
  });
});
