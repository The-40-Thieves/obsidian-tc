// A tool that runs as a task must be held to exactly the policy it would have met synchronously.
//
// The offload happens BEFORE registry dispatch, and the worker rebuilds its CallerContext from a
// job payload. A context rebuilt field by field silently drops whatever nobody copied, and what was
// dropped was `toolVisibility`: a persona that disabled `external-network` got `not_found` from a
// synchronous call, while the same persona's `index_vault` ran as a task and sent vault content to
// the embedding provider. So this file pins the whole class, not the one field:
//
//   * the persona case, end to end and at the worker (the tasks-extension path shares the runner);
//   * every CallerContext key is classified (carried / rebuilt / dropped-with-a-reason), and every
//     key the dispatch pipeline reads is in that table, so a new policy field cannot be forgotten;
//   * every carried key survives the JSON round trip a job payload takes;
//   * a HITL-gated tool cannot opt into offload (its round cannot cross the enqueue).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { offloadToTask } from "../src/mcp/task-budget";
import {
  CALLER_CONTEXT_DISPOSITION,
  restoreCaller,
  snapshotCaller,
} from "../src/mcp/task-caller-context";
import {
  TASK_CALL_JOB_TYPE,
  TASK_CALL_PAYLOAD_VERSION,
  type TaskCallPayload,
} from "../src/mcp/tasks";
import { JobQueue } from "../src/scheduler/job-queue";
import { makeStartTask, runTaskCall } from "../src/scheduler/task-call-runner";
import {
  droppedButRead,
  openProject,
  scanCallerContextReads,
  UNNAMED_READS,
} from "./caller-context-reads";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SRC = join(__dirname, "..", "src");
const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
const PERSONA_MASK: ToolVisibilityConfig = {
  hidden: [],
  disabled: [],
  hiddenTags: [],
  disabledTags: ["external-network"],
  requireReadOnly: false,
};

function makeRegistry(calls: { n: number }): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "net_index",
    description: "stands in for index_vault: long, and sends content to an external provider",
    inputSchema: z.object({ vault: z.string().optional() }),
    requiredScopes: ["admin:vault"],
    tags: ["external-network"],
    taskAugmentable: true,
    handler: () => {
      calls.n++;
      return { sent: true };
    },
  } as unknown as ToolDefinition);
  return registry;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function personaRig(declareTasks: boolean) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
  const calls = { n: 0 };
  const registry = makeRegistry(calls);
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context: (): CallerContext => ({
      caller: "alice",
      authenticated: true,
      grantedScopes: new Set(["admin:vault"]),
      vaultId: "v1",
      db,
      acl,
      persona: "researcher",
      toolVisibility: PERSONA_MASK,
    }),
    visibility: { grantedScopes: new Set(["admin:vault"]) },
    facadeMode: "flat",
    jobQueue: queue,
    startTask: makeStartTask({ registry, db, acl, queue }, "test-runner"),
    taskBudgetMs: 200,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client(
    { name: "c", version: "0" },
    declareTasks
      ? { capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } as never }
      : {},
  );
  await client.connect(ct);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queue, calls };
}

const total = (q: JobQueue): number =>
  Object.values(q.stats()).reduce<number>((a, b) => a + (typeof b === "number" ? b : 0), 0);

