// The note write gate (vault/write-gate.ts) at the notes-io chokepoints. A frame installed by
// withWriteGate vetoes every `.md` write made inside it before any byte reaches disk; with no frame,
// for a non-note file, or on the internal undo path, nothing is gated. Against real files.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ERROR_CODES,
  err,
  type ObsidianTcError,
  recoveryFor,
} from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageNoteWrite, writeFileAtomic, writeNoteAtomic } from "../src/vault/notes-io";
import { applyWriteBatch, type BatchWrite } from "../src/vault/write-batch";
import {
  gateNoteWrite,
  isNotePath,
  type NoteWriteGate,
  noteWriteOrigin,
  preflightNoteWrite,
  withWriteGate,
} from "../src/vault/write-gate";
import { makeTempDir, rmTemp } from "./tmp";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("otc-write-gate-");
});
afterEach(() => rmTemp(dir));

const abs = (rel: string): string => join(dir, rel);
const put = (rel: string, text: string): void => writeFileSync(abs(rel), text, "utf8");
const read = (rel: string): string => readFileSync(abs(rel), "utf8");
const w = (rel: string, content: string, prevRaw: string | null): BatchWrite => ({
  abs: abs(rel),
  rel,
  content,
  prevRaw,
});
const thrown = (fn: () => unknown): ObsidianTcError => {
  try {
    fn();
  } catch (e) {
    return e as ObsidianTcError;
  }
  throw new Error("expected a throw");
};
const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

/** A gate that records every check and throws for the paths `block` selects. */
function recorder(block: (p: string) => boolean = () => true): {
  gate: NoteWriteGate;
  seen: string[];
} {
  const seen: string[] = [];
  const gate: NoteWriteGate = {
    check(p) {
      seen.push(p);
      if (block(p)) throw err.conventionBlocked("write blocked", { path: p, violations: [] });
    },
  };
  return { gate, seen };
}

describe("write gate: no frame", () => {
  it("with no frame, writes behave as before", () => {
    writeFileAtomic(abs("plain.md"), Buffer.from("plain", "utf8"));
    expect(read("plain.md")).toBe("plain");
    expect(() => gateNoteWrite(abs("plain.md"), "plain")).not.toThrow();
  });
});

