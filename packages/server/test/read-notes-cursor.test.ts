// read_notes continuation cursor: an over-budget batch returns the notes that fit plus an opaque
// next_cursor instead of failing the whole call with `overflow`. Every case runs through
// registry.dispatch, i.e. under the real governor.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { makeTestVault, type TestVault } from "./m1-helpers";

interface Page {
  vault: string;
  notes: Array<{ path: string; content: string }>;
  errors: Array<{ path: string; code: string; size?: number; budget?: number }>;
  next_cursor: string | null;
}

const vaults: TestVault[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(
  files: Record<string, string>,
  maxResponseBytes?: number,
  acl?: object,
  centralAcl = false,
): TestVault {
  const v = makeTestVault({
    files,
    centralAcl,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    ...(acl ? { acl } : {}),
  });
  vaults.push(v);
  return v;
}

async function readPage(
  v: TestVault,
  paths: string[],
  cursor?: string,
  over?: Parameters<TestVault["call"]>[2],
) {
  const r = await v.call(
    "read_notes",
    { vault: "test", paths, ...(cursor ? { cursor } : {}) },
    over,
  );
  return r;
}

/** Follow next_cursor to the end. Fails the test if any page makes no progress. */
async function walk(v: TestVault, paths: string[]) {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const r = await readPage(v, paths, cursor);
    if (!r.ok) throw new Error(`page ${guard} failed: ${JSON.stringify(r.error)}`);
    const d = r.data as Page;
    pages.push(d);
    if (d.next_cursor === null) return pages;
    expect(d.notes.length + d.errors.length).toBeGreaterThan(0); // progress
    cursor = d.next_cursor;
  }
  throw new Error("cursor walk did not terminate");
}

const body = (n: number) => "x".repeat(n);