describe("a persona's tool mask holds for a task-backed tool", () => {
  it("a budgeted caller gets not_found, no job exists, and the tool never ran", async () => {
    const { client, queue, calls } = await personaRig(false);
    const res = await client.callTool({ name: "net_index", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/not_found|unknown tool/);
    expect(calls.n).toBe(0);
    expect(total(queue)).toBe(0);
  });

  it("a Tasks-extension caller gets the same refusal, not a handle", async () => {
    const { client, queue, calls } = await personaRig(true);
    const res = await client.callTool({ name: "net_index", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain("resultType");
    expect(calls.n).toBe(0);
    expect(total(queue)).toBe(0);
  });

  it("the worker enforces the mask too, from the payload alone (defence in depth)", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const queue = new JobQueue(db);
    const calls = { n: 0 };
    const registry = makeRegistry(calls);
    const ctx: CallerContext = {
      caller: "alice",
      authenticated: true,
      grantedScopes: new Set(["admin:vault"]),
      vaultId: "v1",
      db,
      acl,
      toolVisibility: PERSONA_MASK,
    };
    // Enqueued directly, as a payload built before the pre-flight existed would have been.
    await offloadToTask({ queue, clientPollsTasks: true }, { tool: "net_index", args: {}, ctx });
    const job = queue.listByState("queued")[0];
    if (!job) throw new Error("no job enqueued");
    const claimed = queue.claim({ leaseOwner: "w" });
    await expect(
      runTaskCall(job.id, claimed?.payload, { registry, db, acl, queue }, undefined, "w"),
    ).rejects.toThrow(/not_found/);
    expect(calls.n).toBe(0);
  });
});

describe("a payload queued before the policy snapshot existed fails closed", () => {
  // Codex's probe, verbatim in shape: what a job queued by an older server holds. It has no
  // `authenticated`, `persona` or `toolVisibility`, so a runner that defaulted the missing policy
  // fields would run `net_index` for a persona whose mask forbids it.
  const legacy = {
    tool: "net_index",
    args: {},
    caller: "alice",
    scopes: ["admin:vault"],
    vaultId: "v1",
    vaultBound: false,
  };

  function rig() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const queue = new JobQueue(db);
    const calls = { n: 0 };
    const registry = makeRegistry(calls);
    const deps = { registry, db, acl, queue };
    const run = (payload: unknown) => {
      const job = queue.enqueue(TASK_CALL_JOB_TYPE, {
        owner: { vaultId: "v1", caller: "alice" },
        maxAttempts: 1,
        payload,
      });
      queue.claimById(job.id, "w");
      return { job, done: runTaskCall(job.id, payload, deps, undefined, "w") };
    };
    return { calls, queue, run };
  }

  it("the old-format payload does not run the handler", async () => {
    const { calls, run } = rig();
    await expect(run(legacy).done).rejects.toThrow(/re-run/i);
    expect(calls.n).toBe(0);
  });

  it("the refusal is recorded on the job so tasks/get can explain it", async () => {
    const { queue, run } = rig();
    const { job, done } = run(legacy);
    await done.catch(() => undefined);
    const outcome = queue.get(job.id)?.outcome;
    expect(outcome?.ok).toBe(false);
    expect(JSON.stringify(outcome)).toMatch(/re-run/i);
  });

  it("a payload with the whole snapshot but no version is refused, and so is an older version", async () => {
    const { calls, run } = rig();
    const snapshot = { ...legacy, authenticated: true };
    await expect(run(snapshot).done).rejects.toThrow(/re-run/i);
    await expect(run({ ...snapshot, v: TASK_CALL_PAYLOAD_VERSION - 1 }).done).rejects.toThrow(
      /re-run/i,
    );
    expect(calls.n).toBe(0);
  });

  it("a current-version payload that omits `authenticated` is malformed, not authenticated", async () => {
    const { calls, run } = rig();
    await expect(run({ ...legacy, v: TASK_CALL_PAYLOAD_VERSION }).done).rejects.toThrow(
      /malformed/,
    );
    expect(calls.n).toBe(0);
  });

  it("restoreCaller does not default a missing `authenticated` to true", () => {
    const db = openMemoryDb();
    const back = restoreCaller({ ...legacy } as never, { db, acl });
    expect(back.authenticated).not.toBe(true);
  });

  it("the offload stamps the current version on every payload it writes", async () => {
    const { queue } = rig();
    const ctx = {
      caller: "alice",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db: openMemoryDb(),
      acl,
    };
    await offloadToTask({ queue, clientPollsTasks: true }, { tool: "net_index", args: {}, ctx });
    const queued = queue.listByState("queued")[0];
    expect((queued?.payload as TaskCallPayload | undefined)?.v).toBe(TASK_CALL_PAYLOAD_VERSION);
  });
});

describe("the offload pre-flight applies every authorization gate dispatch applies", () => {
  // Codex's repro: a task-augmentable READ tool aimed at `.obsidian/secret.md`. The pre-flight
  // stopped at the vault-kind gate, so it said "admit" while dispatch's central path ACL (which
  // runs later, after the rate limiter) said acl_denied: the call was queued as a job and its
  // denial surfaced later, unaudited, instead of synchronously.
  const root = makeTempDir("obtc-offload-preflight-");
  afterAll(() => rmTemp(root));

  function aclRig() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const calls = { n: 0 };
    const registry = new ToolRegistry({ rootResolver: () => root });
    const base = {
      description: "task-augmentable and path-ACL'd",
      inputSchema: z.object({ vault: z.string().optional(), path: z.string() }),
      taskAugmentable: true,
      handler: () => {
        calls.n++;
        return { read: true };
      },
    };
    registry.register({
      ...base,
      name: "read_task",
      requiredScopes: ["read:notes"],
      pathAcl: (i: { path: string }) => [{ op: "read", path: i.path }],
    } as unknown as ToolDefinition);
    registry.register({
      ...base,
      name: "write_task",
      requiredScopes: ["write:notes"],
      pathAcl: (i: { path: string }) => [{ op: "write", path: i.path }],
    } as unknown as ToolDefinition);
    const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
      caller: "alice",
      authenticated: true,
      grantedScopes: new Set(["read:notes", "write:notes"]),
      vaultId: "v1",
      db,
      acl,
      ...over,
    });
    return { registry, ctx, db, calls };
  }

  it("a read of .obsidian/secret.md is refused by the pre-flight AND by dispatch", async () => {
    const { registry, ctx, calls } = aclRig();
    const args = { path: ".obsidian/secret.md" };
    const dispatched = await registry.dispatch("read_task", args, ctx());
    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) expect(dispatched.error.code).toBe("acl_denied");
    expect(registry.passesPolicyGates("read_task", args, ctx())).toBe(false);
    expect(calls.n).toBe(0);
  });

  it("the pre-flight admits the same tool aimed at an ordinary note", () => {
    const { registry, ctx } = aclRig();
    expect(registry.passesPolicyGates("read_task", { path: "notes/a.md" }, ctx())).toBe(true);
  });

  it("the pre-flight has no side effect: it does not touch ctx.acl or run the handler", () => {
    const { registry, ctx, calls } = aclRig();
    const c = ctx();
    registry.passesPolicyGates("read_task", { path: "notes/a.md" }, c);
    expect(c.acl).toBe(acl);
    expect(calls.n).toBe(0);
  });

  it("a denied call takes the synchronous path: refused with acl_denied, no job, no handler", async () => {
    const { registry, ctx, db, calls } = aclRig();
    const queue = new JobQueue(db);
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry,
      context: () => ctx(),
      visibility: { grantedScopes: new Set(["read:notes"]) },
      facadeMode: "flat",
      jobQueue: queue,
      startTask: makeStartTask({ registry, db, acl, queue }, "test-runner"),
      taskBudgetMs: 200,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "0" }, {});
    await client.connect(ct);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    const res = await client.callTool({
      name: "read_task",
      arguments: { path: ".obsidian/secret.md" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/acl_denied/);
    expect(calls.n).toBe(0);
    expect(total(queue)).toBe(0);
  });

  it("a resolveTarget tool is never pre-flighted as admitted: its target is unknown until dispatch", () => {
    const { registry, ctx } = aclRig();
    registry.register({
      name: "live_target",
      description: "target chosen by live state",
      inputSchema: z.object({ vault: z.string().optional() }),
      requiredScopes: ["read:notes"],
      taskAugmentable: true,
      resolveTarget: () => ({ path: ".obsidian/secret.md" }),
      pathAcl: (i: { path: string }) => [{ op: "read", path: i.path }],
      handler: () => ({}),
    } as unknown as ToolDefinition);
    expect(registry.passesPolicyGates("live_target", {}, ctx())).toBe(false);
  });

  // The two orders cannot diverge again: every case below is decided by dispatch, and the
  // pre-flight must agree with it. A new gate that only one of them applies fails here.
  const cases: Array<{
    name: string;
    tool: string;
    args: Record<string, unknown>;
    over?: (c: CallerContext) => Partial<CallerContext>;
  }> = [
    { name: "admitted", tool: "read_task", args: { path: "notes/a.md" } },
    { name: "path ACL (default-denied root)", tool: "read_task", args: { path: ".obsidian/x.md" } },
    { name: "path ACL on a write", tool: "write_task", args: { path: ".git/config" } },
    {
      name: "missing scope",
      tool: "read_task",
      args: { path: "a.md" },
      over: () => ({ grantedScopes: new Set(["write:notes"]) }),
    },
    {
      name: "unauthenticated",
      tool: "read_task",
      args: { path: "a.md" },
      over: () => ({ authenticated: false }),
    },
    {
      name: "persona-disabled tool",
      tool: "read_task",
      args: { path: "a.md" },
      over: () => ({ toolVisibility: { ...PERSONA_MASK, disabled: ["read_task"] } }),
    },
    {
      name: "vault-bound to another vault",
      tool: "read_task",
      args: { path: "a.md", vault: "other" },
      over: () => ({ vaultBound: true }),
    },
    {
      name: "write under a read-only ACL",
      tool: "write_task",
      args: { path: "a.md" },
      over: () => ({ acl: new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] }) }),
    },
    { name: "unknown tool", tool: "nope", args: {} },
    { name: "invalid input", tool: "read_task", args: { path: 7 } },
  ];

  it.each(cases)("pre-flight agrees with dispatch: $name", async ({ tool, args, over }) => {
    const { registry, ctx } = aclRig();
    const base = ctx();
    const c = over ? { ...base, ...over(base) } : base;
    const dispatched = await registry.dispatch(tool, args, { ...c });
    expect(registry.passesPolicyGates(tool, args, { ...c })).toBe(dispatched.ok);
  });
});

