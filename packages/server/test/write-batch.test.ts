// applyWriteBatch (vault/write-batch.ts): stage every temp file, run the caller's intent hook, then
// re-hash each existing note immediately before replacing it. Against real files: an edit that lands
// after planning (or between staging and the rename) aborts the whole batch and is preserved, a
// rollback never overwrites a note someone changed since this batch wrote it nor deletes a page
// someone else recreated, and no failure leaves a temp file behind.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageNoteWrite, writeNoteAtomic } from "../src/vault/notes-io";
import { applyWriteBatch, type BatchWrite } from "../src/vault/write-batch";
import { makeTempDir, rmTemp } from "./tmp";

// A seam on the staged commit: `onCommit(n)` runs just before the Nth rename of the batch.
const seam = vi.hoisted(() => ({
  n: 0,
  onCommit: undefined as undefined | ((n: number) => void),
}));
vi.mock("../src/vault/notes-io", async (orig) => {
  const actual = await orig<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    stageNoteWrite: (...a: Parameters<typeof actual.stageNoteWrite>) => {
      const s = actual.stageNoteWrite(...a);
      return {
        commit: () => {
          seam.onCommit?.(++seam.n);
          s.commit();
        },
        discard: () => s.discard(),
      };
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = makeTempDir("otc-write-batch-");
  seam.n = 0;
  seam.onCommit = undefined;
});
afterEach(() => rmTemp(dir));

const abs = (rel: string): string => join(dir, rel);
const put = (rel: string, text: string): void => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(abs(rel), text, "utf8");
};
const read = (rel: string): string => readFileSync(abs(rel), "utf8");
const litter = (): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((n) => n.includes(".tmp-"));
const w = (rel: string, content: string, prevRaw: string | null): BatchWrite => ({
  abs: abs(rel),
  rel,
  content,
  prevRaw,
});
const thrown = (fn: () => void): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("applyWriteBatch", () => {
  it("replaces the existing notes, creates the new one, and leaves no temp file", () => {
    put("a.md", "old a");
    applyWriteBatch([w("new/p.md", "page", null), w("a.md", "new a", "old a")]);
    expect(read("new/p.md")).toBe("page");
    expect(read("a.md")).toBe("new a");
    expect(litter()).toEqual([]);
  });

  it("stages everything before replacing anything: a staging failure leaves the vault untouched", () => {
    put("a.md", "old a");
    put("blocker", "a file where a directory is needed");
    const e = thrown(() =>
      applyWriteBatch([w("a.md", "new a", "old a"), w("blocker/child.md", "x", null)]),
    );
    expect(e).toBeInstanceOf(Error);
    expect(read("a.md")).toBe("old a");
    expect(litter()).toEqual([]);
  });

  it("runs beforeCommit after staging and before the first rename; its failure aborts cleanly", () => {
    put("a.md", "old a");
    const order: string[] = [];
    seam.onCommit = () => order.push("rename");
    applyWriteBatch([w("a.md", "new a", "old a")], { beforeCommit: () => order.push("intent") });
    expect(order).toEqual(["intent", "rename"]);

    put("b.md", "old b");
    expect(() =>
      applyWriteBatch([w("b.md", "new b", "old b"), w("made/c.md", "c", null)], {
        beforeCommit: () => {
          throw new Error("no intent record");
        },
      }),
    ).toThrow("no intent record");
    expect(read("b.md")).toBe("old b");
    expect(existsSync(abs("made"))).toBe(false);
    expect(litter()).toEqual([]);
  });
});

describe("compare-and-swap at write time", () => {
  it("an edit made after planning aborts the whole batch and is kept", () => {
    put("a.md", "old a");
    put("b.md", "old b");
    writeFileSync(abs("b.md"), "edited by hand", "utf8");
    const e = thrown(() =>
      applyWriteBatch([w("a.md", "new a", "old a"), w("b.md", "new b", "old b")]),
    );
    expect(e.code).toBe("concurrent_modification");
    expect(e.details).toMatchObject({ path: "b.md" });
    expect(read("a.md")).toBe("old a");
    expect(read("b.md")).toBe("edited by hand");
    expect(litter()).toEqual([]);
  });

  it("an edit landing between staging and the rename (after the hook) is detected and kept", () => {
    put("a.md", "old a");
    put("b.md", "old b");
    const e = thrown(() =>
      applyWriteBatch([w("a.md", "new a", "old a"), w("b.md", "new b", "old b")], {
        beforeCommit: () => writeFileSync(abs("b.md"), "concurrent edit", "utf8"),
      }),
    );
    expect(e.code).toBe("concurrent_modification");
    expect(read("b.md")).toBe("concurrent edit");
    // the first note had already been replaced when the second was found changed: restored
    expect(read("a.md")).toBe("old a");
    expect(litter()).toEqual([]);
  });

  it("a note deleted after planning is a stale write, not a silent re-create", () => {
    put("a.md", "old a");
    const e = thrown(() =>
      applyWriteBatch([w("a.md", "new a", "old a")], {
        beforeCommit: () => unlinkSync(abs("a.md")),
      }),
    );
    expect(e.code).toBe("concurrent_modification");
    expect(existsSync(abs("a.md"))).toBe(false);
  });
});

