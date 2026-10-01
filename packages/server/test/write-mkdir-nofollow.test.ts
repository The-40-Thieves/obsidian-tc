// Parent directories are created component by component with lstat checks: a symlinked component is
// refused, never followed. `mkdirSync(dir, { recursive: true })` ran BEFORE the no-follow open and
// followed a planted symlink out of the vault (or into another folder), creating directories there
// even when the open that followed then refused. Shared by every note and attachment writer.
import * as fs from "node:fs";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";
import { makeTempDir, rmTemp } from "./tmp";
import { type Backend, loadNotesIo, trySymlink } from "./write-io-backends";

const made: string[] = [];
function tmp(prefix: string): string {
  const d = makeTempDir(prefix);
  made.push(d);
  return fs.realpathSync(d);
}
afterEach(() => {
  for (const d of made.splice(0)) rmTemp(d);
});

describe.each(["native", "js"] as Backend[])(
  "%s backend: writeFileAtomic parent creation",
  (backend) => {
    it("creates missing nested parents for a normal path", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-mk-");
      io.writeFileAtomic(join(root, "a", "b", "c", "n.md"), Buffer.from("hi"), true);
      expect(fs.readFileSync(join(root, "a", "b", "c", "n.md"), "utf8")).toBe("hi");
    });

    it("refuses a symlinked EXISTING ancestor and creates nothing through it", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-mk-");
      const outside = tmp("otc-mk-out-");
      if (!trySymlink(fs, outside, join(root, "sub"))) return;
      expect(() =>
        io.writeFileAtomic(join(root, "sub", "new", "deep", "n.md"), Buffer.from("x"), true),
      ).toThrow();
      // RED before the fix: mkdirSync(recursive) followed `sub` and created outside/new/deep.
      expect(readdirSync(outside)).toEqual([]);
    });

    it("refuses a symlink planted in the MIDDLE of the chain", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-mk-");
      const outside = tmp("otc-mk-out-");
      mkdirSync(join(root, "a"));
      if (!trySymlink(fs, outside, join(root, "a", "b"))) return;
      expect(() =>
        io.writeFileAtomic(join(root, "a", "b", "c", "n.md"), Buffer.from("x"), true),
      ).toThrow();
      expect(readdirSync(outside)).toEqual([]);
    });

    it("refuses a symlink that points at another folder INSIDE the vault too", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-mk-");
      mkdirSync(join(root, "real"));
      if (!trySymlink(fs, join(root, "real"), join(root, "alias"))) return;
      expect(() =>
        io.writeFileAtomic(join(root, "alias", "new", "n.md"), Buffer.from("x"), true),
      ).toThrow();
      expect(readdirSync(join(root, "real"))).toEqual([]);
    });

    it("refuses a non-directory component with a path error, not a raw EEXIST", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-mk-");
      writeFileSync(join(root, "file"), "x");
      expect(() =>
        io.writeFileAtomic(join(root, "file", "n.md"), Buffer.from("x"), true),
      ).toThrow();
    });

    it("ensureDirNoFollow refuses to create a NEW Windows-hostile component", async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const root = tmp("otc-mk-");
      expect(() => io.ensureDirNoFollow(join(root, "a:b", "c"))).toThrow(/colon/);
      expect(readdirSync(root)).toEqual([]);
    });
  },
);

describe("through the tools (default backend)", () => {
  it("write_attachment with create_dirs refuses a symlinked folder component", async () => {
    const v = makeM3Vault();
    const outside = tmp("otc-mk-out-");
    try {
      if (!trySymlink(fs, outside, join(v.root, "pics"))) return;
      const r = await v.call("write_attachment", {
        vault: "test",
        path: "pics/new/a.png",
        content: Buffer.from([0x89, 0x50]).toString("base64"),
      });
      expect(r.ok).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      v.cleanup();
    }
  });
});