/** The keys of `interface CallerContext`, read off the source so a new field cannot hide. */
function callerContextKeys(): string[] {
  const text = readFileSync(join(SRC, "mcp", "registry", "types.ts"), "utf8");
  const start = text.indexOf("export interface CallerContext {");
  const body = text.slice(start, text.indexOf("\n}\n", start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
}

const PKG = join(__dirname, "..");
const posix = (p: string): string => p.replaceAll("\\", "/");

/** The files whose reads of a CallerContext are dispatch's: the registry, visibility, HITL. */
function dispatchRoots(): string[] {
  return [
    ...readdirSync(join(SRC, "mcp", "registry"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(SRC, "mcp", "registry", f)),
    join(SRC, "mcp", "registry.ts"),
    join(SRC, "mcp", "visibility.ts"),
    join(SRC, "vault", "hitl.ts"),
  ].map(posix);
}

describe("the CallerContext read scan", () => {
  let handle: ReturnType<typeof openProject>;
  beforeAll(() => {
    handle = openProject(PKG);
  }, 60_000);
  afterAll(() => handle?.close());

  it("sees every shape of read, in the file and through a helper module (the checker, not a regex)", () => {
    const fixtures = join(__dirname, "fixtures");
    const found = scanCallerContextReads(
      handle.project,
      [posix(join(fixtures, "caller-context-read-fixture.ts"))],
      posix(fixtures),
    );
    const byKey = new Map(found.reads.map((r) => [r.key, r.form]));
    expect(Object.fromEntries(byKey)).toEqual({
      roots: "destructure", // Codex's case: const { roots } = ctx; if (!roots) deny();
      now: "destructure", // renamed
      sample: "element",
      traceCarrier: "property", // through Pick<CallerContext, ...>
      facadeExplanation: "assignment-destructure",
      hitlRoute: "property", // in another module, reached only through a call
    });
    expect(found.files.some((f) => f.endsWith("caller-context-read-helper.ts"))).toBe(true);
  }, 60_000);

  it("fails a key that is read but classified dropped (Codex's `const { roots } = ctx`)", () => {
    const fixtures = join(__dirname, "fixtures");
    const found = scanCallerContextReads(
      handle.project,
      [posix(join(fixtures, "caller-context-read-fixture.ts"))],
      posix(fixtures),
    );
    // Every key the fixture reads is accounted for except `roots`, which this table drops.
    const accounted = Object.fromEntries(found.reads.map((r) => [r.key, { how: "carried" }]));
    expect(droppedButRead(found.reads, accounted)).toEqual([]);
    expect(droppedButRead(found.reads, { ...accounted, roots: { how: "dropped" } })).toEqual([
      "roots",
    ]);
  }, 60_000);

  it("finds no unnamed read of dispatch's context (a dynamic key or a rest pattern hides which keys)", () => {
    const found = scanCallerContextReads(handle.project, dispatchRoots(), posix(SRC));
    expect(found.reads.filter((r) => (UNNAMED_READS as readonly string[]).includes(r.key))).toEqual(
      [],
    );
  }, 60_000);
});

describe("every CallerContext key is accounted for by the offload path", () => {
  let handle: ReturnType<typeof openProject>;
  beforeAll(() => {
    handle = openProject(PKG);
  }, 60_000);
  afterAll(() => handle?.close());

  const table = CALLER_CONTEXT_DISPOSITION as Record<
    string,
    { how: string; why?: string; by?: string }
  >;

  it("the table lists exactly the keys of CallerContext", () => {
    const keys = callerContextKeys();
    // A floor: a regex that stopped matching would make the equality below vacuous.
    expect(keys.length).toBeGreaterThan(25);
    expect(keys).toEqual(expect.arrayContaining(["toolVisibility", "grantedScopes", "vaultBound"]));
    expect(Object.keys(table).sort()).toEqual([...keys].sort());
  });

  it("every key dispatch reads is accounted for, and none of them is dropped", () => {
    const { files, reads } = scanCallerContextReads(handle.project, dispatchRoots(), posix(SRC));
    const read = new Set(reads.map((r) => r.key));
    // Floors: a scan that stopped matching would make everything below vacuous.
    expect(files.length).toBeGreaterThanOrEqual(dispatchRoots().length);
    expect(read.size).toBeGreaterThan(10);
    expect([...read]).toEqual(expect.arrayContaining(["toolVisibility", "grantedScopes"]));
    for (const key of read) {
      expect(
        table[key],
        `dispatch reads ctx.${key}, which the offload path does not account for`,
      ).toBeDefined();
    }
    // Whatever the explanation, a key dispatch reads is not "dropped": the worker's dispatch reads it too.
    expect(droppedButRead(reads, table)).toEqual([]);
    for (const [key, entry] of Object.entries(table)) {
      if (entry.how === "dropped") expect(entry.why?.length ?? 0, key).toBeGreaterThan(20);
    }
  }, 60_000);

  it("the policy-bearing keys are CARRIED, not merely explained", () => {
    for (const key of [
      "caller",
      "authenticated",
      "grantedScopes",
      "vaultId",
      "vaultBound",
      "toolVisibility",
    ]) {
      expect(table[key]?.how, key).toBe("carried");
    }
  });

  it("every carried key survives the JSON round trip of a job payload", () => {
    const sample: Record<string, unknown> = {
      caller: "alice",
      authenticated: true,
      grantedScopes: new Set(["read:notes", "admin:vault"]),
      vaultId: "v9",
      vaultBound: true,
      transport: "http",
      persona: "researcher",
      authVerified: true,
      claimedProvenance: { model: "m" },
      toolVisibility: { ...PERSONA_MASK, hidden: ["x"], allowed: ["a", "b"] },
      clientInfo: { name: "c", version: "1" },
      sessionId: "s1",
    };
    const carried = Object.entries(table)
      .filter(([, e]) => e.how === "carried")
      .map(([k]) => k);
    for (const k of carried) expect(sample, `no sample for carried key ${k}`).toHaveProperty(k);
    const db = openMemoryDb();
    const full = { ...sample, db, acl } as unknown as CallerContext;
    const wire = JSON.parse(JSON.stringify(snapshotCaller(full)));
    const back = restoreCaller(wire, { db, acl }) as unknown as Record<string, unknown>;
    for (const k of carried) expect(back[k], k).toEqual(sample[k]);
    // Nothing outside the carried/rebuilt sets appears on the rebuilt context.
    for (const k of Object.keys(back)) {
      expect(["carried", "rebuilt"], k).toContain(table[k]?.how);
    }
  });

  it("the snapshot is what the payload type says it is", () => {
    const payload = {
      v: TASK_CALL_PAYLOAD_VERSION,
      tool: "t",
      args: {},
      ...snapshotCaller({
        caller: "a",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v",
        db: openMemoryDb(),
      }),
    } satisfies TaskCallPayload;
    expect(payload.scopes).toEqual(["*"]);
  });
});

describe("a HITL-gated tool cannot opt into offload", () => {
  const base = {
    description: "x",
    inputSchema: z.object({}),
    handler: () => ({}),
    taskAugmentable: true,
  };

  it("refuses a destructive taskAugmentable tool at registration", () => {
    expect(() =>
      new ToolRegistry().register({
        ...base,
        name: "d",
        requiredScopes: ["write:notes"],
        destructive: true,
        confirmationTargets: "none",
      } as unknown as ToolDefinition),
    ).toThrow(/taskAugmentable.*HITL|HITL.*taskAugmentable/);
  });

  it("refuses a conditionally-gated taskAugmentable tool (elicit_token in its schema)", () => {
    expect(() =>
      new ToolRegistry().register({
        ...base,
        name: "c",
        inputSchema: z.object({ elicit_token: z.string().optional() }),
        requiredScopes: ["read:notes"],
        confirmationTargets: "none",
      } as unknown as ToolDefinition),
    ).toThrow(/taskAugmentable/);
  });

  it("a worker call that meets the HITL gate anyway is refused elicit_required and never runs", async () => {
    // The `guarded` keys (elicitToken, elicitState, relayElicitConsumed) are read only inside that
    // gate. The worker carries none of them, so the gate cannot be passed: it fails closed.
    const db = openMemoryDb();
    provisionCacheDb(db);
    const queue = new JobQueue(db);
    const calls = { n: 0 };
    const registry = new ToolRegistry();
    registry.register({
      name: "destroy",
      description: "x",
      inputSchema: z.object({}),
      requiredScopes: ["write:notes"],
      destructive: true,
      confirmationTargets: "none",
      handler: () => {
        calls.n++;
        return {};
      },
    } as unknown as ToolDefinition);
    const payload = {
      v: TASK_CALL_PAYLOAD_VERSION,
      tool: "destroy",
      args: {},
      caller: "alice",
      authenticated: true,
      scopes: ["write:notes"],
      vaultId: "v1",
      vaultBound: false,
    };
    const job = queue.enqueue(TASK_CALL_JOB_TYPE, {
      owner: { vaultId: "v1", caller: "alice" },
      maxAttempts: 1,
      payload,
    });
    queue.claimById(job.id, "w");
    await expect(
      runTaskCall(job.id, payload, { registry, db, acl, queue }, undefined, "w"),
    ).rejects.toThrow(/elicit_required/);
    expect(calls.n).toBe(0);
  });

  it("still admits an ungated one", () => {
    expect(() =>
      new ToolRegistry().register({
        ...base,
        name: "ok",
        requiredScopes: ["admin:vault"],
      } as unknown as ToolDefinition),
    ).not.toThrow();
  });
});
