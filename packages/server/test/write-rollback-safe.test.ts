// Rollback is as safe as the write. trashNote and the restore after a failed overwrite used plain
// renameSync, which follows a planted `.trash` symlink in BOTH directions: a note could be moved out
// of the vault into the symlink's target, and a restore could pull an outside file into the vault.
// They now go through the no-follow, no-replace move. Also: write_attachment marked the effect
// committed BEFORE the write (see write-rollback-marker.test.ts for that half).
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, rmTemp } from "./tmp";
import { type Backend, loadNotesIo, trySymlink } from "./write-io-backends";

const made: string[] = [];
function tmp(prefix: string): string {
  const d = fs.realpathSync(makeTempDir(prefix));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmTemp(d);
});

describe.each(["native", "js"] as Backend[])(
  "%s backend: trash + restore are no-follow",
  (backend) => {
    it("trashNote refuses a planted .trash symlink and moves nothing out of the vault", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-tr-");
      const outside = tmp("otc-tr-out-");
      writeFileSync(join(root, "note.md"), "precious");
      if (!trySymlink(fs, outside, join(root, ".trash"))) return;
      expect(() => io.trashNote(root, "note.md")).toThrow();
      // RED before the fix: renameSync followed .trash and the note landed in `outside`.
      expect(readFileSync(join(root, "note.md"), "utf8")).toBe("precious");
      expect(readdirSync(outside)).toEqual([]);
    });

    it("trashNote refuses a symlinked SUBFOLDER inside .trash", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-tr-");
      const outside = tmp("otc-tr-out-");
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "n.md"), "x");
      mkdirSync(join(root, ".trash"));
      if (!trySymlink(fs, outside, join(root, ".trash", "docs"))) return;
      expect(() => io.trashNote(root, "docs/n.md")).toThrow();
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(root, "docs", "n.md"))).toBe(true);
    });

    it("trashNote still disambiguates a name collision with a (n) suffix", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-tr-");
      writeFileSync(join(root, "n.md"), "first");
      expect(io.trashNote(root, "n.md")).toBe(".trash/n.md");
      writeFileSync(join(root, "n.md"), "second");
      expect(io.trashNote(root, "n.md")).toBe(".trash/n (1).md");
      expect(readFileSync(join(root, ".trash", "n.md"), "utf8")).toBe("first");
      expect(readFileSync(join(root, ".trash", "n (1).md"), "utf8")).toBe("second");
    });

    it("restoreTrashed will not pull a file through a symlinked .trash into the vault", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-tr-");
      const outside = tmp("otc-tr-out-");
      writeFileSync(join(outside, "a.png"), "OUTSIDE FILE");
      if (!trySymlink(fs, outside, join(root, ".trash"))) return;
      expect(() => io.restoreTrashed(root, ".trash/a.png", join(root, "a.png"))).toThrow();
      expect(existsSync(join(root, "a.png"))).toBe(false);
      expect(readFileSync(join(outside, "a.png"), "utf8")).toBe("OUTSIDE FILE");
    });

    it("restoreTrashed never replaces a path that was re-created meanwhile", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-tr-");
      writeFileSync(join(root, "a.png"), "v1");
      const trashed = io.trashNote(root, "a.png");
      writeFileSync(join(root, "a.png"), "v2-new");
      expect(() => io.restoreTrashed(root, trashed, join(root, "a.png"))).toThrow(/exists/);
      expect(readFileSync(join(root, "a.png"), "utf8")).toBe("v2-new");
      expect(readFileSync(join(root, trashed), "utf8")).toBe("v1");
    });
  },
);
