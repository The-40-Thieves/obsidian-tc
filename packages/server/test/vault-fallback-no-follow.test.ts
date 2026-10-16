import { spawn, spawnSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const ambientFallback = process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
vi.resetModules();
const fallbackNotes = await import("../src/vault/notes-io");
const { resolveAttachmentFolder } = await import("../src/formats/attachments");
const { FolderPins, withFolderPins } = await import("../src/vault/folder-links");

if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;

vi.resetModules();
const nativeNotes = ambientFallback === "1" ? null : await import("../src/vault/notes-io");

type Refusal = { code?: string; message: string };

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = makeTempDir(prefix);
  temps.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temps.splice(0)) rmTemp(dir);
});

function trySymlink(target: string, link: string, type: "dir" | "file" | "junction"): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

function probeSymlink(type: "dir" | "file" | "junction"): boolean {
  const root = makeTempDir("otc-link-probe-");
  const target = makeTempDir("otc-link-target-");
  try {
    if (type === "file") writeFileSync(join(target, "target"), "probe");
    return trySymlink(type === "file" ? join(target, "target") : target, join(root, "link"), type);
  } finally {
    rmTemp(root);
    rmTemp(target);
  }
}

const directorySymlinkOk = probeSymlink("dir");
const fileSymlinkOk = probeSymlink("file");
const junctionOk = probeSymlink("junction");

function refusalOf(read: () => unknown): Refusal {
  try {
    const served = read();
    throw new Error(`expected a refusal, but the escape was served: ${JSON.stringify(served)}`);
  } catch (error) {
    return error as Refusal;
  }
}

function signature(error: Refusal, paths: string[]): Refusal {
  return {
    code: error.code,
    message: paths.reduce((message, path) => message.replaceAll(path, "<path>"), error.message),
  };
}

