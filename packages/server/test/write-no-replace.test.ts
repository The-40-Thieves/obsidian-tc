// overwrite:false is enforced by the COMMIT, not just by a check before it. A check-then-rename
// leaves a window in which another process can create the same path and have its file silently
// replaced. The exclusive mode commits with a no-replace primitive (native: renameat2 NOREPLACE /
// renamex EXCL; JS fallback: link + unlink), so the loser gets note_exists and nothing is lost.
// Runs on BOTH backends; the tool-level table is in write-no-replace-tools.test.ts.
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTemp } from "./tmp";
import { type Backend, loadNotesIo } from "./write-io-backends";

const made: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(mkdtempSync(join(tmpdir(), "otc-nr-")));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmTemp(d);
});

describe.each(["native", "js"] as Backend[])("%s backend: exclusive commit", (backend) => {
  it("creates a missing target", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const root = tmp();
    io.writeFileAtomic(join(root, "n.md"), Buffer.from("one"), true, { exclusive: true });
    expect(readFileSync(join(root, "n.md"), "utf8")).toBe("one");
    expect(readdirSync(root)).toEqual(["n.md"]);
  });

  it("never replaces an existing target: note_exists, content intact, no temp left behind", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const root = tmp();
    writeFileSync(join(root, "n.md"), "ORIGINAL");
    let code = "";
    try {
      io.writeFileAtomic(join(root, "n.md"), Buffer.from("CLOBBER"), true, { exclusive: true });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    // RED before the fix: there was no exclusive mode, the rename replaced ORIGINAL.
    expect(code).toBe("note_exists");
    expect(readFileSync(join(root, "n.md"), "utf8")).toBe("ORIGINAL");
    expect(readdirSync(root)).toEqual(["n.md"]);
  });

  it("the default mode still replaces (overwrite:true is unchanged)", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const root = tmp();
    writeFileSync(join(root, "n.md"), "ORIGINAL");
    io.writeFileAtomic(join(root, "n.md"), Buffer.from("NEW"), true);
    expect(readFileSync(join(root, "n.md"), "utf8")).toBe("NEW");
  });

  it("exactly one of several racing exclusive writers wins", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const root = tmp();
    const results = Array.from({ length: 8 }, (_, i) => {
      try {
        io.writeFileAtomic(join(root, "n.md"), Buffer.from(`writer-${i}`), true, {
          exclusive: true,
        });
        return "won";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "note_exists")).toHaveLength(7);
    expect(readdirSync(root)).toEqual(["n.md"]);
  });

  it("moveNoReplace refuses an occupied target and leaves the source", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const root = tmp();
    writeFileSync(join(root, "from.md"), "payload");
    writeFileSync(join(root, "taken.md"), "taken");
    expect(() => io.moveNoReplace(join(root, "from.md"), join(root, "taken.md"))).toThrow(/exists/);
    expect(readFileSync(join(root, "from.md"), "utf8")).toBe("payload");
    expect(readFileSync(join(root, "taken.md"), "utf8")).toBe("taken");
    io.moveNoReplace(join(root, "from.md"), join(root, "free.md"));
    expect(readFileSync(join(root, "free.md"), "utf8")).toBe("payload");
    expect(fs.existsSync(join(root, "from.md"))).toBe(false);
  });
});
