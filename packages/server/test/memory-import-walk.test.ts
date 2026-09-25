// THE-1124 — memory-import/walk.ts: refuses symlinks (walk-level) and hard links (read-level, via
// readNote — see [[reference-two-aliases-symlink-and-hardlink]]) by reporting a reason rather than
// silently dropping the file, and refuses a path that escapes the import root
// (checkedImportPath, backed by vault/paths.ts's resolveVaultPathChecked — see
// [[feedback-delete-path-as-strict-as-write-path]]: a new read path over caller-supplied files
// must reuse the write path's own containment guarantee, not a weaker ad hoc one).
import { chmodSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertImportRootUsable,
  checkedImportPath,
  walkImportDir,
} from "../src/memory-import/walk";
import { rmTemp } from "./tmp";

// Same capability probe vault-watcher.test.ts / server-runtime.test.ts use: creating a symlink
// needs a privilege Windows does not grant by default.
let symlinkOk = true;
try {
  const probe = mkdtempSync(join(tmpdir(), "tc-mi-sl-probe-"));
  symlinkSync(join(probe, "t"), join(probe, "l"), "file");
  rmTemp(probe);
} catch {
  symlinkOk = false;
}

describe("walkImportDir", () => {
  it("walks .md files and returns them sorted by source_path", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-"));
    try {
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "b.md"), "B");
      writeFileSync(join(root, "sub", "a.md"), "A");
      writeFileSync(join(root, "ignored.txt"), "not markdown");
      const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
      expect(files.map((f) => f.sourcePath)).toStrictEqual(["b.md", "sub/a.md"]);
      expect(skipped).toStrictEqual([]);
    } finally {
      rmTemp(root);
    }
  });

  it("does not recurse into dot-directories or read dot-files, and REPORTS both (not silent)", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-dot-"));
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "config.md"), "nope");
      writeFileSync(join(root, ".hidden.md"), "nope");
      writeFileSync(join(root, "visible.md"), "yes");
      const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
      expect(files.map((f) => f.sourcePath)).toStrictEqual(["visible.md"]);
      expect(skipped).toStrictEqual([
        { sourcePath: ".git", reason: "refused: dot-prefixed (ignored)" },
        { sourcePath: ".hidden.md", reason: "refused: dot-prefixed (ignored)" },
      ]);
    } finally {
      rmTemp(root);
    }
  });

  it("reports a reserved Windows filename with its true reason, not a generic 'escapes' string", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-reserved-"));
    try {
      writeFileSync(join(root, "nul.md"), "content");
      const { skipped } = walkImportDir(root, { extensions: [".md"] });
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.sourcePath).toBe("nul.md");
      expect(skipped[0]?.reason).toContain("reserved");
      expect(skipped[0]?.reason).not.toContain("escapes");
    } finally {
      rmTemp(root);
    }
  });

  // root (common in CI containers) ignores directory permission bits entirely, so a chmod 000
  // probe would silently read through and the test would assert nothing real — skip rather than
  // false-pass, the same shape symlinkOk's capability probe uses above.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable sub-directory against its own path, not silently",
    () => {
      const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-unreadable-"));
      try {
        mkdirSync(join(root, "locked"));
        writeFileSync(join(root, "locked", "a.md"), "a");
        chmodSync(join(root, "locked"), 0o000);
        try {
          const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
          expect(files).toStrictEqual([]);
          expect(
            skipped.some((s) => s.sourcePath === "locked" && /unreadable/.test(s.reason)),
          ).toBe(true);
        } finally {
          chmodSync(join(root, "locked"), 0o755);
        }
      } finally {
        rmTemp(root);
      }
    },
  );

  it.skipIf(!symlinkOk)("refuses a symlinked file with a reason, does not read through it", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "obtc-mi-walk-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "not yours");
      symlinkSync(join(outside, "secret.md"), join(root, "linked.md"), "file");
      writeFileSync(join(root, "real.md"), "real content");
      const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
      expect(files.map((f) => f.sourcePath)).toStrictEqual(["real.md"]);
      expect(skipped).toStrictEqual([{ sourcePath: "linked.md", reason: "refused: symlink" }]);
    } finally {
      rmTemp(root);
      rmTemp(outside);
    }
  });

  it.skipIf(!symlinkOk)("does not recurse into a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-symdir-"));
    const outside = mkdtempSync(join(tmpdir(), "obtc-mi-walk-symdir-outside-"));
    try {
      writeFileSync(join(outside, "leaked.md"), "leaked");
      symlinkSync(outside, join(root, "linked-dir"), "dir");
      const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
      expect(files).toStrictEqual([]);
      expect(skipped).toStrictEqual([{ sourcePath: "linked-dir", reason: "refused: symlink" }]);
    } finally {
      rmTemp(root);
      rmTemp(outside);
    }
  });

  it("refuses BOTH hard-linked names with a reason (unguarded — works on every runner, see vault-watcher.test.ts's own comment on why the hard-link case is never capability-probed)", () => {
    // readNote's guard fstats the OPEN fd and refuses nlink > 1 — once a second name exists,
    // BOTH names now report nlink 2, so neither can be trusted as "the real one" and neither is
    // read. That is the correct, conservative behavior: aliasing is a property of the inode, not
    // of which name you happened to open.
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-walk-hardlink-"));
    try {
      writeFileSync(join(root, "original.md"), "original content");
      linkSync(join(root, "original.md"), join(root, "aliased.md"));
      const { files, skipped } = walkImportDir(root, { extensions: [".md"] });
      expect(files).toStrictEqual([]);
      expect(skipped).toStrictEqual([
        { sourcePath: "aliased.md", reason: "refused: hard link" },
        { sourcePath: "original.md", reason: "refused: hard link" },
      ]);
    } finally {
      rmTemp(root);
    }
  });
});