describe("pure-JS vault reads refuse linked path components", () => {
  it("forces the fallback implementation for this suite", () => {
    expect(fallbackNotes.nativeVaultIo).toBe(false);
  });

  it.skipIf(!directorySymlinkOk)(
    "refuses a symlinked ancestor instead of serving its content",
    () => {
      const root = temp("otc-fallback-vault-");
      const outside = temp("otc-fallback-outside-");
      writeFileSync(join(outside, "note.md"), "SECRET");
      symlinkSync(outside, join(root, "sub"), "dir");

      const error = refusalOf(() => fallbackNotes.readNote(join(root, "sub", "note.md")));

      expect(error.code).toBe("acl_denied");
      expect(error.message).toBe(
        'safe open refused the path: refusing symlinked or missing path component: "sub"',
      );
    },
  );

  it.runIf(process.platform === "win32" && junctionOk)(
    "refuses a Windows junction ancestor instead of serving its content",
    () => {
      const root = temp("otc-fallback-vault-");
      const outside = temp("otc-fallback-outside-");
      writeFileSync(join(outside, "note.md"), "SECRET");
      symlinkSync(outside, join(root, "sub"), "junction");

      const error = refusalOf(() => fallbackNotes.readNote(join(root, "sub", "note.md")));

      expect(error.code).toBe("acl_denied");
    },
  );

  it.skipIf(!junctionOk)(
    "does not read attachment settings through a linked .obsidian directory",
    () => {
      const root = temp("otc-fallback-vault-");
      const outside = temp("otc-fallback-outside-");
      writeFileSync(join(outside, "app.json"), '{"attachmentFolderPath":"SYMLINK-SECRET"}');
      symlinkSync(outside, join(root, ".obsidian"), "junction");

      expect(resolveAttachmentFolder(root)).toBe("");
    },
  );

  it.skipIf(!fileSymlinkOk)("refuses a symlinked leaf", () => {
    const root = temp("otc-fallback-vault-");
    const outside = temp("otc-fallback-outside-");
    writeFileSync(join(outside, "note.md"), "SECRET");
    symlinkSync(join(outside, "note.md"), join(root, "note.md"), "file");

    const error = refusalOf(() => fallbackNotes.readNote(join(root, "note.md")));

    expect(error.code).toBe("acl_denied");
  });

  it("keeps refusing hard-linked leaves", () => {
    const allowed = temp("otc-fallback-allowed-");
    const privateDir = temp("otc-fallback-private-");
    const secret = join(privateDir, "secret.md");
    writeFileSync(secret, "SECRET");
    linkSync(secret, join(allowed, "hard.md"));

    const error = refusalOf(() => fallbackNotes.readNote(join(allowed, "hard.md")));

    expect(error.code).toBe("acl_denied");
  });

  it.skipIf(!directorySymlinkOk)(
    "returns the same refusal whether content beyond a symlinked ancestor exists or not",
    () => {
      const existingRoot = temp("otc-fallback-existing-vault-");
      const existingOutside = temp("otc-fallback-existing-outside-");
      const missingRoot = temp("otc-fallback-missing-vault-");
      const missingOutside = temp("otc-fallback-missing-outside-");
      writeFileSync(join(existingOutside, "note.md"), "SECRET");
      symlinkSync(existingOutside, join(existingRoot, "sub"), "dir");
      symlinkSync(missingOutside, join(missingRoot, "sub"), "dir");
      mkdirSync(join(existingRoot, "plain"));
      writeFileSync(join(existingRoot, "plain", "note.md"), "PLAIN");

      const existing = refusalOf(() =>
        fallbackNotes.readNote(join(existingRoot, "sub", "note.md")),
      );
      const missing = refusalOf(() => fallbackNotes.readNote(join(missingRoot, "sub", "note.md")));

      expect(signature(existing, [existingRoot, existingOutside])).toEqual(
        signature(missing, [missingRoot, missingOutside]),
      );
      expect(fallbackNotes.readNote(join(existingRoot, "plain", "note.md")).raw).toBe("PLAIN");
    },
  );

  it.runIf(directorySymlinkOk && nativeNotes?.nativeVaultIo === true)(
    "matches the native refusal for a symlinked ancestor",
    () => {
      const fallbackRoot = temp("otc-fallback-parity-vault-");
      const fallbackOutside = temp("otc-fallback-parity-outside-");
      const nativeRoot = temp("otc-native-parity-vault-");
      const nativeOutside = temp("otc-native-parity-outside-");
      writeFileSync(join(fallbackOutside, "note.md"), "SECRET");
      writeFileSync(join(nativeOutside, "note.md"), "SECRET");
      symlinkSync(fallbackOutside, join(fallbackRoot, "sub"), "dir");
      symlinkSync(nativeOutside, join(nativeRoot, "sub"), "dir");

      const fallbackError = refusalOf(() =>
        fallbackNotes.readNote(join(fallbackRoot, "sub", "note.md")),
      );
      const nativeError = refusalOf(() =>
        nativeNotes?.readNote(join(nativeRoot, "sub", "note.md")),
      );

      expect(signature(fallbackError, [fallbackRoot, fallbackOutside])).toEqual(
        signature(nativeError, [nativeRoot, nativeOutside]),
      );
    },
  );

  it.runIf(directorySymlinkOk && fileSymlinkOk && nativeNotes?.nativeVaultIo === true)(
    "matches native refusals for every missing, linked, and non-directory component shape",
    () => {
      const cases: Array<{
        name: string;
        arrange: (root: string, outside: string) => string;
      }> = [
        {
          name: "symlinked ancestor with no leaf beyond it",
          arrange: (root, outside) => {
            symlinkSync(outside, join(root, "sub"), "dir");
            return join(root, "sub", "missing.md");
          },
        },
        {
          name: "dangling symlinked ancestor",
          arrange: (root, outside) => {
            symlinkSync(join(outside, "missing-dir"), join(root, "sub"), "dir");
            return join(root, "sub", "missing.md");
          },
        },
        {
          name: "leaf symlink to a missing outside file",
          arrange: (root, outside) => {
            symlinkSync(join(outside, "missing.md"), join(root, "note.md"), "file");
            return join(root, "note.md");
          },
        },
        {
          name: "regular file used as an intermediate component",
          arrange: (root) => {
            writeFileSync(join(root, "sub"), "not a directory");
            return join(root, "sub", "note.md");
          },
        },
      ];

      for (const shape of cases) {
        const fallbackRoot = temp(`otc-fallback-${shape.name}-`);
        const fallbackOutside = temp(`otc-fallback-outside-${shape.name}-`);
        const nativeRoot = temp(`otc-native-${shape.name}-`);
        const nativeOutside = temp(`otc-native-outside-${shape.name}-`);
        const fallbackPath = shape.arrange(fallbackRoot, fallbackOutside);
        const nativePath = shape.arrange(nativeRoot, nativeOutside);

        const fallbackError = refusalOf(() => fallbackNotes.readNote(fallbackPath));
        const nativeError = refusalOf(() => nativeNotes?.readNote(nativePath));

        expect(fallbackError.code, shape.name).toBe("acl_denied");
        expect(signature(nativeError, [nativeRoot, nativeOutside]), shape.name).toEqual(
          signature(fallbackError, [fallbackRoot, fallbackOutside]),
        );
      }
    },
  );

  it.runIf(directorySymlinkOk && nativeNotes?.nativeVaultIo === true)(
    "does not reveal whether a file beyond a symlinked ancestor exists on either backend",
    () => {
      for (const notes of [fallbackNotes, nativeNotes] as const) {
        const existingRoot = temp("otc-parity-existing-vault-");
        const existingOutside = temp("otc-parity-existing-outside-");
        const missingRoot = temp("otc-parity-missing-vault-");
        const missingOutside = temp("otc-parity-missing-outside-");
        writeFileSync(join(existingOutside, "note.md"), "SECRET");
        symlinkSync(existingOutside, join(existingRoot, "sub"), "dir");
        symlinkSync(missingOutside, join(missingRoot, "sub"), "dir");

        const existing = refusalOf(() => notes?.readNote(join(existingRoot, "sub", "note.md")));
        const missing = refusalOf(() => notes?.readNote(join(missingRoot, "sub", "note.md")));

        expect(signature(existing, [existingRoot, existingOutside])).toEqual(
          signature(missing, [missingRoot, missingOutside]),
        );
        expect(existing.code).toBe("acl_denied");
      }
    },
  );

  it.runIf(nativeNotes?.nativeVaultIo === true)(
    "keeps ENOENT when every component before the missing leaf is a real directory",
    () => {
      for (const notes of [fallbackNotes, nativeNotes] as const) {
        const root = temp("otc-parity-ordinary-missing-");
        mkdirSync(join(root, "sub"));

        const error = refusalOf(() => notes?.readNote(join(root, "sub", "missing.md")));

        expect(error.code).toBe("ENOENT");
      }
    },
  );

  it("reads an ordinary nested note exactly", () => {
    const root = temp("otc-fallback-vault-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "note.md"), "ordinary nested note\n");

    expect(fallbackNotes.readNote(join(root, "a", "b", "note.md")).raw).toBe(
      "ordinary nested note\n",
    );
  });

  it.skipIf(!directorySymlinkOk)("keeps the configured-folder fallback refusal unchanged", () => {
    const root = temp("otc-fallback-vault-");
    mkdirSync(join(root, "pages"));
    writeFileSync(join(root, "pages", "note.md"), "page");
    symlinkSync(join(root, "pages"), join(root, "wiki"), "dir");
    const pins = new FolderPins([{ root, wikiFolder: "wiki" }]);

    const error = refusalOf(() =>
      withFolderPins(pins, () => fallbackNotes.readNote(join(root, "wiki", "note.md"))),
    );

    expect(error.code).toBe("acl_denied");
    expect(error.message).toBe(
      "configured symlinked folders require the native module: this path runs through one, and without it (Windows, OBSIDIAN_TC_FORCE_JS_FALLBACK, or an addon-less install) it cannot be opened safely",
    );
  });
});

describe("pure-JS no-follow race and platform guards", () => {
  it("starts the ancestor walk at a known canonical vault root", async () => {
    const root = temp("otc-fallback-known-root-");
    const leaf = join(root, "a", "b", "note.md");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(leaf, "known root");
    const inspected: string[] = [];

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: unknown) => {
          inspected.push(String(path));
          return actual.lstatSync(path, options as never);
        }) as typeof actual.lstatSync,
      };
    });
    process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
    vi.resetModules();
    try {
      const rootedNotes = await import("../src/vault/notes-io");
      const rootedLinks = await import("../src/vault/folder-links");
      const pins = new rootedLinks.FolderPins([{ root }]);

      const note = rootedLinks.withFolderPins(pins, () => rootedNotes.readNote(leaf));

      expect(note.raw).toBe("known root");
      expect(inspected.length).toBeGreaterThan(0);
      expect(inspected.every((path) => path === root || path.startsWith(`${root}${sep}`))).toBe(
        true,
      );
    } finally {
      if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
      else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.skipIf(!directorySymlinkOk)(
    "rechecks ancestor identities after the leaf is opened",
    async () => {
      const root = temp("otc-fallback-race-vault-");
      const outside = temp("otc-fallback-race-outside-");
      const sub = join(root, "sub");
      const held = join(root, "held");
      const leaf = join(sub, "note.md");
      mkdirSync(sub);
      writeFileSync(leaf, "INSIDE");
      writeFileSync(join(outside, "note.md"), "OUTSIDE-SECRET");
      let swapped = false;

      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return {
          ...actual,
          lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: unknown) => {
            if (path === leaf && !swapped) {
              swapped = true;
              actual.renameSync(sub, held);
              actual.symlinkSync(outside, sub, "dir");
            }
            return actual.lstatSync(path, options as never);
          }) as typeof actual.lstatSync,
        };
      });
      process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
      vi.resetModules();
      try {
        const racedNotes = await import("../src/vault/notes-io");

        const error = refusalOf(() => racedNotes.readNote(leaf));

        expect(swapped).toBe(true);
        expect(error.code).toBe("acl_denied");
      } finally {
        if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
        else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );

  it.runIf(process.platform === "linux" && directorySymlinkOk)(
    "falls back to the ancestor re-walk when the proc fd lookup is unavailable",
    async () => {
      const root = temp("otc-fallback-no-proc-vault-");
      const outside = temp("otc-fallback-no-proc-outside-");
      const sub = join(root, "sub");
      const held = join(root, "held");
      const leaf = join(sub, "note.md");
      mkdirSync(sub);
      writeFileSync(leaf, "INSIDE");
      writeFileSync(join(outside, "note.md"), "OUTSIDE-SECRET");
      let swapped = false;
      const readlink = vi.fn(() => {
        const error = new Error("procfs unavailable") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      });

      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return {
          ...actual,
          lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: unknown) => {
            if (path === leaf && !swapped) {
              swapped = true;
              actual.renameSync(sub, held);
              actual.symlinkSync(outside, sub, "dir");
            }
            return actual.lstatSync(path, options as never);
          }) as typeof actual.lstatSync,
          readlinkSync: readlink,
        };
      });
      process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
      vi.resetModules();
      try {
        const racedNotes = await import("../src/vault/notes-io");

        const error = refusalOf(() => racedNotes.readNote(leaf));

        expect(swapped).toBe(true);
        expect(readlink).toHaveBeenCalledOnce();
        expect(error.code).toBe("acl_denied");
        expect(error.message).toContain("path component changed while opening");
      } finally {
        if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
        else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );

  it("normalizes a Windows path before splitting its components", async () => {
    const abs = "C:/vault/sub/n.md";
    const leaf = {
      dev: 1n,
      ino: 2n,
      nlink: 1,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const dir = {
      ...leaf,
      ino: 1n,
      isDirectory: () => true,
      isFile: () => false,
    };
    const symlink = {
      ...dir,
      isDirectory: () => false,
      isSymbolicLink: () => true,
    };

    vi.doMock("node:path", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:path")>();
      return {
        ...actual,
        dirname: actual.win32.dirname,
        join: actual.win32.join,
        normalize: actual.win32.normalize,
        parse: actual.win32.parse,
        sep: actual.win32.sep,
      };
    });
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        closeSync: vi.fn(),
        fstatSync: vi.fn(() => leaf),
        lstatSync: vi.fn((path: string) => {
          if (path === "C:\\vault\\sub") return symlink;
          if (path === abs || path === "C:\\vault\\sub\\n.md") return leaf;
          return dir;
        }),
        openSync: vi.fn(() => 42),
        readFileSync: vi.fn(() => "SECRET"),
      };
    });
    process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
    vi.resetModules();
    try {
      const windowsNotes = await import("../src/vault/notes-io");

      const error = refusalOf(() => windowsNotes.readNote(abs));

      expect(error.code).toBe("acl_denied");
    } finally {
      if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
      else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;
      vi.doUnmock("node:fs");
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  it("refuses a non-regular leaf before calling open", async () => {
    const abs = "/virtual/vault/pipe";
    const dir = {
      dev: 1n,
      ino: 1n,
      nlink: 1,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
    const fifo = { ...dir, ino: 2n, isDirectory: () => false };
    const open = vi.fn(() => 42);

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        closeSync: vi.fn(),
        fstatSync: vi.fn(() => fifo),
        lstatSync: vi.fn((path: string) => (path === abs ? fifo : dir)),
        openSync: open,
      };
    });
    process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
    vi.resetModules();
    try {
      const fifoNotes = await import("../src/vault/notes-io");

      const error = refusalOf(() => fifoNotes.readNote(abs));

      expect(error.code).toBe("path_invalid");
      expect(open).not.toHaveBeenCalled();
    } finally {
      if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
      else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO swapped in after the leaf check without blocking",
    { timeout: stallTimeout(4_000) },
    async (ctx) => {
      const root = temp("otc-fallback-fifo-");
      const abs = join(root, "note.md");
      const prior = join(root, "prior.md");
      writeFileSync(prior, "prior regular file");
      const priorStat = lstatSync(prior, { bigint: true });
      const made = spawnSync("mkfifo", [abs], { encoding: "utf8" });
      if ((made.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        ctx.skip("mkfifo is unavailable");
        return;
      }
      expect(made.status, made.stderr).toBe(0);

      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return {
          ...actual,
          lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: unknown) =>
            path === abs
              ? priorStat
              : actual.lstatSync(path, options as never)) as typeof lstatSync,
        };
      });
      process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
      vi.resetModules();
      // Release the vulnerable blocking open after the two-second assertion budget so the RED run
      // terminates instead of stranding its worker forever.
      const writer = spawn(
        process.execPath,
        [
          "-e",
          "setTimeout(() => { const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'w'); fs.closeSync(fd); }, 2250)",
          abs,
        ],
        { stdio: "ignore" },
      );
      try {
        const fifoNotes = await import("../src/vault/notes-io");

        const started = performance.now();
        const error = refusalOf(() => fifoNotes.readNote(abs));
        const elapsed = performance.now() - started;

        expect.soft(elapsed).toBeLessThan(2_000);
        expect.soft(error.code).toBe("path_invalid");
        expect.soft(error.message).toContain("not a regular file");
      } finally {
        writer.kill();
        if (ambientFallback === undefined) delete process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK;
        else process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = ambientFallback;
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );
});
