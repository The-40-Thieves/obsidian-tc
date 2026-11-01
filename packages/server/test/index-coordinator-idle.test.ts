// GH #1433 step 3: the coordinator's onIdle fires once per drain, when the last queued or in-flight
// path settles, never while work is still pending. The recycle policy hangs off it.
import { describe, expect, it } from "vitest";
import { IndexCoordinator } from "../src/search/index-coordinator";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("IndexCoordinator onIdle", () => {
  it("fires exactly once after a burst of writes across several paths, once the queue is empty", async () => {
    let idleCalls = 0;
    let pendingAtIdle = -1;
    const coordinator: IndexCoordinator = new IndexCoordinator(
      {
        write: async () => {
          await tick();
        },
        delete: async () => {},
      },
      {
        onIdle: () => {
          idleCalls += 1;
          pendingAtIdle = coordinator.stats().queued;
        },
      },
    );
    coordinator.submitWrite("v", "a.md", "1");
    coordinator.submitWrite("v", "a.md", "2");
    coordinator.submitWrite("v", "b.md", "1");
    coordinator.submitWrite("v", "c.md", "1");
    expect(idleCalls).toBe(0);
    await coordinator.idle();
    await tick();
    expect(idleCalls).toBe(1);
    expect(pendingAtIdle).toBe(0);
  });

  it("fires again for a second, separate burst", async () => {
    let idleCalls = 0;
    const coordinator = new IndexCoordinator(
      { write: async () => {}, delete: async () => {} },
      { onIdle: () => (idleCalls += 1) },
    );
    coordinator.submitWrite("v", "a.md", "1");
    await coordinator.idle();
    await tick();
    coordinator.submitDelete("v", "a.md");
    await coordinator.idle();
    await tick();
    expect(idleCalls).toBe(2);
  });

  it("a throwing onIdle does not break the write path", async () => {
    let applied = 0;
    const coordinator = new IndexCoordinator(
      {
        write: async () => {
          applied += 1;
        },
        delete: async () => {},
      },
      {
        onIdle: () => {
          throw new Error("observer failed");
        },
      },
    );
    coordinator.submitWrite("v", "a.md", "1");
    await coordinator.idle();
    expect(applied).toBe(1);
  });
});
