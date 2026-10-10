// `initialize` must not wait on warmup. Open WebUI gives initialize 10 s and Codex gives startup
// 10 s; the boot reconcile (vault walk, parse, chunk, embed) used to be launched from start()
// BEFORE the transport connected, so its synchronous first segment (the whole-vault walk) ran ahead
// of the first request on the event loop. Measured on a 20 000-note vault: the walk alone is
// ~0.3 s on a warm NVMe and scales with disk latency, not with anything the client can bound.
//
// The warmup now goes through deferBootWork: it starts after the first client has finished
// initializing (or after a bounded wait for transports that never initialize, such as stateless
// HTTP), and always on a later macrotask than the caller.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { deferBootWork } from "../src/runtime/boot-helpers";

describe("deferBootWork", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never runs the work synchronously", () => {
    const work = vi.fn();
    deferBootWork(work, { initialized: Promise.resolve(), maxWaitMs: 2_000 });
    expect(work).not.toHaveBeenCalled();
  });

  it("runs after the first client has initialized, on a later macrotask", async () => {
    const work = vi.fn();
    let initialized!: () => void;
    deferBootWork(work, {
      initialized: new Promise<void>((r) => {
        initialized = r;
      }),
      maxWaitMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work).not.toHaveBeenCalled(); // nobody has initialized yet and the cap is far away
    initialized();
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled(); // same turn: still behind the initialize handling
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("runs after the bounded wait when no client ever initializes", async () => {
    const work = vi.fn();
    deferBootWork(work, { initialized: new Promise<void>(() => {}), maxWaitMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("runs exactly once when both triggers fire", async () => {
    const work = vi.fn();
    deferBootWork(work, { initialized: Promise.resolve(), maxWaitMs: 100 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled before it starts (shutdown during boot)", async () => {
    const work = vi.fn();
    const cancel = deferBootWork(work, { initialized: Promise.resolve(), maxWaitMs: 100 });
    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("ordering against a real MCP handshake", () => {
  it("the warmup begins only after the initialize exchange has completed", async () => {
    const order: string[] = [];
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: new ToolRegistry(),
      context: () => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db: {} as never,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
    });
    const initialized = new Promise<void>((resolve) => {
      server.oninitialized = () => {
        order.push("initialized");
        resolve();
      };
    });
    // Armed BEFORE the transport connects, exactly as start() does it.
    deferBootWork(() => order.push("warmup"), { initialized, maxWaitMs: 30_000 });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "0" });
    expect(order).toEqual([]);
    await client.connect(ct);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["initialized", "warmup"]);
    await client.close();
    await server.close();
  });
});

describe("the boot path uses it", () => {
  const src = readFileSync(join(__dirname, "..", "src", "runtime", "server-runtime.ts"), "utf8");

  it("start() hands the boot reconcile to deferBootWork instead of launching it inline", () => {
    expect(src).toMatch(/deferBootWork\(/);
    // The old shape: a bare fire-and-forget launched ahead of the transport connecting.
    expect(src).not.toMatch(/^\s*void runReconcile\(bootReconcileAbort\.signal\)/m);
  });
});
