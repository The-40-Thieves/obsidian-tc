// THE-455: the per-(vault,path) index-on-write coordinator serializes same-path work (newest wins,
// no stale/out-of-order commit, no delete resurrection) while keeping different paths concurrent.
import { describe, expect, it } from "vitest";
import { IndexCoordinator } from "../src/search/index-coordinator";

/** A deferred promise the test releases by hand, to hold a handler mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("IndexCoordinator (THE-455)", () => {
  it("coalesces a burst of same-path writes to the latest content", async () => {
    const applied: string[] = [];
    const c = new IndexCoordinator({
      write: (_v, _p, content) => {
        applied.push(content);
      },
      delete: () => {},
    });
    c.submitWrite("v", "n.md", "a");
    c.submitWrite("v", "n.md", "b");
    c.submitWrite("v", "n.md", "c");
    await c.idle();
    // Only the final desired state is embedded — the intermediate writes are coalesced away.
    expect(applied).toEqual(["c"]);
  });

  it("a slow older write cannot commit after a newer one (the ordering bug)", async () => {
    const applied: string[] = [];
    const gate = deferred();
    let first = true;
    const c = new IndexCoordinator({
      write: async (_v, _p, content) => {
        if (first) {
          first = false;
          await gate.promise; // hold the first write in-flight
        }
        applied.push(content);
      },
      delete: () => {},
    });
    c.submitWrite("v", "n.md", "old");
    await Promise.resolve(); // let "old"'s drain start and block on the gate
    c.submitWrite("v", "n.md", "new");
    gate.resolve(); // release the slow first write
    await c.idle();
    // Serialized: "old" commits, then "new" commits last and wins. Never [new, old].
    expect(applied).toEqual(["old", "new"]);
    expect(applied.at(-1)).toBe("new");
  });

  it("a delete is not resurrected by an in-flight older write", async () => {
    const events: string[] = [];
    const gate = deferred();
    let firstWrite = true;
    const c = new IndexCoordinator({
      write: async (_v, _p) => {
        if (firstWrite) {
          firstWrite = false;
          await gate.promise;
        }
        events.push("write");
      },
      delete: () => {
        events.push("delete");
      },
    });
    c.submitWrite("v", "n.md", "body");
    await Promise.resolve(); // write drain in-flight, blocked
    c.submitDelete("v", "n.md");
    gate.resolve();
    await c.idle();
    // delete is serialized AFTER the write and is the newest op, so it wins.
    expect(events).toEqual(["write", "delete"]);
    expect(events.at(-1)).toBe("delete");
  });

  it("write-after-delete applies the write (delete does not win by recency alone)", async () => {
    const events: string[] = [];
    const c = new IndexCoordinator({
      write: () => {
        events.push("write");
      },
      delete: () => {
        events.push("delete");
      },
    });
    c.submitDelete("v", "n.md");
    await Promise.resolve();
    c.submitWrite("v", "n.md", "body");
    await c.idle();
    expect(events.at(-1)).toBe("write");
  });

  it("runs different paths concurrently (not serialized across keys)", async () => {
    const gateA = deferred();
    let bDone = false;
    const c = new IndexCoordinator({
      write: async (_v, path) => {
        if (path === "a.md") await gateA.promise; // a.md blocks
        if (path === "b.md") bDone = true; // b.md must still complete
      },
      delete: () => {},
    });
    c.submitWrite("v", "a.md", "x");
    c.submitWrite("v", "b.md", "y");
    // Let the schedulers admit both drains (a handful of microtask hops through the concurrency slots).
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // b.md finished while a.md is still blocked -> different paths are not serialized.
    expect(bDone).toBe(true);
    gateA.resolve();
    await c.idle();
  });

  it("keeps different vaults on the same path independent", async () => {
    const applied: string[] = [];
    const c = new IndexCoordinator({
      write: (v, _p, content) => {
        applied.push(`${v}:${content}`);
      },
      delete: () => {},
    });
    c.submitWrite("v1", "n.md", "a");
    c.submitWrite("v2", "n.md", "b");
    await c.idle();
    expect(applied.sort()).toEqual(["v1:a", "v2:b"]);
  });

  it("reports handler errors via onError and never rejects the caller", async () => {
    const errors: string[] = [];
    const c = new IndexCoordinator({
      write: () => {
        throw new Error("boom");
      },
      delete: () => {},
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });
    c.submitWrite("v", "n.md", "x"); // must not throw synchronously
    await c.idle(); // must not reject
    expect(errors).toEqual(["boom"]);
  });

  it("bounds global concurrency across distinct paths (audit #5)", async () => {
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const c = new IndexCoordinator(
      {
        write: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await gate.promise;
          running -= 1;
        },
        delete: () => {},
      },
      { globalConcurrency: 2, perVaultConcurrency: 10 },
    );
    for (let i = 0; i < 6; i++) c.submitWrite("v", `n${i}.md`, "x");
    // Let the scheduler admit as many drains as the global cap allows.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(running).toBe(2); // only 2 handlers run at once despite 6 distinct paths
    expect(c.stats().active).toBe(2);
    expect(c.stats().queued).toBe(6);
    gate.resolve();
    await c.idle();
    expect(peak).toBe(2); // never exceeded the global cap
    expect(c.stats().queued).toBe(0);
  });

  it("bounds per-vault concurrency independently of the global cap (audit #5)", async () => {
    const gate = deferred();
    const running: Record<"a" | "b", number> = { a: 0, b: 0 };
    const peak: Record<"a" | "b", number> = { a: 0, b: 0 };
    const c = new IndexCoordinator(
      {
        write: async (v) => {
          const key = v as "a" | "b";
          running[key] += 1;
          peak[key] = Math.max(peak[key], running[key]);
          await gate.promise;
          running[key] -= 1;
        },
        delete: () => {},
      },
      { globalConcurrency: 10, perVaultConcurrency: 1 },
    );
    for (let i = 0; i < 3; i++) c.submitWrite("a", `n${i}.md`, "x");
    for (let i = 0; i < 3; i++) c.submitWrite("b", `n${i}.md`, "x");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Each vault is capped at 1 concurrent drain even though the global cap (10) is far higher.
    expect(running.a).toBe(1);
    expect(running.b).toBe(1);
    gate.resolve();
    await c.idle();
    expect(peak.a).toBe(1);
    expect(peak.b).toBe(1);
  });

  it("fires onBackpressure on the rising edge past queueMax (audit #5)", async () => {
    const gate = deferred();
    const depths: number[] = [];
    const c = new IndexCoordinator(
      {
        write: () => gate.promise, // hold every drain in-flight so the queue fills
        delete: () => {},
      },
      { globalConcurrency: 1, perVaultConcurrency: 1, queueMax: 2, onBackpressure: (d) => depths.push(d) },
    );
    c.submitWrite("v", "a.md", "x");
    c.submitWrite("v", "b.md", "x"); // depth 2, not over
    expect(depths).toEqual([]);
    c.submitWrite("v", "c.md", "x"); // depth 3 -> over queueMax=2, edge fires once
    c.submitWrite("v", "d.md", "x"); // still over, but edge already fired
    expect(depths).toEqual([3]);
    expect(c.stats().backpressured).toBe(true);
    gate.resolve();
    await c.idle();
    expect(c.stats().backpressured).toBe(false);
  });

  it("idle() resolves only after all queued work drains; busy reflects in-flight state", async () => {
    const gate = deferred();
    const c = new IndexCoordinator({
      write: () => gate.promise,
      delete: () => {},
    });
    c.submitWrite("v", "n.md", "x");
    expect(c.busy).toBe(true);
    let idled = false;
    const idlePromise = c.idle().then(() => {
      idled = true;
    });
    await Promise.resolve();
    expect(idled).toBe(false); // still blocked
    gate.resolve();
    await idlePromise;
    expect(idled).toBe(true);
    expect(c.busy).toBe(false);
  });
});
