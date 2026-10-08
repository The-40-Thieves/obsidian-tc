// A configured vault folder that is a symlink (`wiki -> pages`) must open under its configured name
// with the native safe-open loaded, WITHOUT loosening that open's no-symlink rule for anything else:
// a symlink planted anywhere that is not a configured folder, under a configured folder's real
// directory, or leading out of the vault is still refused. The refusals are native-only (the JS
// fallback follows an in-vault symlink by documented design), so they gate on `nativeVaultIo`.
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinFolders, pinnedFolderPath, replaceFolderPins } from "../src/vault/folder-links";
import { nativeVaultIo, readNote } from "../src/vault/notes-io";
import { makeTempDir, rmTemp } from "./tmp";

/** Pin `folders` of `root` the way a registry build does (replacing every earlier pin). */
const pin = (root: string, folders: string[]): void => replaceFolderPins(pinFolders(root, folders));

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmTemp(t);
});

function vault(): { root: string; outside: string } {
  const base = realpathSync(makeTempDir("obtc-folder-links-"));
  temps.push(base);
  const root = join(base, "vault");
  const outside = join(base, "outside");
  mkdirSync(join(root, "pages"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "pages", "a.md"), "page A\n");
  writeFileSync(join(root, "notes", "secret.md"), "secret\n");
  writeFileSync(join(outside, "x.md"), "outside\n");
  return { root, outside };
}

describe.skipIf(process.platform === "win32")(
  "pinnedFolderPath: configured folder symlinks",
  () => {
    it("swaps a configured symlinked folder for its real directory, and nothing else", () => {
      const { root } = vault();
      symlinkSync(join(root, "pages"), join(root, "wiki"));
      symlinkSync(join(root, "pages"), join(root, "other"));
      pin(root, ["wiki"]);
      expect(pinnedFolderPath(join(root, "wiki", "a.md"))).toBe(join(root, "pages", "a.md"));
      expect(pinnedFolderPath(join(root, "wiki", "new", "b.md"))).toBe(
        join(root, "pages", "new", "b.md"),
      );
      // not configured: left alone, so the native open refuses the symlink
      expect(pinnedFolderPath(join(root, "other", "a.md"))).toBe(join(root, "other", "a.md"));
      // already the real name, and a sibling that merely shares the prefix
      expect(pinnedFolderPath(join(root, "pages", "a.md"))).toBe(join(root, "pages", "a.md"));
      expect(pinnedFolderPath(join(root, "wikipedia", "a.md"))).toBe(
        join(root, "wikipedia", "a.md"),
      );
    });

    it("leaves a configured folder alone when it is a plain directory, missing, or leaves the vault", () => {
      const { root, outside } = vault();
      mkdirSync(join(root, "plain"));
      symlinkSync(outside, join(root, "escape"));
      pin(root, ["plain", "escape", "absent"]);
      for (const p of ["plain/a.md", "escape/x.md", "absent/a.md"])
        expect(pinnedFolderPath(join(root, p))).toBe(join(root, p));
    });
  },
);

describe.skipIf(process.platform === "win32" || !nativeVaultIo)(
  "native safe-open keeps refusing every other symlink",
  () => {
    it("reads through a configured symlinked folder", () => {
      const { root } = vault();
      symlinkSync(join(root, "pages"), join(root, "wiki"));
      pin(root, ["wiki"]);
      expect(readNote(join(root, "wiki", "a.md")).raw).toBe("page A\n");
    });

    it("refuses a symlinked folder that is NOT configured", () => {
      const { root } = vault();
      symlinkSync(join(root, "notes"), join(root, "planted"));
      pin(root, ["wiki"]);
      expect(() => readNote(join(root, "planted", "secret.md"))).toThrow(/safe open refused/);
    });

    it("refuses a symlink planted under the configured folder's real directory", () => {
      const { root } = vault();
      symlinkSync(join(root, "pages"), join(root, "wiki"));
      symlinkSync(join(root, "notes"), join(root, "pages", "planted"));
      pin(root, ["wiki"]);
      expect(() => readNote(join(root, "wiki", "planted", "secret.md"))).toThrow(
        /safe open refused/,
      );
    });

    it("refuses a symlinked leaf inside the configured folder", () => {
      const { root, outside } = vault();
      symlinkSync(join(root, "pages"), join(root, "wiki"));
      symlinkSync(join(outside, "x.md"), join(root, "pages", "leak.md"));
      pin(root, ["wiki"]);
      expect(() => readNote(join(root, "wiki", "leak.md"))).toThrow(/safe open refused/);
    });

    it("refuses a configured folder that leads out of the vault", () => {
      const { root, outside } = vault();
      symlinkSync(outside, join(root, "wiki"));
      pin(root, ["wiki"]);
      expect(() => readNote(join(root, "wiki", "x.md"))).toThrow(/safe open refused/);
    });
  },
);
