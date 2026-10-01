// moveNoReplace without hard links (FAT/exFAT, some network mounts, Windows without privilege):
// link() fails EPERM/ENOSYS/ENOTSUP/EOPNOTSUPP. The fallback was check-then-renameSync, and a rename
// REPLACES — a destination created between the check and the rename was silently destroyed. It is
// now an exclusive-create copy of the bytes (O_CREAT|O_EXCL) followed by an unlink of the source.
import * as fs from "node:fs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, rmTemp } from "./tmp";
import { loadNotesIo } from "./write-io-backends";

const fault: { link: string | null; lstatMisses: string | null } = {
  link: null,
  lstatMisses: null,
};
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (fault.link) {
        const e = new Error(
          `${fault.link}: operation not permitted, link`,
        ) as NodeJS.ErrnoException;
        e.code = fault.link;
        throw e;
      }
      return actual.linkSync(from, to);
    },
    lstatSync: ((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      if (fault.lstatMisses && String(p).endsWith(fault.lstatMisses)) {
        const e = new Error("ENOENT: no such file or directory, lstat") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return actual.lstatSync(p, o as never);
    }) as typeof fs.lstatSync,
  };
});

const made: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(makeTempDir("otc-nl-"));
  made.push(d);
  return d;
}
afterEach(() => {
  fault.link = null;
  fault.lstatMisses = null;
  for (const d of made.splice(0)) rmTemp(d);
});

describe.each(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"])(
  "JS moveNoReplace with link() failing %s",
  (code) => {
    it("never replaces an occupied destination; both files are intact", async () => {
      const io = await loadNotesIo("js");
      if (!io) return;
      const root = tmp();
      writeFileSync(join(root, "from.md"), "payload");
      writeFileSync(join(root, "taken.md"), "TAKEN");
      fault.link = code;
      // RED before the fix: existsNoFollow + renameSync clobbered `taken.md` whenever the check
      // lost a race; with the destination present at call time it must refuse outright.
      expect(() => io.moveNoReplace(join(root, "from.md"), join(root, "taken.md"))).toThrow(
        /exists/,
      );
      expect(readFileSync(join(root, "taken.md"), "utf8")).toBe("TAKEN");
      expect(readFileSync(join(root, "from.md"), "utf8")).toBe("payload");
    });

    it("a destination that appears after the existence check is not replaced", async () => {
      const io = await loadNotesIo("js");
      if (!io) return;
      const root = tmp();
      writeFileSync(join(root, "from.md"), "payload");
      fault.link = code;
      // The racer: the destination exists, but the existence check (lstat) is made to miss it —
      // what another process creating it right after the check looks like. Only an exclusive
      // create survives that; check-then-rename replaced it.
      writeFileSync(join(root, "raced.md"), "RACER");
      fault.lstatMisses = "raced.md";
      expect(() => io.moveNoReplace(join(root, "from.md"), join(root, "raced.md"))).toThrow(
        /exists/,
      );
      expect(readFileSync(join(root, "raced.md"), "utf8")).toBe("RACER");
      expect(readFileSync(join(root, "from.md"), "utf8")).toBe("payload");
    });

    it("moves to a free destination: bytes land, source is gone, no litter", async () => {
      const io = await loadNotesIo("js");
      if (!io) return;
      const root = tmp();
      writeFileSync(join(root, "from.md"), "payload");
      fault.link = code;
      io.moveNoReplace(join(root, "from.md"), join(root, "free.md"));
      expect(readFileSync(join(root, "free.md"), "utf8")).toBe("payload");
      expect(readdirSync(root)).toEqual(["free.md"]);
    });
  },
);
