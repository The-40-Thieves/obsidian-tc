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
    await Promise.resolve();
    await Promise.resolve();
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
