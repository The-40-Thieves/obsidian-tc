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

// Child process body: flips `<root>/sub` between the real directory and a symlink to `outside`
// until the parent creates `stop` (its busy loop never yields to a signal or stdin handler), then
// reports its flip count. The time cap only bounds a parent that never asks it to stop.
const FLIP_SCRIPT = `
const fs = require("node:fs");
const [root, outside, stop] = process.argv.slice(1);
const sub = root + "/sub";
const held = root + "/held";
const end = Date.now() + 10000;
let flips = 0;
process.stdout.write("ready\\n");
while (Date.now() < end && !fs.existsSync(stop)) {
  try { fs.renameSync(sub, held); fs.symlinkSync(outside, sub, "dir"); flips += 1; } catch {}
  try { fs.unlinkSync(sub); fs.renameSync(held, sub); } catch {}
}
process.stdout.write("flips=" + flips + "\\n");
`;

// Polls until `done` holds. The stall ceiling bounds a child that never reports.
async function waitUntil(done: () => boolean): Promise<void> {
  const end = performance.now() + stallTimeout(5_000);
  while (!done()) {
    if (performance.now() > end) throw new Error("timed out waiting for the flip child");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pure-JS read verifies the opened descriptor's path", () => {
  afterEach(() => {
    fallbackNotes.setOpenedFdPathResolverForTest?.(undefined);
  });

  it("refuses an opened file whose descriptor resolves outside the vault", () => {
    const root = temp("otc-fallback-fd-vault-");
    const outside = temp("otc-fallback-fd-outside-");
    writeFileSync(join(root, "note.md"), "INSIDE");
    writeFileSync(join(outside, "note.md"), "OUTSIDE-SECRET");
    fallbackNotes.setOpenedFdPathResolverForTest(() => ({
      kind: "path",
      path: join(outside, "note.md"),
      folded: false,
    }));

    const error = refusalOf(() => fallbackNotes.readNote(join(root, "note.md")));

    expect(error.code).toBe("acl_denied");
    expect(error.message).toBe(
      "safe open refused the path: opened file resolved to an unexpected path",
    );
  });

  it("closes the descriptor when the opened-path check refuses", async () => {
    const root = temp("otc-fallback-fd-close-vault-");
    const outside = temp("otc-fallback-fd-close-outside-");
    writeFileSync(join(root, "note.md"), "INSIDE");
    writeFileSync(join(outside, "note.md"), "OUTSIDE-SECRET");
    const opened: number[] = [];
    const closed: number[] = [];

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        openSync: ((...args: Parameters<typeof actual.openSync>) => {
          const fd = actual.openSync(...args);
          opened.push(fd);
          return fd;
        }) as typeof actual.openSync,
        closeSync: ((fd: number) => {
          closed.push(fd);
          return actual.closeSync(fd);
        }) as typeof actual.closeSync,
      };
    });
    vi.resetModules();
    try {
      const closeNotes = await import("../src/vault/notes-io");
      closeNotes.setOpenedFdPathResolverForTest(() => ({
        kind: "path",
        path: join(outside, "note.md"),
        folded: false,
      }));

      const error = refusalOf(() => closeNotes.readNote(join(root, "note.md")));

      expect(error.message).toContain("opened file resolved to an unexpected path");
      expect(opened).toHaveLength(1);
      expect(closed).toEqual(opened);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("refuses when a platform lookup fails or throws, and closes the descriptor", async () => {
    const root = temp("otc-fallback-fd-failed-vault-");
    writeFileSync(join(root, "note.md"), "INSIDE");
    const opened: number[] = [];
    const closed: number[] = [];

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        openSync: ((...args: Parameters<typeof actual.openSync>) => {
          const fd = actual.openSync(...args);
          opened.push(fd);
          return fd;
        }) as typeof actual.openSync,
        closeSync: ((fd: number) => {
          closed.push(fd);
          return actual.closeSync(fd);
        }) as typeof actual.closeSync,
      };
    });
    vi.resetModules();
    try {
      const failedNotes = await import("../src/vault/notes-io");
      const leaf = join(root, "note.md");
      const message = "safe open refused the path: opened file path could not be verified";

      failedNotes.setOpenedFdPathResolverForTest(() => ({ kind: "failed" }));
      const failed = refusalOf(() => failedNotes.readNote(leaf));
      failedNotes.setOpenedFdPathResolverForTest(() => {
        throw new Error("EBADF: bad file descriptor");
      });
      const thrown = refusalOf(() => failedNotes.readNote(leaf));

      expect(failed.code).toBe("acl_denied");
      expect(failed.message).toBe(message);
      expect(thrown.message).toBe(message);
      expect(opened).toHaveLength(2);
      expect(closed).toEqual(opened);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("accepts a darwin-style lookup that differs only in case or Unicode form", () => {
    const root = temp("otc-fallback-fd-fold-vault-");
    writeFileSync(join(root, "note.md"), "INSIDE");
    writeFileSync(join(root, "caf\u00e9.md"), "CAFE");
    const leaf = join(root, "note.md");
    const cafe = join(root, "caf\u00e9.md");

    fallbackNotes.setOpenedFdPathResolverForTest(() => ({
      kind: "path",
      path: join(root, "NOTE.md"),
      folded: true,
    }));
    expect(fallbackNotes.readNote(leaf).raw).toBe("INSIDE");

    fallbackNotes.setOpenedFdPathResolverForTest(() => ({
      kind: "path",
      path: join(root, "cafe\u0301.md"),
      folded: true,
    }));
    expect(fallbackNotes.readNote(cafe).raw).toBe("CAFE");

    // Linux compares exactly: the same case-only variant is a mismatch there.
    fallbackNotes.setOpenedFdPathResolverForTest(() => ({
      kind: "path",
      path: join(root, "NOTE.md"),
      folded: false,
    }));
    const exact = refusalOf(() => fallbackNotes.readNote(leaf));
    expect(exact.message).toContain("opened file resolved to an unexpected path");
  });

  it("still refuses a darwin-style lookup that resolves outside the root", () => {
    const root = temp("otc-fallback-fd-fold-escape-vault-");
    const outside = temp("otc-fallback-fd-fold-escape-outside-");
    writeFileSync(join(root, "note.md"), "INSIDE");
    writeFileSync(join(outside, "NOTE.md"), "OUTSIDE-SECRET");
    fallbackNotes.setOpenedFdPathResolverForTest(() => ({
      kind: "path",
      path: join(outside, "NOTE.md"),
      folded: true,
    }));

    const error = refusalOf(() => fallbackNotes.readNote(join(root, "note.md")));

    expect(error.message).toContain("opened file resolved to an unexpected path");
  });

  it("refuses a named path when the root cannot be resolved for the expected path", async () => {
    const root = temp("otc-fallback-root-realpath-vault-");
    const leaf = join(root, "note.md");
    writeFileSync(leaf, "INSIDE");
    const outside = temp("otc-fallback-root-realpath-outside-");

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const native = ((path: Parameters<typeof actual.realpathSync.native>[0]) => {
        if (path === root) throw Object.assign(new Error("ENOENT: realpath"), { code: "ENOENT" });
        return actual.realpathSync.native(path);
      }) as typeof actual.realpathSync.native;
      return {
        ...actual,
        realpathSync: Object.assign((path: string) => actual.realpathSync(path), { native }),
      };
    });
    vi.resetModules();
    try {
      const rootNotes = await import("../src/vault/notes-io");
      const { FolderPins: PinsForRoot, withFolderPins: pinForRoot } = await import(
        "../src/vault/folder-links"
      );
      const pins = new PinsForRoot([{ root }]);
      rootNotes.setOpenedFdPathResolverForTest(() => ({
        kind: "path",
        path: join(outside, "note.md"),
        folded: false,
      }));

      const error = refusalOf(() => pinForRoot(pins, () => rootNotes.readNote(leaf)));

      expect(error.code).toBe("acl_denied");
      expect(error.message).toContain("opened file resolved to an unexpected path");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.skipIf(!directorySymlinkOk)(
    "keeps the walk's refusal when the known root is a dangling symlink",
    () => {
      const holder = temp("otc-fallback-dangling-root-");
      const root = join(holder, "vault");
      symlinkSync(join(holder, "missing"), root, "dir");
      const pins = new FolderPins([{ root }]);

      const error = refusalOf(() =>
        withFolderPins(pins, () => fallbackNotes.readNote(join(root, "note.md"))),
      );

      expect(error.code).toBe("acl_denied");
      expect(error.message).not.toContain("realpath");
    },
  );

  it.skipIf(!directorySymlinkOk)(
    "runs the ancestor re-walk when no opened-path resolver is available",
    async () => {
      const root = temp("otc-fallback-rewalk-vault-");
      const outside = temp("otc-fallback-rewalk-outside-");
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
          openSync: ((...args: Parameters<typeof actual.openSync>) => {
            const fd = actual.openSync(...args);
            if (args[0] === leaf && !swapped) {
              swapped = true;
              actual.renameSync(sub, held);
              actual.symlinkSync(outside, sub, "dir");
            }
            return fd;
          }) as typeof actual.openSync,
        };
      });
      vi.resetModules();
      try {
        const rewalkNotes = await import("../src/vault/notes-io");
        rewalkNotes.setOpenedFdPathResolverForTest(() => ({ kind: "none" }));

        const error = refusalOf(() => rewalkNotes.readNote(leaf));

        expect(swapped).toBe(true);
        expect(error.code).toBe("acl_denied");
        expect(error.message).toContain("path component changed while opening");
      } finally {
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );

  it.runIf(process.platform === "linux" && directorySymlinkOk)(
    "refuses a component swapped back before the check when the platform has no procfs",
    async () => {
      const root = temp("otc-fallback-swapback-vault-");
      const outside = temp("otc-fallback-swapback-outside-");
      const sub = join(root, "sub");
      const held = join(root, "held");
      const leaf = join(sub, "note.md");
      mkdirSync(sub);
      writeFileSync(leaf, "INSIDE");
      writeFileSync(join(outside, "note.md"), "OUTSIDE-SECRET");
      let swaps = 0;
      const platform = Object.getOwnPropertyDescriptor(process, "platform");

      // Simulates macOS on Linux: procfs is absent from the picture, so the only descriptor check
      // is the platform's own. The component is swapped to the outside directory for the open and
      // back to the real directory before the post-open checks, so the ancestor re-walk sees the
      // original identity.
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return {
          ...actual,
          lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: unknown) => {
            if (path === leaf && swaps === 0) {
              swaps += 1;
              actual.renameSync(sub, held);
              actual.symlinkSync(outside, sub, "dir");
            }
            return actual.lstatSync(path, options as never);
          }) as typeof actual.lstatSync,
          openSync: ((...args: Parameters<typeof actual.openSync>) => {
            const fd = actual.openSync(...args);
            if (args[0] === leaf && swaps === 1) {
              swaps += 1;
              actual.unlinkSync(sub);
              actual.renameSync(held, sub);
            }
            return fd;
          }) as typeof actual.openSync,
        };
      });
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      vi.resetModules();
      try {
        const swapNotes = await import("../src/vault/notes-io");

        const error = refusalOf(() => swapNotes.readNote(leaf));

        expect(swaps).toBe(2);
        expect(error.code).toBe("acl_denied");
        expect(error.message).toContain("opened file resolved to an unexpected path");
      } finally {
        Object.defineProperty(process, "platform", platform as PropertyDescriptor);
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );

  it.runIf(process.platform === "darwin")("reports the macOS /dev/fd probe as available", () => {
    expect(
      fallbackNotes.openedFdPathSupported(),
      "macOS fd check unavailable: realpath(/dev/fd/N) does not name the opened file",
    ).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "never serves outside content while a component flips between a directory and a symlink",
    { timeout: stallTimeout(15_000) },
    async () => {
      const root = temp("otc-fallback-darwin-race-vault-");
      const outside = temp("otc-fallback-darwin-race-outside-");
      const leaf = join(root, "sub", "note.md");
      mkdirSync(join(root, "sub"));
      writeFileSync(leaf, "INSIDE");
      writeFileSync(join(outside, "note.md"), "OUTSIDE-SECRET");
      const stop = join(outside, "stop");
      const flipper = spawn(process.execPath, ["-e", FLIP_SCRIPT, root, outside, stop], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      flipper.stdout.setEncoding("utf8");
      flipper.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      await waitUntil(() => output.includes("ready"));
      const pins = new FolderPins([{ root }]);
      const served: string[] = [];
      let attempts = 0;
      const deadline = performance.now() + 3_000;
      try {
        withFolderPins(pins, () => {
          for (let i = 0; i < 2_000 && performance.now() < deadline; i += 1) {
            attempts += 1;
            try {
              const { raw } = fallbackNotes.readNote(leaf);
              if (raw.includes("OUTSIDE")) served.push(raw);
            } catch {
              // A refusal, or a path caught mid-flip, is the correct answer.
            }
          }
        });
      } finally {
        writeFileSync(stop, "");
      }
      try {
        await waitUntil(() => output.includes("flips="));
      } finally {
        flipper.kill();
      }

      expect(served).toEqual([]);
      expect(attempts).toBeGreaterThan(0);
      expect(Number(/flips=(\d+)/.exec(output)?.[1])).toBeGreaterThan(0);
    },
  );
});