describe("read_notes continuation cursor", () => {
  it("returns everything with next_cursor null when the batch fits", async () => {
    const v = vault({ "a.md": "A", "b.md": "B" });
    const r = await readPage(v, ["a.md", "b.md"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as Page;
      expect(d.notes.map((n) => n.path)).toEqual(["a.md", "b.md"]);
      expect(d.next_cursor).toBeNull();
    }
  });

  it("splits an over-budget batch into pages: request order, no duplicates, no gaps", async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 12; i++) {
      files[`n${i}.md`] = `${i}:${body(300)}`;
      paths.push(`n${i}.md`);
    }
    const v = vault(files, 2000);
    const pages = await walk(v, paths);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.notes.map((n) => n.path))).toEqual(paths);
    for (const p of pages) expect(p.errors).toEqual([]);
  });

  it("every page's serialized result stays within the budget", async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      files[`n${i}.md`] = body(50 + i * 37);
      paths.push(`n${i}.md`);
    }
    const v = vault(files, 2500);
    let cursor: string | undefined;
    do {
      const r = await readPage(v, paths, cursor);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.meta?.result_size).toBeLessThanOrEqual(2500);
      cursor = (r.data as Page).next_cursor ?? undefined;
    } while (cursor);
  });

  it("exactly at the budget is one page; one byte under the size is two", async () => {
    const files = { "a.md": body(400), "b.md": body(400), "c.md": "c" };
    const paths = ["a.md", "b.md", "c.md"];
    const probe = vault(files);
    const full = await readPage(probe, paths);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const size = full.meta?.result_size as number;

    const exact = vault(files, size);
    const atBudget = await walk(exact, paths);
    expect(atBudget).toHaveLength(1);
    expect(atBudget[0]?.notes).toHaveLength(3);

    const over = vault(files, size - 1);
    const pages = await walk(over, paths);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.notes.map((n) => n.path))).toEqual(paths);
  });

  describe("a single note larger than the budget", () => {
    const big = body(5000);
    const budget = 2000;
    const cases: Array<[string, string[]]> = [
      ["first", ["big.md", "a.md", "b.md"]],
      ["middle", ["a.md", "big.md", "b.md"]],
      ["last", ["a.md", "b.md", "big.md"]],
    ];
    for (const [where, paths] of cases) {
      it(`is a too_large entry (size + budget) and the walk continues - ${where}`, async () => {
        const v = vault({ "big.md": big, "a.md": "A", "b.md": "B" }, budget);
        const pages = await walk(v, paths);
        const notes = pages.flatMap((p) => p.notes.map((n) => n.path));
        expect(notes).toEqual(paths.filter((p) => p !== "big.md"));
        const errors = pages.flatMap((p) => p.errors);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ path: "big.md", code: "too_large", budget });
        expect(errors[0]?.size).toBeGreaterThan(budget);
      });
    }

    it("all items oversized: every one is reported and the walk terminates", async () => {
      const v = vault({ "x.md": big, "y.md": big, "z.md": big }, budget);
      const pages = await walk(v, ["x.md", "y.md", "z.md"]);
      expect(pages.flatMap((p) => p.notes)).toEqual([]);
      expect(pages.flatMap((p) => p.errors.map((e) => `${e.path}:${e.code}`))).toEqual([
        "x.md:too_large",
        "y.md:too_large",
        "z.md:too_large",
      ]);
    });
  });

  it("missing notes stay per-path errors and keep their place across pages", async () => {
    const v = vault({ "a.md": body(400), "b.md": body(400) }, 1500);
    const pages = await walk(v, ["a.md", "gone.md", "b.md"]);
    expect(pages.flatMap((p) => p.notes.map((n) => n.path))).toEqual(["a.md", "b.md"]);
    expect(pages.flatMap((p) => p.errors.map((e) => `${e.path}:${e.code}`))).toEqual([
      "gone.md:note_not_found",
    ]);
  });

  describe("cursor binding", () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 8; i++) {
      files[`n${i}.md`] = body(400);
      paths.push(`n${i}.md`);
    }

    async function firstCursor(v: TestVault): Promise<string> {
      const r = await readPage(v, paths);
      if (!r.ok) throw new Error("first page failed");
      const c = (r.data as Page).next_cursor;
      if (!c) throw new Error("expected a cursor");
      return c;
    }
    const reason = (r: Awaited<ReturnType<typeof readPage>>) =>
      r.ok ? null : (r.error.details as { reason?: string } | undefined)?.reason;

    it("resumes for the same principal, tool and args", async () => {
      const v = vault(files, 1500);
      const c = await firstCursor(v);
      const r = await readPage(v, paths, c);
      expect(r.ok).toBe(true);
    });

    it("rejects a cursor presented by a different principal", async () => {
      const v = vault(files, 1500);
      const c = await firstCursor(v);
      const r = await readPage(v, paths, c, { caller: "someone-else" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(reason(r)).toBe("foreign");
    });

    it("rejects a cursor with modified args (a different item set)", async () => {
      const v = vault(files, 1500);
      const c = await firstCursor(v);
      const r = await readPage(v, paths.slice().reverse(), c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(reason(r)).toBe("request_mismatch");
      const r2 = await readPage(v, paths.slice(0, 7), c);
      expect(reason(r2)).toBe("request_mismatch");
    });

    it("rejects a tampered cursor", async () => {
      const v = vault(files, 1500);
      const c = await firstCursor(v);
      const flipped = `${c.slice(0, -3)}${c.endsWith("AAA") ? "BBB" : "AAA"}`;
      for (const bad of [flipped, `${c}x`, "not-a-cursor", c.replace(/^v1\./, "v1.e")]) {
        const r = await readPage(v, paths, bad);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("invalid_input");
        expect(reason(r)).toBe("invalid");
      }
    });

    it("rejects a cursor minted by another server (foreign key)", async () => {
      const a = vault(files, 1500);
      const c = await firstCursor(a);
      // Same secret in the helper, so build a differently keyed codec by hand.
      const { createPageCursorCodec } = await import("../src/mcp/byte-page");
      const other = createPageCursorCodec("another-secret-entirely-different");
      await expect(other.verify(c)).rejects.toThrow();
    });

    it("rejects an expired cursor", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const v = vault(files, 1500);
      const c = await firstCursor(v);
      vi.setSystemTime(new Date("2026-01-01T00:11:00Z")); // ttl is 10 minutes
      const r = await readPage(v, paths, c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(reason(r)).toBe("expired");
    });
  });

  it("re-evaluates the folder ACL per item on resume: a path revoked between pages is refused", async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      files[`pub/n${i}.md`] = body(400);
      paths.push(`pub/n${i}.md`);
    }
    const v = vault(files, 1500);
    const first = await readPage(v, paths);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const d1 = first.data as Page;
    expect(d1.next_cursor).not.toBeNull();
    // Revoke the whole folder mid-walk.
    const revoked = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["other/**"],
    } as never);
    const second = await readPage(v, paths, d1.next_cursor as string, { acl: revoked });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const d2 = second.data as Page;
    expect(d2.notes).toEqual([]);
    expect(d2.errors.length).toBeGreaterThan(0);
    expect(new Set(d2.errors.map((e) => e.code))).toEqual(new Set(["acl_denied"]));
    // and it still terminates: the denied entries are consumed, not retried forever
    expect(d2.errors.length + d1.notes.length).toBeGreaterThan(d1.notes.length);
  });

  it("with the central ACL stage wired, a path revoked between pages fails the resumed call as acl_denied", async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      files[`pub/n${i}.md`] = body(400);
      paths.push(`pub/n${i}.md`);
    }
    const v = vault(files, 1500, undefined, true);
    const first = await readPage(v, paths);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const revoked = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["other/**"],
    } as never);
    const second = await readPage(v, paths, (first.data as Page).next_cursor as string, {
      acl: revoked,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("acl_denied");
  });
});
