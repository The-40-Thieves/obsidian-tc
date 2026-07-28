// THE-583: task-augmented tool calls — the piece that PRODUCES caller-owned tasks.
//
// Two properties are worth testing and the second is the one that could be catastrophic.
//
// 1. AUGMENTATION IS NEVER INFERRED. It happens only when the client asks (`params.task`) AND the
//    tool opted in (`taskAugmentable`). Deferring a fast tool costs the caller a poll round trip to
//    learn what one call would have told them.
//
// 2. A TASK CANNOT EXCEED ITS CALLER. The runner has no request, so it is trivially easy to write
//    one that runs as the server — and nothing would look wrong: the tool would succeed, the task
//    would read `completed`, and a caller would have performed an operation they had no scope for.
//    The scope snapshot is the only thing standing between "deferred execution" and "privilege
//    escalation primitive", so it gets tested directly.
import { isTaskAugmentedRequestParams } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { invalidTaskParams, requestsTask, type TaskCallPayload } from "../src/mcp/tasks";
import { runTaskCall } from "../src/scheduler/task-call-runner";
import { openMemoryDb } from "./helpers";

/** The deprecated 2025-11-25 validator, for the overlap check below. */
const SDK_VALIDATOR = isTaskAugmentedRequestParams as (v: unknown) => boolean;

describe("requestsTask — presence, not shape", () => {
  it("is true only when `task` is actually present", () => {
    expect(requestsTask({ task: {} })).toBe(true);
    expect(requestsTask({ task: { ttl: 60_000 } })).toBe(true);
    expect(requestsTask({})).toBe(false);
    expect(requestsTask({ name: "x", arguments: {} })).toBe(false);
    expect(requestsTask(undefined)).toBe(false);
    expect(requestsTask(null)).toBe(false);
  });

  it("does NOT use the SDK's isTaskAugmentedRequestParams, which is true for {}", () => {
    // Pinned because the confusion is one import away: that helper validates the SHAPE of an
    // optional field, so an ABSENT `task` is perfectly valid to it. Using it for this decision
    // would turn every ordinary tool call into a background job.
    expect(SDK_VALIDATOR({})).toBe(true);
    expect(SDK_VALIDATOR({ name: "search", arguments: {} })).toBe(true);
    expect(requestsTask({})).toBe(false);
  });
});

describe("invalidTaskParams — the shape check the presence test cannot do", () => {
  it("accepts a well-formed ask", () => {
    expect(invalidTaskParams({ task: {} })).toBeNull();
    expect(invalidTaskParams({ task: { ttl: 60_000 } })).toBeNull();
    expect(invalidTaskParams({ task: { ttl: 60_000, pollInterval: 2_000 } })).toBeNull();
  });

  it("tolerates an unknown key, because the spec's own schema is a LOOSE object", () => {
    // A field added in a later revision must not become a hard rejection.
    expect(invalidTaskParams({ task: { somethingAddedLater: true } })).toBeNull();
  });

  it("rejects a `task` that is not an object", () => {
    // The hole a presence-only check leaves: each of these passes `requestsTask`.
    for (const bad of ["garbage", null, 42, true, [] as unknown]) {
      expect(requestsTask({ task: bad })).toBe(true);
      expect(invalidTaskParams({ task: bad })).toBe("task must be an object");
    }
  });

  it("rejects a non-numeric or non-finite ttl / pollInterval", () => {
    expect(invalidTaskParams({ task: { ttl: "abc" } })).toMatch(/ttl/);
    expect(invalidTaskParams({ task: { pollInterval: null } })).toMatch(/pollInterval/);
    // Stricter than the SDK's `z.number()`, which accepts these: a task told to live for infinite
    // milliseconds is not a request we can honour, and saying so beats guessing.
    expect(invalidTaskParams({ task: { ttl: Number.POSITIVE_INFINITY } })).toMatch(/ttl/);
    expect(invalidTaskParams({ task: { ttl: Number.NaN } })).toMatch(/ttl/);
  });

  it("agrees with the SDK validator everywhere the two revisions overlap", () => {
    // Not a claim that the deprecated 2025 helper is authoritative — it is the reason we do not use
    // it. But where the vocabularies DO overlap, disagreeing would mean one of us has it wrong.
    for (const params of [
      { task: {} },
      { task: { ttl: 60_000 } },
      { task: { ttl: "abc" } },
      { task: "garbage" },
      { task: null },
    ]) {
      expect(invalidTaskParams(params) === null).toBe(SDK_VALIDATOR(params));
    }
  });
});

