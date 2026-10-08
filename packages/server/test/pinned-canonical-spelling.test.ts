// `wiki -> open` pins the directory `open` (vault/folder-links.ts). A caller may name the same
// files by the CANONICAL spelling `open/x.md`, which the ACL happily resolves to itself. The pin must
// follow the directory, not only the configured alias: after the ACL decision, `open` is renamed
// away and the immutable `raw` renamed into its place, and every sink must refuse (or act on the
// pinned original) instead of touching the replacement. Same for the metadata probes
// (`noteExists`, `statNote`), which on the JS path would otherwise report on whatever the name
// reaches now.
//
// Run natively, with OBSIDIAN_TC_FORCE_JS_FALLBACK=1 (ci-server.yml), and against an addon that
// predates safeUnlink. The delete_note case uses the same one-shot seam as pinned-sinks.test.ts.
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
import { folderPinVerdict, pinnedOpenPath, withFolderPins } from "../src/vault/folder-links";
import {
  hardDelete,
  moveNoReplace,
  nativeVaultIo,
  noteExists,
  readNote,
  statNote,
} from "../src/vault/notes-io";
import { resolveVaultPathChecked } from "../src/vault/paths";
import { VaultRegistry } from "../src/vault/registry";
import { applyWriteBatch } from "../src/vault/write-batch";
import { makeTestVault, type TestVault } from "./m1-helpers";
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
const RAW = "RAW SOURCE\n";
const OPEN = "open note\n";

const temps: string[] = [];
let v: TestVault | undefined;
afterEach(() => {
  seam.beforeDelete = null;
  v?.cleanup();
  v = undefined;
  for (const t of temps.splice(0)) rmTemp(t);
});

const under = <T>(reg: VaultRegistry, fn: () => T): T => withFolderPins(reg.folderPins, fn);
const text = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** After the ACL decision: `open` moves aside and the immutable `raw` takes its name. */
const swapInRaw = (root: string): void => {
  renameSync(join(root, "open"), join(root, "open-gone"));
  renameSync(join(root, "raw"), join(root, "open"));
};

