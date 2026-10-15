import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