function harness() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  const seen: CallerContext[] = [];
  registry.register({
    name: "needs_write",
    description: "test-only tool requiring a write scope",
    inputSchema: z.object({ vault: z.string() }),
    requiredScopes: ["write:notes"],
    handler: (_args: unknown, ctx: CallerContext) => {
      seen.push(ctx);
      return { ran: true };
    },
  } as any);
  const deps = {
    registry,
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  };
  return { deps, seen };
}

const payload = (over: Partial<TaskCallPayload> = {}): TaskCallPayload => ({
  tool: "needs_write",
  args: { vault: "main" },
  caller: "agent-1",
  scopes: ["write:notes"],
  vaultId: "main",
  vaultBound: true,
  ...over,
});

describe("runTaskCall — a task carries exactly its caller's authority", () => {
  it("runs the tool when the snapshotted scopes allow it", async () => {
    const { deps, seen } = harness();
    await expect(runTaskCall(payload(), deps)).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("REFUSES when the snapshot lacks the scope — no server authority is substituted", async () => {
    // The escalation case. A runner that built its context from server config instead would sail
    // through this, the task would read `completed`, and nobody would be told.
    const { deps, seen } = harness();
    await expect(runTaskCall(payload({ scopes: ["read:notes"] }), deps)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("refuses with NO scopes at all", async () => {
    const { deps, seen } = harness();
    await expect(runTaskCall(payload({ scopes: [] }), deps)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("hands the tool exactly the snapshotted scope set, not a superset", async () => {
    const { deps, seen } = harness();
    await runTaskCall(payload({ scopes: ["write:notes"] }), deps);
    expect([...(seen[0]?.grantedScopes ?? [])]).toEqual(["write:notes"]);
  });

  it("carries vault binding forward, so a bound token stays bound", async () => {
    // THE-267: a vault-bound caller must not reach another vault. Dropping this in the runner
    // would silently unbind every deferred call.
    const { deps, seen } = harness();
    await runTaskCall(payload({ vaultBound: true }), deps);
    expect(seen[0]?.vaultBound).toBe(true);
    expect(seen[0]?.vaultId).toBe("main");
  });

  it("preserves the caller identity for audit", async () => {
    const { deps, seen } = harness();
    await runTaskCall(payload({ caller: "agent-7" }), deps);
    expect(seen[0]?.caller).toBe("agent-7");
  });

  it("rejects a malformed payload rather than defaulting any field", async () => {
    // Defaulting here is how a job with no scopes would become a job with the server's.
    const { deps } = harness();
    for (const bad of [null, {}, { tool: "x" }, { tool: "x", vaultId: "main", scopes: "nope" }]) {
      await expect(runTaskCall(bad, deps)).rejects.toThrow(/malformed/);
    }
  });

  it("surfaces the tool's own error text, since the caller no longer holds the response", async () => {
    const { deps } = harness();
    await expect(runTaskCall(payload({ tool: "no_such_tool" }), deps)).rejects.toThrow(
      /no_such_tool|not_found|unknown/i,
    );
  });
});

describe("the augmentable set is deliberate", () => {
  it("marks index_vault, the long-running one", async () => {
    // A flag that never reaches the registry is the "registered is not emitting" shape: the
    // augmentation branch would simply never fire and every task request would run synchronously.
    const { registerM2Tools } = await import("../src/tools/m2");
    const reg = new ToolRegistry();
    registerM2Tools(reg, {} as never);
    const idx = reg.list().find((d) => d.name === "index_vault");
    expect(idx?.taskAugmentable).toBe(true);
  });

  it("leaves fast tools alone — a handle is worse than an answer", async () => {
    // The floor: if everything were augmentable, the opt-in would be decorative.
    const { registerM2Tools } = await import("../src/tools/m2");
    const reg = new ToolRegistry();
    registerM2Tools(reg, {} as never);
    const augmentable = reg
      .list()
      .filter((d) => d.taskAugmentable)
      .map((d) => d.name);
    expect(augmentable).toEqual(["index_vault"]);
  });
});