function openAndRawVault(raw = RAW, open = OPEN): string {
  const base = makeTempDir("obtc-pinned-canonical-");
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

/** Both survivors of the swap are untouched: the replacement (was raw) and the original. */
function expectSwapUntouched(root: string, raw = RAW, open = OPEN): void {
  expect(text(root, "open/x.md")).toBe(raw);
  expect(text(root, "open-gone/x.md")).toBe(open);
}

describe.skipIf(process.platform === "win32")("the pin follows the directory's own name", () => {
  it("a path under pin.dir carries the same pin as the alias spelling, and keeps its spelling", () => {
    const root = openAndRawVault();
    const reg = wikiRegistry(root);
    under(reg, () => {
      const canonical = pinnedOpenPath(join(root, "open", "x.md"));
      const alias = pinnedOpenPath(join(root, "wiki", "x.md"));
      expect(canonical.pinned).toBeDefined();
      expect(canonical.pinned).toEqual(alias.pinned);
      expect(canonical.path).toBe(join(root, "open", "x.md"));
      expect(folderPinVerdict(join(root, "open", "x.md"))).toEqual({
        kind: "pinned",
        path: join(root, "open", "x.md"),
      });
      // A sibling of the pinned directory is not pinned.
      expect(pinnedOpenPath(join(root, "open-gone", "x.md")).pinned).toBeUndefined();
      expect(pinnedOpenPath(join(root, "raw", "x.md")).pinned).toBeUndefined();
    });
  });

  it("the ACL refuses the canonical spelling once `open` has become a symlink to raw", () => {
    const root = openAndRawVault();
    const reg = wikiRegistry(root);
    renameSync(join(root, "open"), join(root, "open-gone"));
    symlinkSync(join(root, "raw"), join(root, "open"));
    expect(() => under(reg, () => resolveVaultPathChecked(root, "open/x.md"))).toThrow(
      /no longer leads where it did/,
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "canonical spelling, `open` replaced by raw after the ACL decision",
  () => {
    const refused = (fn: () => unknown): void => {
      let thrown: unknown;
      try {
        fn();
      } catch (e) {
        thrown = e;
      }
      expect(thrown, "the operation through the pinned directory must be refused").toBeDefined();
      if (!nativeVaultIo) expect((thrown as Error).message).toMatch(WHY);
    };

    it("hardDelete refuses and the replacement survives", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      swapInRaw(root);
      refused(() => under(reg, () => hardDelete(join(root, "open", "x.md"))));
      expectSwapUntouched(root);
    });

    it("readNote refuses rather than returning the replacement's bytes", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      swapInRaw(root);
      refused(() => under(reg, () => readNote(join(root, "open", "x.md"))));
    });

    it("moveNoReplace refuses out of, and into, the replaced directory", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      swapInRaw(root);
      refused(() =>
        under(reg, () => moveNoReplace(join(root, "open", "x.md"), join(root, "moved.md"))),
      );
      writeFileSync(join(root, "elsewhere.md"), "elsewhere\n");
      refused(() =>
        under(reg, () => moveNoReplace(join(root, "elsewhere.md"), join(root, "open", "y.md"))),
      );
      expectSwapUntouched(root);
      expect(existsSync(join(root, "moved.md"))).toBe(false);
      expect(existsSync(join(root, "open", "y.md"))).toBe(false);
    });

    it("a write batch's removal refuses and leaves both directories alone", () => {
      // Identical bytes in both: the batch's own content check cannot tell the swap apart.
      const root = openAndRawVault(OPEN, OPEN);
      const reg = wikiRegistry(root);
      expect(() =>
        under(reg, () =>
          applyWriteBatch(
            [{ abs: join(root, "moved.md"), rel: "moved.md", content: "moved\n", prevRaw: null }],
            {
              beforeCommit: () => swapInRaw(root),
              removals: [{ abs: join(root, "open", "x.md"), rel: "open/x.md", expected: OPEN }],
            },
          ),
        ),
      ).toThrow();
      expectSwapUntouched(root, OPEN, OPEN);
      expect(existsSync(join(root, "moved.md"))).toBe(false);
    });

    it("a write batch's rollback refuses and leaves both directories alone", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      // `expected` no longer matches, so the batch rolls back after the swap.
      expect(() =>
        under(reg, () =>
          applyWriteBatch(
            [{ abs: join(root, "moved.md"), rel: "moved.md", content: "moved\n", prevRaw: null }],
            {
              beforeCommit: () => swapInRaw(root),
              removals: [
                { abs: join(root, "open", "x.md"), rel: "open/x.md", expected: "stale\n" },
              ],
            },
          ),
        ),
      ).toThrow();
      expectSwapUntouched(root);
      expect(existsSync(join(root, "moved.md"))).toBe(false);
    });

    it("delete_note permanent, named by the canonical path, leaves the replacement alone", async () => {
      v = makeTestVault({
        files: { "open/x.md": OPEN, "raw/x.md": RAW },
        wikiFolder: "wiki",
        centralAcl: true,
        setup: (root) => symlinkSync(join(root, "open"), join(root, "wiki")),
      });
      const t = v;
      let swapped = false;
      seam.beforeDelete = () => {
        swapped = true;
        swapInRaw(t.root);
      };
      const input = { vault: "test", path: "open/x.md", permanent: true };
      const need = await t.call("delete_note", input);
      if (!need.ok) {
        const argsHash = String((need.error.details as { args_hash?: string }).args_hash);
        const elicitToken = issueElicitToken(t.db, {
          vaultId: t.id,
          toolName: "delete_note",
          argsHash,
          caller: "test",
        });
        await t.call("delete_note", input, { elicitToken });
      }
      // Without native I/O the pre-delete existence probe already refuses, so the seam never fires.
      expect(swapped).toBe(nativeVaultIo);
      if (swapped) expectSwapUntouched(t.root);
      else {
        expect(text(t.root, "open/x.md")).toBe(OPEN);
        expect(text(t.root, "raw/x.md")).toBe(RAW);
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "noteExists and statNote go through the pin, not the live alias",
  () => {
    it("after wiki -> open is retargeted to raw, neither reports raw's files", () => {
      const root = openAndRawVault();
      writeFileSync(join(root, "raw", "only-raw.md"), "only in raw\n");
      const reg = wikiRegistry(root);
      unlinkSync(join(root, "wiki"));
      symlinkSync(join(root, "raw"), join(root, "wiki"));
      const probe = join(root, "wiki", "only-raw.md");
      if (nativeVaultIo) {
        under(reg, () => {
          expect(noteExists(probe).exists).toBe(false);
          expect(statNote(probe)).toBeNull();
          expect(noteExists(join(root, "wiki", "x.md")).exists).toBe(true);
        });
      } else {
        expect(() => under(reg, () => noteExists(probe))).toThrow(WHY);
        expect(() => under(reg, () => statNote(probe))).toThrow(WHY);
        expect(() => under(reg, () => noteExists(join(root, "open", "x.md")))).toThrow(WHY);
      }
    });

    it("outside a pinned folder both behave as before, pinned or not", () => {
      const root = openAndRawVault();
      writeFileSync(join(root, "plain.md"), "plain\n");
      const reg = wikiRegistry(root);
      under(reg, () => {
        expect(noteExists(join(root, "plain.md"))).toEqual({ exists: true, type: "file" });
        expect(noteExists(join(root, "raw"))).toEqual({ exists: true, type: "folder" });
        expect(noteExists(join(root, "nope.md")).exists).toBe(false);
        expect(statNote(join(root, "plain.md"))?.size).toBe(6);
        expect(statNote(join(root, "nope.md"))).toBeNull();
      });
    });
  },
);

// An older .node has no safeUnlink and would ignore a pin: the canonical spelling must refuse too.
describe.skipIf(process.platform === "win32" || !nativeVaultIo)(
  "an addon that predates safeUnlink, canonical spelling",
  () => {
    it("refuses a delete through the pinned directory by either name", async () => {
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
        links.withFolderPins(reg.folderPins, () => {
          expect(() => io.hardDelete(join(root, "open", "x.md"))).toThrow(WHY);
          expect(() => io.hardDelete(join(root, "wiki", "x.md"))).toThrow(WHY);
        });
        swapInRaw(root);
        links.withFolderPins(reg.folderPins, () => {
          expect(() => io.hardDelete(join(root, "open", "x.md"))).toThrow(WHY);
        });
        expectSwapUntouched(root);
      } finally {
        mod.safeUnlink = real;
        vi.resetModules();
      }
    });
  },
);