describe("assertImportRootUsable", () => {
  it("throws a clear error for a missing directory (never a silent empty walk)", () => {
    expect(() => assertImportRootUsable(join(tmpdir(), "obtc-mi-does-not-exist-xyz"))).toThrow(
      /does not exist/,
    );
  });

  it("throws for a path that is a file, not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-notdir-"));
    try {
      const file = join(root, "not-a-dir.md");
      writeFileSync(file, "x");
      expect(() => assertImportRootUsable(file)).toThrow(/not a directory/);
    } finally {
      rmTemp(root);
    }
  });

  it.skipIf(!symlinkOk)("throws when the import root ITSELF is a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "obtc-mi-rootsym-outside-"));
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-rootsym-"));
    const link = join(root, "link");
    try {
      symlinkSync(outside, link, "dir");
      expect(() => assertImportRootUsable(link)).toThrow(/symlink/);
    } finally {
      rmTemp(root);
      rmTemp(outside);
    }
  });

  it("does not throw for a real, existing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-rootok-"));
    try {
      expect(() => assertImportRootUsable(root)).not.toThrow();
    } finally {
      rmTemp(root);
    }
  });
});

describe("walkImportDir — root validation", () => {
  it("propagates assertImportRootUsable's throw instead of returning an empty result", () => {
    expect(() => walkImportDir(join(tmpdir(), "obtc-mi-does-not-exist-xyz"))).toThrow(
      /does not exist/,
    );
  });
});

describe("checkedImportPath", () => {
  it("resolves a normal relative path inside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-checked-"));
    try {
      mkdirSync(join(root, "notes"), { recursive: true });
      expect(checkedImportPath(root, "notes/a.md")).toBe(join(root, "notes", "a.md"));
    } finally {
      rmTemp(root);
    }
  });

  it("refuses a path that escapes the import root", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-checked-escape-"));
    try {
      expect(() => checkedImportPath(root, "../../../../etc/passwd")).toThrow();
    } finally {
      rmTemp(root);
    }
  });

  it("refuses an absolute path", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-checked-abs-"));
    try {
      expect(() => checkedImportPath(root, "/etc/passwd")).toThrow();
    } finally {
      rmTemp(root);
    }
  });
});
