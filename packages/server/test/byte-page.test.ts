// The shared byte-budget paginator (src/mcp/byte-page.ts), exercised directly: exact accounting,
// progress guarantees and cursor binding, independent of any one tool.
import { describe, expect, it } from "vitest";
import { createPageCursorCodec, type PagingDeps, paginateByBytes } from "../src/mcp/byte-page";

type Entry = { kind: "ok"; id: number; pad: string } | { kind: "err"; id: number; size: number };

const codec = createPageCursorCodec("unit-test-secret");
const paging = (budget: number): PagingDeps => ({ codec, budgetBytes: () => budget });
const frame = (es: Entry[], next: string | null) => ({
  ok: es.filter((e) => e.kind === "ok"),
  err: es.filter((e) => e.kind === "err"),
  next_cursor: next,
});
const sizeOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

function run(opts: {
  budget: number;
  pads: number[];
  cursor?: string;
  principal?: string | null;
  args?: unknown;
  produced?: number[];
}) {
  const items = opts.pads.map((_, i) => i);
  return paginateByBytes<number, Entry>({
    paging: paging(opts.budget),
    binding: {
      tool: "t",
      principal: opts.principal === undefined ? "p" : opts.principal,
      args: opts.args ?? { pads: opts.pads },
    },
    cursor: opts.cursor,
    items,
    produce: (i) => {
      opts.produced?.push(i);
      return { kind: "ok", id: i, pad: "x".repeat(opts.pads[i] as number) };
    },
    tooLarge: (i, info) => ({ kind: "err", id: i, size: info.size }),
    frame,
    lane: (e) => e.kind,
  });
}

async function walk(budget: number, pads: number[], enforceBudget = true) {
  const pages: Array<{ entries: Entry[]; nextCursor: string | null }> = [];
  let cursor: string | undefined;
  for (let g = 0; g < 1000; g++) {
    const p = await run({ budget, pads, cursor });
    expect(p.entries.length).toBeGreaterThan(0);
    if (enforceBudget) expect(sizeOf(frame(p.entries, p.nextCursor))).toBeLessThanOrEqual(budget);
    pages.push(p);
    if (p.nextCursor === null) return pages;
    cursor = p.nextCursor;
  }
  throw new Error("did not terminate");
}

describe("paginateByBytes", () => {
  it("an empty list is an empty final page", async () => {
    const p = await run({ budget: 1000, pads: [] });
    expect(p).toEqual({ entries: [], nextCursor: null });
  });

  it("accounting matches JSON.stringify exactly: full size fits, one byte less splits", async () => {
    const pads = [10, 200, 3, 77, 41];
    const all = await run({ budget: 1_000_000, pads });
    expect(all.nextCursor).toBeNull();
    const full = sizeOf(frame(all.entries, null));
    const exact = await walk(full, pads);
    expect(exact).toHaveLength(1);
    const under = await walk(full - 1, pads);
    expect(under.length).toBeGreaterThan(1);
    expect(under.flatMap((p) => p.entries.map((e) => e.id))).toEqual([0, 1, 2, 3, 4]);
  });

  it("walks many shapes of budget with no gap, duplicate or oversize page", async () => {
    const pads = Array.from({ length: 30 }, (_, i) => (i * 53) % 400);
    for (const budget of [300, 500, 777, 1200, 4000, 100_000]) {
      const pages = await walk(budget, pads);
      const seen = pages.flatMap((p) => p.entries.map((e) => (e.kind === "ok" ? e.id : -e.id - 1)));
      // Every id shows up once, in order, either as a real entry or as its too_large stand-in.
      const ids = seen.map((s) => (s >= 0 ? s : -s - 1));
      expect(ids).toEqual(pads.map((_, i) => i));
    }
  });

  it("a budget too small for any entry still advances one item per page and terminates", async () => {
    const pages = await walk(10, [5, 5, 5], false); // below the envelope itself: the one-entry floor wins
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.entries.length === 1)).toBe(true);
  });

  it("runs producers lazily: items past the page are not produced", async () => {
    const produced: number[] = [];
    const p = await run({ budget: 400, pads: [100, 100, 100, 100, 100, 100], produced });
    expect(p.nextCursor).not.toBeNull();
    // never the whole list: stops at the first entry that does not fit (plus a small trim-back)
    expect(produced.length).toBeLessThan(6);
    expect(produced.length).toBeGreaterThanOrEqual(p.entries.length);
  });

  it("re-runs the producer for a resumed page (gates are per item, per page)", async () => {
    const pads = [100, 100, 100, 100, 100, 100];
    const first = await run({ budget: 400, pads });
    const produced: number[] = [];
    await run({ budget: 400, pads, cursor: first.nextCursor as string, produced });
    expect(produced[0]).toBe(first.entries.length);
  });

  it("binds the cursor to principal, tool args and this codec", async () => {
    const pads = [100, 100, 100, 100, 100, 100];
    const first = await run({ budget: 400, pads });
    const c = first.nextCursor as string;
    await expect(run({ budget: 400, pads, cursor: c, principal: "q" })).rejects.toMatchObject({
      code: "invalid_input",
      details: { reason: "foreign" },
    });
    await expect(run({ budget: 400, pads, cursor: c, principal: null })).rejects.toMatchObject({
      details: { reason: "foreign" },
    });
    await expect(run({ budget: 400, pads, cursor: c, args: { pads: [1] } })).rejects.toMatchObject({
      details: { reason: "request_mismatch" },
    });
    const other = {
      codec: createPageCursorCodec("a-different-secret-of-length"),
      budgetBytes: () => 400,
    };
    await expect(
      paginateByBytes({
        paging: other,
        binding: { tool: "t", principal: "p", args: { pads } },
        cursor: c,
        items: [0, 1, 2, 3, 4, 5],
        produce: (i) => ({ kind: "ok", id: i, pad: "" }) as Entry,
        tooLarge: (i) => ({ kind: "err", id: i, size: 0 }) as Entry,
        frame,
      }),
    ).rejects.toMatchObject({ details: { reason: "invalid" } });
  });

  it("the `cursor` key is excluded from the args hash", async () => {
    const pads = [100, 100, 100, 100, 100, 100];
    const first = await run({ budget: 400, pads, args: { pads } });
    const second = await run({
      budget: 400,
      pads,
      args: { pads, cursor: first.nextCursor },
      cursor: first.nextCursor as string,
    });
    expect(second.entries.length).toBeGreaterThan(0);
  });
});
