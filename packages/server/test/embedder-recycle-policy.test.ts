// GH #1433 rec 4, step 3: when the child-process embedder is recycled. A full reconcile recycles it
// only when the pass embedded chunks (an idle pass changes nothing, so it keeps the loaded model); a
// write drain recycles it only while parent + child RSS is over the memory budget; two over-budget
// burst ends within the debounce window recycle it once. An in-process host is never recycled, and a
// host with a request queued is left alone until the next burst end.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  embedderRecycleTotals,
  onBurstEnd,
  RECYCLE_DEBOUNCE_MS,
} from "../src/embeddings/host/recycle-policy";
import { closeOwnedHosts, registerHost } from "../src/embeddings/host/registry";
import type { EmbedderHost, EmbedderHostStats } from "../src/embeddings/host/types";

const MIB = 1024 * 1024;
const owner = {};

function fakeHost(opts: { kind?: EmbedderHost["kind"]; childRssBytes?: number; queued?: number }): {
  host: EmbedderHost;
  recycle: ReturnType<typeof vi.fn>;
} {
  const recycle = vi.fn(async () => {});
  const stats = (): EmbedderHostStats => ({
    state: "ready",
    restarts: 0,
    recycles: 0,
    rssBytes: opts.childRssBytes,
    queued: opts.queued ?? 0,
  });
  const host: EmbedderHost = {
    kind: opts.kind ?? "child-process",
    embed: async () => [],
    recycle,
    stats: async () => stats(),
    snapshot: stats,
    close: async () => {},
  };
  registerHost(owner, host);
  return { host, recycle };
}

afterEach(async () => {
  await closeOwnedHosts(owner);
  vi.useRealTimers();
});

describe("onBurstEnd recycle policy (GH #1433 step 3)", () => {
  it("a full reconcile that embedded chunks recycles the child once, for the reconcile reason", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle).toHaveBeenCalledWith("reconcile");
  });

  it("a full reconcile that embedded 0 chunks recycles nothing, even with no budget", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("full-reconcile", { embeddedChunks: 0 });
    expect(recycle).not.toHaveBeenCalled();
  });

  it("a write drain under the budget recycles nothing", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("write-drain", { budgetMb: 1_000_000 });
    expect(recycle).not.toHaveBeenCalled();
  });

  it("a write drain over the budget recycles the child once, for the budget reason", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle).toHaveBeenCalledWith("budget");
  });

  it("a write drain with no budget set recycles nothing", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("write-drain");
    expect(recycle).not.toHaveBeenCalled();
  });

  it("the budget is parent + child RSS: a child that alone fits still trips it", async () => {
    const { recycle } = fakeHost({ childRssBytes: 0 });
    // The parent (the test runner) is well above 1 MB, so the sum is over a 1 MB budget.
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it("two over-budget burst ends within the debounce window recycle once", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("write-drain", { budgetMb: 1 });
    vi.setSystemTime(1_000_000 + RECYCLE_DEBOUNCE_MS - 1);
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + RECYCLE_DEBOUNCE_MS + 1);
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).toHaveBeenCalledTimes(2);
  });

  it("an in-process host is never recycled, by any burst end", async () => {
    const { recycle } = fakeHost({ kind: "in-process", childRssBytes: 1 * MIB });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).not.toHaveBeenCalled();
  });

  it("a host with a request queued is not recycled; the next burst end with an empty queue is", async () => {
    const busy = fakeHost({ childRssBytes: 1 * MIB, queued: 2 });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    expect(busy.recycle).not.toHaveBeenCalled();
    busy.host.stats = async () => ({ state: "ready", restarts: 0, recycles: 0, queued: 0 });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    expect(busy.recycle).toHaveBeenCalledTimes(1);
  });

  it("counts each recycle by reason for the restart metric", async () => {
    const before = embedderRecycleTotals();
    fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    expect(embedderRecycleTotals().reconcile).toBe(before.reconcile + 1);
    expect(embedderRecycleTotals().budget).toBe(before.budget);
  });
});
