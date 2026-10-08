// A configured symlinked folder (`wiki -> open`) is pinned when the registry is built (see
// folder-pins.test.ts for reads and moves). This file holds the DESTRUCTIVE and BATCH sinks to the
// same rule, and the pure-JS fallback to its own: hardDelete, delete_note / delete_attachment
// (permanent), and the write batch's move-aside / drop / put-back steps all act on the pinned
// directory, never the live alias; and without the native module a path through a pinned folder is
// refused (Node has no openat, so a retarget between the check and the open cannot be closed).
//
// The seam: the `vi.mock` below runs a one-shot hook right before the handler's `hardDelete`, after
// every ACL stage, so a test retargets the symlink exactly between the decision and the I/O. The
// batch tests retarget in `beforeCommit`, which runs before the removals. No sleeps anywhere.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { withFolderPins } from "../src/vault/folder-links";
import {
  hardDelete,
  moveNoReplace,
  nativeVaultIo,
  readNote,
  stageNoteWrite,
  writeNoteAtomic,
} from "../src/vault/notes-io";
import { VaultRegistry } from "../src/vault/registry";
import { applyWriteBatch } from "../src/vault/write-batch";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const seam = vi.hoisted(() => ({ beforeDelete: null as null | (() => void) }));
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...real,
    hardDelete: (abs: string) => {
      const hook = seam.beforeDelete;
      seam.beforeDelete = null;
      hook?.();
      return real.hardDelete(abs);
    },
  };
});

const WHY = /configured symlinked folders require the native module/;
const SAME = "same bytes in open and raw\n";

const temps: string[] = [];
let v: TestVault | undefined;
afterEach(() => {
  seam.beforeDelete = null;
  v?.cleanup();
  v = undefined;
  for (const t of temps.splice(0)) rmTemp(t);
});

const under = <T>(reg: VaultRegistry, fn: () => T): T => withFolderPins(reg.folderPins, fn);

/** Point the vault's `wiki` symlink at `target` (vault-relative). */
const retarget = (root: string, target: string): void => {
  unlinkSync(join(root, "wiki"));
  symlinkSync(join(root, target), join(root, "wiki"));
};

/** A vault with open/ and the immutable raw/ side by side and `wiki -> open`. */
function openAndRawVault(raw = "RAW SOURCE\n", open = "open note\n"): string {
  const base = makeTempDir("obtc-pinned-sinks-");
  temps.push(base);
  const root = join(base, "vault");
  for (const d of ["open", "raw"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "open", "x.md"), open);
  writeFileSync(join(root, "raw", "x.md"), raw);
  symlinkSync(join(root, "open"), join(root, "wiki"));
  return root;
}
const wikiRegistry = (root: string): VaultRegistry =>
  new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
const text = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** Call a destructive tool once to get its confirmation token, then again with it. */
async function confirmed(t: TestVault, tool: string, input: Record<string, unknown>) {
  const need = await t.call(tool, input);
  if (need.ok) return need;
  const argsHash = String((need.error.details as { args_hash?: string }).args_hash);
  const token = issueElicitToken(t.db, {
    vaultId: t.id,
    toolName: tool,
    argsHash,
    caller: "test",
  });
  return t.call(tool, input, { elicitToken: token });
}