describe("rollback", () => {
  it("restores the notes this batch wrote when a later rename fails", () => {
    put("a.md", "old a");
    put("b.md", "old b");
    seam.onCommit = (n) => {
      if (n === 3) throw new Error("disk full");
    };
    expect(() =>
      applyWriteBatch([
        w("new/p.md", "page", null),
        w("a.md", "new a", "old a"),
        w("b.md", "new b", "old b"),
      ]),
    ).toThrow("disk full");
    expect(read("a.md")).toBe("old a");
    expect(read("b.md")).toBe("old b");
    expect(existsSync(abs("new"))).toBe(false);
    expect(litter()).toEqual([]);
  });

  it("does not overwrite a note that changed after this batch wrote it, and reports it", () => {
    put("a.md", "old a");
    put("b.md", "old b");
    seam.onCommit = (n) => {
      if (n === 2) {
        writeFileSync(abs("a.md"), "someone else edited a", "utf8");
        throw new Error("disk full");
      }
    };
    const e = thrown(() =>
      applyWriteBatch([w("a.md", "new a", "old a"), w("b.md", "new b", "old b")]),
    );
    expect(read("a.md")).toBe("someone else edited a");
    expect(read("b.md")).toBe("old b");
    expect(e.code).toBe("internal_error");
    expect(e.details).toMatchObject({
      paths: ["a.md"],
      changed_since_written: ["a.md"],
      cause: "disk full",
    });
  });

  it("does not delete a created page that someone else rewrote since", () => {
    put("a.md", "old a");
    seam.onCommit = (n) => {
      if (n === 2) {
        writeFileSync(abs("p.md"), "their page", "utf8");
        throw new Error("disk full");
      }
    };
    const e = thrown(() => applyWriteBatch([w("p.md", "page", null), w("a.md", "new a", "old a")]));
    expect(read("p.md")).toBe("their page");
    expect(e.details).toMatchObject({ changed_since_written: ["p.md"] });
    expect(read("a.md")).toBe("old a");
  });

  it("a page someone else created first is never replaced or deleted", () => {
    put("a.md", "old a");
    const e = thrown(() =>
      applyWriteBatch([w("a.md", "new a", "old a"), w("p.md", "page", null)], {
        beforeCommit: () => writeFileSync(abs("p.md"), "created meanwhile", "utf8"),
      }),
    );
    expect(e.code).toBe("note_exists");
    expect(read("p.md")).toBe("created meanwhile");
    expect(read("a.md")).toBe("old a");
    expect(litter()).toEqual([]);
  });
});

describe("temp files on failure (the shared atomic writer)", () => {
  it("writeNoteAtomic leaves no temp file when the final rename fails", () => {
    mkdirSync(abs("target.md/inside"), { recursive: true });
    expect(() => writeNoteAtomic(abs("target.md"), "x", false)).toThrow();
    expect(litter()).toEqual([]);
  });

  it("an exclusive write leaves no temp file when the name is taken", () => {
    put("taken.md", "theirs");
    expect(() => writeNoteAtomic(abs("taken.md"), "x", false, { exclusive: true })).toThrow(
      /exists/,
    );
    expect(read("taken.md")).toBe("theirs");
    expect(litter()).toEqual([]);
  });

  it("a staged write that is discarded leaves nothing, and one commit settles it", () => {
    const s = stageNoteWrite(abs("s.md"), "x", true);
    s.discard();
    expect(existsSync(abs("s.md"))).toBe(false);
    expect(litter()).toEqual([]);
    const t = stageNoteWrite(abs("t.md"), "y", true);
    t.commit();
    expect(read("t.md")).toBe("y");
    expect(litter()).toEqual([]);
  });
});