describe("write gate: blocking", () => {
  it("a blocking gate stops a .md write before any file or temp file", () => {
    const { gate, seen } = recorder();
    const e = thrown(() =>
      withWriteGate(gate, () => writeFileAtomic(abs("note.md"), Buffer.from("x", "utf8"))),
    );
    expect(e.code).toBe("convention_blocked");
    expect(seen).toEqual([abs("note.md")]);
    expect(existsSync(abs("note.md"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("gates an upper-case .MD write too", () => {
    const { gate, seen } = recorder();
    thrown(() => withWriteGate(gate, () => writeFileAtomic(abs("UP.MD"), Buffer.from("x"))));
    expect(seen).toEqual([abs("UP.MD")]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a .json or .canvas write is not gated", () => {
    const { gate, seen } = recorder();
    withWriteGate(gate, () => {
      writeFileAtomic(abs("data.json"), Buffer.from("{}"));
      writeFileAtomic(abs("board.canvas"), Buffer.from("{}"));
    });
    expect(seen).toEqual([]);
    expect(read("data.json")).toBe("{}");
    expect(read("board.canvas")).toBe("{}");
  });

  it("a blocked second note aborts the batch: neither note is written", () => {
    const { gate } = recorder((p) => p.endsWith("blocked.md"));
    const e = thrown(() =>
      withWriteGate(gate, () =>
        applyWriteBatch([w("first.md", "A", null), w("blocked.md", "B", null)]),
      ),
    );
    expect(e.code).toBe("convention_blocked");
    expect(existsSync(abs("first.md"))).toBe(false);
    expect(existsSync(abs("blocked.md"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a write checked at staging is not checked again at commit", () => {
    let blockNow = false;
    const { gate, seen } = recorder(() => blockNow);
    withWriteGate(gate, () =>
      applyWriteBatch([w("one.md", "1", null), w("two.md", "2", null)], {
        beforeCommit: () => {
          blockNow = true;
        },
      }),
    );
    expect(read("one.md")).toBe("1");
    expect(read("two.md")).toBe("2");
    // One check per note across stage and commit: the commit must not check again.
    expect(seen).toEqual([abs("one.md"), abs("two.md")]);
  });

  it("an undo of a rolled-back batch is ungated", () => {
    put("a.md", "old a");
    put("b.md", "old b");
    const { gate } = recorder(() => false);
    let blockNow = false;
    const gated: NoteWriteGate = {
      check: (p, t) => {
        if (blockNow) throw err.conventionBlocked("write blocked", { path: p, violations: [] });
        gate.check(p, t);
      },
    };
    expect(() =>
      withWriteGate(gated, () =>
        applyWriteBatch([w("a.md", "new a", "old a"), w("b.md", "new b", "old b")], {
          beforeCommit: () => {
            blockNow = true;
            // A concurrent edit to b.md after staging: the commit's re-hash aborts the batch.
            writeFileSync(abs("b.md"), "someone else", "utf8");
          },
        }),
      ),
    ).toThrow();
    expect(read("a.md")).toBe("old a");
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("writeNoteAtomic with ungated skips the gate", () => {
    const { gate, seen } = recorder();
    withWriteGate(gate, () => writeNoteAtomic(abs("u.md"), "x", true, { ungated: true }));
    expect(seen).toEqual([]);
    expect(read("u.md")).toBe("x");
  });

  it("stageNoteWrite blocks before staging: no temp file and no rename", () => {
    const { gate } = recorder();
    thrown(() => withWriteGate(gate, () => stageNoteWrite(abs("s.md"), "x", true)));
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a blocked writeFileAtomic into a missing folder creates no folder", () => {
    const { gate } = recorder();
    thrown(() =>
      withWriteGate(gate, () => writeFileAtomic(abs("missing/n.md"), Buffer.from("x"), true)),
    );
    expect(existsSync(abs("missing"))).toBe(false);
  });

  it("a blocked stageNoteWrite into a missing folder creates no folder", () => {
    const { gate } = recorder();
    thrown(() => withWriteGate(gate, () => stageNoteWrite(abs("missing/s.md"), "x", true)));
    expect(existsSync(abs("missing"))).toBe(false);
  });
});

describe("write gate: note names", () => {
  it.each([
    "note.md",
    "NOTE.MD",
    "note.md ",
    "note.md.",
    "note.md. ",
    "note.md::$DATA",
    "note.md:stream",
    "a:b.md",
  ])("%j is a note", (name) => {
    expect(isNotePath(name)).toBe(true);
  });

  it.each(["note.txt", "data.json", "board.canvas", "note.md.txt", "note.mdx", "dir.md/file"])(
    "%j is not a note",
    (name) => {
      expect(isNotePath(name)).toBe(false);
    },
  );

  it.each(["note.md ", "note.md.", "note.md::$DATA"])("gates the NTFS alias %j", (name) => {
    const { gate, seen } = recorder();
    thrown(() => withWriteGate(gate, () => gateNoteWrite(abs(name), "x")));
    expect(seen).toEqual([abs(name)]);
  });
});

describe("write gate: memo", () => {
  it("preflight then gate checks once for the same content; gate then gate checks twice", () => {
    const { gate, seen } = recorder(() => false);
    withWriteGate(gate, () => {
      preflightNoteWrite(abs("m.md"), "same");
      gateNoteWrite(abs("m.md"), "same");
      expect(seen).toHaveLength(1);
      gateNoteWrite(abs("m.md"), "same");
      expect(seen).toHaveLength(2);
      gateNoteWrite(abs("m.md"), "other");
      expect(seen).toHaveLength(3);
    });
  });

  it("a verdict is consumed once: a later write of the same content is checked again", () => {
    put("P.md", "BAD old");
    const seen: string[] = [];
    // Blocks a write of "BAD v" once the note on disk reads "clean": the verdict depends on disk.
    const gate: NoteWriteGate = {
      check(p, text) {
        seen.push(text);
        if (text === "BAD v" && read("P.md") === "clean")
          throw err.conventionBlocked("write blocked", { path: p, violations: [] });
      },
    };
    const e = withWriteGate(gate, () => {
      writeFileAtomic(abs("P.md"), Buffer.from("BAD v", "utf8"));
      writeFileAtomic(abs("P.md"), Buffer.from("clean", "utf8"));
      return thrown(() => writeFileAtomic(abs("P.md"), Buffer.from("BAD v", "utf8")));
    });
    expect(e.code).toBe("convention_blocked");
    expect(seen).toEqual(["BAD v", "clean", "BAD v"]);
    expect(read("P.md")).toBe("clean");
  });
});

describe("write gate: frame lifetime", () => {
  it("writes after withWriteGate returns or throws are ungated", () => {
    const { gate, seen } = recorder();
    withWriteGate(gate, () => 1);
    thrown(() =>
      withWriteGate(gate, () => {
        throw new Error("boom");
      }),
    );
    writeFileAtomic(abs("after.md"), Buffer.from("y"));
    expect(seen).toEqual([]);
    expect(read("after.md")).toBe("y");
  });

  it("a setTimeout write scheduled inside a frame is ungated", async () => {
    const { gate, seen } = recorder();
    withWriteGate(gate, () => {
      setTimeout(() => writeFileAtomic(abs("late.md"), Buffer.from("t")), 0);
    });
    await new Promise((done) => setTimeout(done, 20));
    expect(seen).toEqual([]);
    expect(read("late.md")).toBe("t");
  });

  it("a promise chain that continues after withWriteGate resolves is ungated", async () => {
    const { gate, seen } = recorder();
    let chain: Promise<void> = Promise.resolve();
    await withWriteGate(gate, async () => {
      chain = tick().then(() => writeFileAtomic(abs("chain.md"), Buffer.from("c")));
    });
    await chain;
    expect(seen).toEqual([]);
    expect(read("chain.md")).toBe("c");
  });

  it("concurrent frames each see only their own gate", async () => {
    const a = recorder(() => false);
    const b = recorder(() => false);
    await Promise.all([
      withWriteGate(a.gate, async () => {
        await tick();
        writeNoteAtomic(abs("a1.md"), "a", true);
        await tick();
        writeNoteAtomic(abs("a2.md"), "a", true);
      }),
      withWriteGate(b.gate, async () => {
        await tick();
        writeNoteAtomic(abs("b1.md"), "b", true);
        await tick();
        writeNoteAtomic(abs("b2.md"), "b", true);
      }),
    ]);
    expect(a.seen).toEqual([abs("a1.md"), abs("a2.md")]);
    expect(b.seen).toEqual([abs("b1.md"), abs("b2.md")]);
  });

  it("noteWriteOrigin forwards only inside a frame", () => {
    const origins: string[] = [];
    const gate: NoteWriteGate = {
      check: () => {},
      origin: (dest, src) => origins.push(`${src}->${dest}`),
    };
    noteWriteOrigin("new.md", "old.md");
    expect(origins).toEqual([]);
    withWriteGate(gate, () => noteWriteOrigin("new.md", "old.md"));
    expect(origins).toEqual(["old.md->new.md"]);
  });
});

describe("convention_blocked error", () => {
  it("convention_blocked is non-retryable, hinted, and serialises its details", () => {
    expect(ERROR_CODES).toContain("convention_blocked");
    const details = { path: "n.md", violations: [{ property: "status" }], violations_omitted: 2 };
    const e = err.conventionBlocked("blocked", details);
    expect(e.code).toBe("convention_blocked");
    expect(e.retryable).toBe(false);
    const json = e.toJSON();
    expect(json.recovery).toBe(recoveryFor("convention_blocked"));
    expect(recoveryFor("convention_blocked")).toMatch(/details\.violations/);
    expect(json.details).toEqual(details);
  });
});