describe.skipIf(process.platform === "win32")("hardDelete acts on the pinned directory", () => {
  it("after wiki -> open is retargeted to raw, the pinned open/x.md goes and raw/x.md stays", () => {
    const root = openAndRawVault();
    const reg = wikiRegistry(root);
    retarget(root, "raw");
    const attempt = () => under(reg, () => hardDelete(join(root, "wiki", "x.md")));
    if (nativeVaultIo) {
      attempt();
      expect(existsSync(join(root, "open", "x.md"))).toBe(false);
    } else {
      expect(attempt).toThrow(WHY);
      expect(text(root, "open/x.md")).toBe("open note\n");
    }
    expect(text(root, "raw/x.md")).toBe("RAW SOURCE\n");
  });

  it("a pinned directory replaced under its name (raw renamed into it) is refused", () => {
    const root = openAndRawVault();
    const reg = wikiRegistry(root);
    renameSync(join(root, "open"), join(root, "open-gone"));
    renameSync(join(root, "raw"), join(root, "open"));
    expect(() => under(reg, () => hardDelete(join(root, "wiki", "x.md")))).toThrow();
    expect(text(root, "open/x.md")).toBe("RAW SOURCE\n");
    expect(text(root, "open-gone/x.md")).toBe("open note\n");
  });

  it.skipIf(!nativeVaultIo)(
    "a delete outside any dispatch frame (no pins) is refused by the native walk",
    () => {
      const root = openAndRawVault();
      wikiRegistry(root);
      retarget(root, "raw");
      try {
        hardDelete(join(root, "wiki", "x.md"));
      } catch {
        // refused: fine
      }
      expect(text(root, "raw/x.md")).toBe("RAW SOURCE\n");
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "the delete tools never reach the live alias between the ACL and the I/O",
  () => {
    const wikiVault = (files: Record<string, string>): TestVault =>
      (v = makeTestVault({
        files,
        wikiFolder: "wiki",
        centralAcl: true,
        setup: (root) => symlinkSync(join(root, "open"), join(root, "wiki")),
      }));

    it("delete_note permanent: wiki -> open for the ACL, -> raw before the delete, raw/x.md survives", async () => {
      const t = wikiVault({ "open/x.md": "open note\n", "raw/x.md": "RAW SOURCE\n" });
      seam.beforeDelete = () => retarget(t.root, "raw");
      await confirmed(t, "delete_note", { vault: "test", path: "wiki/x.md", permanent: true });
      expect(text(t.root, "raw/x.md")).toBe("RAW SOURCE\n");
      if (nativeVaultIo) expect(existsSync(join(t.root, "open", "x.md"))).toBe(false);
    });

    it("delete_attachment permanent: the same retarget leaves raw/pic.png alone", async () => {
      const t = makeM3Vault({
        files: { "open/pic.png": "open bytes", "raw/pic.png": "RAW BYTES" },
        wikiFolder: "wiki",
        setup: (root) => symlinkSync(join(root, "open"), join(root, "wiki")),
      });
      try {
        seam.beforeDelete = () => retarget(t.root, "raw");
        const input = { vault: "test", path: "wiki/pic.png", permanent: true };
        const r = await t.callConfirmed("delete_attachment", input);
        expect(text(t.root, "raw/pic.png")).toBe("RAW BYTES");
        if (nativeVaultIo) expect(r.ok && existsSync(join(t.root, "open", "pic.png"))).toBe(false);
        else expect(r.ok).toBe(false);
      } finally {
        t.cleanup();
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "the write batch's move-aside steps are pinned",
  () => {
    const dest = (root: string) => join(root, "moved.md");
    const batch = (root: string, expected: string, retargetFirst: boolean) =>
      applyWriteBatch([{ abs: dest(root), rel: "moved.md", content: "moved\n", prevRaw: null }], {
        beforeCommit: () => {
          if (retargetFirst) retarget(root, "raw");
        },
        removals: [{ abs: join(root, "wiki", "x.md"), rel: "wiki/x.md", expected }],
      });

    it("dropping a move's source after a retarget removes the pinned file, never raw/x.md", () => {
      const root = openAndRawVault(SAME, SAME);
      const reg = wikiRegistry(root);
      const run = () => under(reg, () => batch(root, SAME, true));
      if (nativeVaultIo) {
        run();
        expect(existsSync(join(root, "open", "x.md"))).toBe(false);
        expect(text(root, "moved.md")).toBe("moved\n");
      } else {
        expect(run).toThrow(WHY);
        expect(existsSync(dest(root))).toBe(false);
      }
      expect(text(root, "raw/x.md")).toBe(SAME);
    });

    it("a rollback after a retarget puts the pinned file back and never touches raw/x.md", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      // The source no longer holds what the move was planned from, so the batch rolls back.
      expect(() => under(reg, () => batch(root, "something else\n", true))).toThrow();
      expect(text(root, "raw/x.md")).toBe("RAW SOURCE\n");
      expect(text(root, "open/x.md")).toBe("open note\n");
      expect(existsSync(dest(root))).toBe(false);
    });

    it("without a retarget the same batch moves a note out of the pinned folder", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      const run = () => under(reg, () => batch(root, "open note\n", false));
      if (nativeVaultIo) {
        run();
        expect(existsSync(join(root, "open", "x.md"))).toBe(false);
        expect(text(root, "moved.md")).toBe("moved\n");
      } else {
        expect(run).toThrow(WHY);
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "through a pinned folder, without the native module",
  () => {
    const refused = (fn: () => unknown): void => {
      try {
        fn();
      } catch (e) {
        expect((e as { code?: string }).code).toBe("acl_denied");
        if (!nativeVaultIo) expect((e as Error).message).toMatch(WHY);
        return;
      }
      throw new Error("expected the operation through the pinned folder to be refused");
    };

    it("writes and staged writes are refused (native or not)", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      const x = join(root, "wiki", "x.md");
      refused(() => under(reg, () => writeNoteAtomic(x, "new\n", false)));
      refused(() => under(reg, () => writeNoteAtomic(join(root, "wiki", "n.md"), "new\n", true)));
      refused(() => under(reg, () => stageNoteWrite(x, "new\n", false).commit()));
      expect(text(root, "open/x.md")).toBe("open note\n");
    });

    it.skipIf(nativeVaultIo)("reads, moves and deletes are refused, naming why", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      const x = join(root, "wiki", "x.md");
      refused(() => under(reg, () => readNote(x)));
      refused(() => under(reg, () => moveNoReplace(x, join(root, "moved.md"))));
      refused(() =>
        under(reg, () => moveNoReplace(join(root, "open", "x.md"), join(root, "wiki", "y.md"))),
      );
      refused(() => under(reg, () => hardDelete(x)));
      expect(text(root, "open/x.md")).toBe("open note\n");
      expect(existsSync(join(root, "moved.md"))).toBe(false);
    });

    it("a configured folder that is NOT a symlink keeps working: read, write, move, delete", () => {
      const base = makeTempDir("obtc-pinned-sinks-plain-");
      temps.push(base);
      const root = join(base, "vault");
      mkdirSync(join(root, "wiki"), { recursive: true });
      writeFileSync(join(root, "wiki", "x.md"), "plain wiki note\n");
      const reg = wikiRegistry(root);
      under(reg, () => {
        expect(readNote(join(root, "wiki", "x.md")).raw).toBe("plain wiki note\n");
        writeNoteAtomic(join(root, "wiki", "y.md"), "written\n", false);
        moveNoReplace(join(root, "wiki", "y.md"), join(root, "wiki", "z.md"));
        hardDelete(join(root, "wiki", "z.md"));
        hardDelete(join(root, "wiki", "never-existed.md"));
      });
      expect(text(root, "wiki/x.md")).toBe("plain wiki note\n");
      expect(existsSync(join(root, "wiki", "y.md"))).toBe(false);
      expect(existsSync(join(root, "wiki", "z.md"))).toBe(false);
    });
  },
);

// An older .node has no safeUnlink and would ignore a pin: the delete must refuse, never fall back
// to rmSync on the alias.
describe.skipIf(process.platform === "win32" || !nativeVaultIo)(
  "an addon that predates safeUnlink",
  () => {
    it("refuses a pinned delete and still deletes a plain file", async () => {
      const mod = createRequire(import.meta.url)("@the-40-thieves/obsidian-tc-native") as Record<
        string,
        unknown
      >;
      const real = mod.safeUnlink;
      mod.safeUnlink = undefined;
      try {
        vi.resetModules();
        const io =
          await vi.importActual<typeof import("../src/vault/notes-io")>("../src/vault/notes-io");
        const links = await import("../src/vault/folder-links");
        const registry = await import("../src/vault/registry");
        const root = openAndRawVault();
        const reg = new registry.VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
        writeFileSync(join(root, "plain.md"), "plain\n");
        links.withFolderPins(reg.folderPins, () => {
          expect(() => io.hardDelete(join(root, "wiki", "x.md"))).toThrow(WHY);
          io.hardDelete(join(root, "plain.md"));
        });
        expect(text(root, "open/x.md")).toBe("open note\n");
        expect(existsSync(join(root, "plain.md"))).toBe(false);
      } finally {
        mod.safeUnlink = real;
        vi.resetModules();
      }
    });
  },
);
