// GH #1433 rec 4, step 3: when the child-process embedder is recycled. A full reconcile recycles it
// only when the pass embedded chunks (an idle pass changes nothing, so it keeps the loaded model); a
// write drain recycles it only while the parent alone is under the memory budget and parent + child
// RSS is over it (a recycle cannot shrink a parent that is over budget by itself). Two over-budget
// burst ends within the debounce window recycle it once, and each recycle logs one line. An in-process
// host is never recycled, a host with a request queued is left alone until the next burst end, and a
// host with no child running is never recycled.
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

/** A host whose child reports `childRssBytes`. Absent means no child is running: no pid, no RSS. */
function fakeHost(opts: { kind?: EmbedderHost["kind"]; childRssBytes?: number; queued?: number }): {
  host: EmbedderHost;
  recycle: ReturnType<typeof vi.fn>;
} {
  const recycle = vi.fn(async () => {});
  const running = opts.childRssBytes !== undefined;
  const stats = (): EmbedderHostStats => ({
    state: running ? "ready" : "idle",
    restarts: 0,
    recycles: 0,
    pid: running ? 4242 : undefined,
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

/** A budget the parent alone is under, so a 100 MB child is what takes parent + child over it. */
const budgetOnlyChildTipsIt = (): number => Math.ceil(process.memoryUsage().rss / MIB) + 50;

afterEach(async () => {
  await closeOwnedHosts(owner);
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("a reconcile that embedded 0 chunks but is over budget with a live child recycles once", async () => {
    const { recycle } = fakeHost({ childRssBytes: 100 * MIB });
    await onBurstEnd("full-reconcile", { embeddedChunks: 0, budgetMb: budgetOnlyChildTipsIt() });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle).toHaveBeenCalledWith("reconcile");
  });

  it("a write drain under the budget recycles nothing", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("write-drain", { budgetMb: 1_000_000 });
    expect(recycle).not.toHaveBeenCalled();
  });

  it("a write drain whose parent + child RSS is over the budget recycles once, for the budget reason", async () => {
    const { recycle } = fakeHost({ childRssBytes: 100 * MIB });
    await onBurstEnd("write-drain", { budgetMb: budgetOnlyChildTipsIt() });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(recycle).toHaveBeenCalledWith("budget");
  });

  it("a write drain with no budget set recycles nothing", async () => {
    const { recycle } = fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("write-drain");
    expect(recycle).not.toHaveBeenCalled();
  });

  it("a parent that is over the budget by itself recycles nothing: a recycle cannot shrink it", async () => {
    const before = embedderRecycleTotals().budget;
    const { recycle } = fakeHost({ childRssBytes: 100 * MIB });
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).not.toHaveBeenCalled();
    expect(embedderRecycleTotals().budget).toBe(before);
  });

  it("a write drain with no child running recycles nothing and counts nothing", async () => {
    const before = embedderRecycleTotals();
    const { recycle } = fakeHost({});
    await onBurstEnd("write-drain", { budgetMb: 1 });
    expect(recycle).not.toHaveBeenCalled();
    expect(embedderRecycleTotals()).toEqual(before);
  });

  it("two over-budget burst ends within the debounce window recycle once", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { recycle } = fakeHost({ childRssBytes: 100 * MIB });
    const budgetMb = budgetOnlyChildTipsIt();
    await onBurstEnd("write-drain", { budgetMb });
    vi.setSystemTime(1_000_000 + RECYCLE_DEBOUNCE_MS - 1);
    await onBurstEnd("write-drain", { budgetMb });
    expect(recycle).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + RECYCLE_DEBOUNCE_MS + 1);
    await onBurstEnd("write-drain", { budgetMb });
    expect(recycle).toHaveBeenCalledTimes(2);
  });

  it("each recycle logs exactly one line with its reason, child RSS and parent + child total", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeHost({ childRssBytes: 100 * MIB });
    await onBurstEnd("write-drain", { budgetMb: budgetOnlyChildTipsIt() });
    const lines = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("embedder host recycled"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^embedder host recycled: reason=budget child_rss_mb=100 total_mb=\d+$/,
    );
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
    busy.host.stats = async () => ({
      state: "ready",
      restarts: 0,
      recycles: 0,
      pid: 4242,
      rssBytes: 1 * MIB,
      queued: 0,
    });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    expect(busy.recycle).toHaveBeenCalledTimes(1);
  });

  it("counts each recycle by reason for the recycle metric", async () => {
    const before = embedderRecycleTotals();
    fakeHost({ childRssBytes: 1 * MIB });
    await onBurstEnd("full-reconcile", { embeddedChunks: 1 });
    expect(embedderRecycleTotals().reconcile).toBe(before.reconcile + 1);
    expect(embedderRecycleTotals().budget).toBe(before.budget);
  });
});
