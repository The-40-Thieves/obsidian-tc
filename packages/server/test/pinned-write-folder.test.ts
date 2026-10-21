// A configured folder that is a symlink (`wiki -> open`) is reached through its pin
// (vault/folder-links.ts). A write must follow the pin the way a read and a delete do: a write into
// the wiki folder lands in the folder it points at, and a write named by the target's own spelling
// is refused once that folder has been swapped for another directory after the ACL decision.
// Native-only: each test asserts the addon is loaded, so a silent JS fallback cannot pass.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { withFolderPins } from "../src/vault/folder-links";
import { nativeVaultIo, writeNoteAtomic } from "../src/vault/notes-io";
import { VaultRegistry } from "../src/vault/registry";
import { applyWriteBatch } from "../src/vault/write-batch";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const seam = vi.hoisted(() => ({ beforeWrite: null as null | (() => void) }));
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...real,
    writeNoteAtomic: (...a: Parameters<typeof real.writeNoteAtomic>) => {
      const hook = seam.beforeWrite;
      seam.beforeWrite = null;
      hook?.();
      return real.writeNoteAtomic(...a);
    },
  };
});

const WHY = /configured symlinked folders require the native module/;
const RAW = "RAW SOURCE\n";
const OPEN = "open note\n";
const SCHEMA = "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n";

const temps: string[] = [];
let v: TestVault | undefined;
let h: WikiHarness | undefined;
afterEach(() => {
  seam.beforeWrite = null;
  v?.cleanup();
  v = undefined;
  h?.v.cleanup();
  h = undefined;
  for (const t of temps.splice(0)) rmTemp(t);
});

const text = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** A write that replaces a note asks for an elicit token first; this is the probe pattern from
 *  pinned-canonical-spelling.test.ts. */
async function confirmed(t: TestVault, tool: string, input: Record<string, unknown>) {
  const need = await t.call(tool, input);
  if (need.ok || need.error.code !== "elicit_required") return need;
  const argsHash = String((need.error.details as { args_hash?: string }).args_hash);
  const elicitToken = issueElicitToken(t.db, {
    vaultId: t.id,
    toolName: tool,
    argsHash,
    caller: "test",
  });
  return t.call(tool, input, { elicitToken });
}
const under = <T>(reg: VaultRegistry, fn: () => T): T => withFolderPins(reg.folderPins, fn);
/** The error code `fn` throws, or "none". */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return String((e as { code?: string }).code);
  }
  return "none";
};

/** `open` holds a note; the immutable `raw` holds the source that must never change. `wiki -> open`. */
function openAndRawVault(): string {
  const base = makeTempDir("obtc-pinned-write-");
  temps.push(base);
  const root = join(base, "vault");
  for (const d of ["open", "raw"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "open", "x.md"), OPEN);
  writeFileSync(join(root, "raw", "x.md"), RAW);
  symlinkSync(join(root, "open"), join(root, "wiki"));
  return root;
}
const wikiRegistry = (root: string): VaultRegistry =>
  new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);

/** After the ACL decision: `open` moves aside and the immutable `raw` takes its name. */
const swapInRaw = (root: string): void => {
  renameSync(join(root, "open"), join(root, "open-gone"));
  renameSync(join(root, "raw"), join(root, "open"));
};

describe.skipIf(process.platform === "win32" || !nativeVaultIo)(
  "writes into a symlinked wiki folder",
  () => {
    it("write_note wiki/new.md succeeds and lands in the folder the wiki symlink points at", async () => {
      v = makeTestVault({
        files: { "open/x.md": OPEN },
        wikiFolder: "wiki",
        setup: (root) => symlinkSync(join(root, "open"), join(root, "wiki")),
      });
      expect(nativeVaultIo).toBe(true);
      const r = await v.call("write_note", {
        vault: "test",
        path: "wiki/new.md",
        content: "new\n",
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(text(v.root, "open/new.md")).toBe("new\n");
    });

    it("commit_wiki_page of wiki/Topic.md succeeds and lands in the folder the wiki symlink points at", async () => {
      h = makeWikiHarness({
        files: { "pages/SCHEMA.md": SCHEMA, "pages/Page.md": "# Page\n\nBody.\n" },
        wikiFolder: "wiki",
        vectors: { Topic: [1, 0, 0, 0] },
        setup: (root) => symlinkSync(join(root, "pages"), join(root, "wiki")),
      });
      expect(nativeVaultIo).toBe(true);
      const r = await h.v.call("commit_wiki_page", {
        vault: "test",
        topic: "Topic",
        type: "concept",
        page: {
          path: "wiki/Topic.md",
          frontmatter: { type: "concept" },
          body: "# Topic\n\nBody.\n",
        },
        patches: [],
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(existsSync(join(h.v.root, "pages", "Topic.md"))).toBe(true);
    });

    it("a sink write and an exclusive create through the wiki alias land in the pinned folder", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      expect(nativeVaultIo).toBe(true);
      under(reg, () => {
        writeNoteAtomic(join(root, "wiki", "n.md"), "new\n", false);
        writeNoteAtomic(join(root, "wiki", "planted.md"), "fresh\n", false, { exclusive: true });
      });
      expect(text(root, "open/n.md")).toBe("new\n");
      expect(text(root, "open/planted.md")).toBe("fresh\n");
      expect(text(root, "raw/x.md")).toBe(RAW);
    });

    it("after the swap, a write by the canonical spelling is refused and both directories are untouched", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      expect(nativeVaultIo).toBe(true);
      swapInRaw(root);
      under(reg, () => {
        expect(() => writeNoteAtomic(join(root, "open", "x.md"), "OVERWRITE\n", false)).toThrow();
        expect(() =>
          writeNoteAtomic(join(root, "open", "planted.md"), "planted\n", false, {
            exclusive: true,
          }),
        ).toThrow();
      });
      expect(text(root, "open/x.md")).toBe(RAW);
      expect(text(root, "open-gone/x.md")).toBe(OPEN);
      expect(existsSync(join(root, "open", "planted.md"))).toBe(false);
      expect(existsSync(join(root, "open-gone", "planted.md"))).toBe(false);
    });

    it("a hook that swaps the folder before write_note open/x.md leaves the raw file intact", async () => {
      v = makeTestVault({
        files: { "open/x.md": OPEN, "raw/x.md": RAW },
        wikiFolder: "wiki",
        centralAcl: true,
        setup: (root) => symlinkSync(join(root, "open"), join(root, "wiki")),
      });
      expect(nativeVaultIo).toBe(true);
      const root = v.root;
      let hookRan = false;
      seam.beforeWrite = () => {
        hookRan = true;
        swapInRaw(root);
      };
      const r = await confirmed(v, "write_note", {
        vault: "test",
        path: "open/x.md",
        content: "OVERWRITTEN\n",
        mode: "overwrite",
      });
      expect(hookRan).toBe(true);
      expect(r.ok, JSON.stringify(r)).toBe(false);
      expect(text(root, "open/x.md")).toBe(RAW);
    });

    it("an addon without the write-pin capability refuses a write through a pin, not silently unpinned", async () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      expect(nativeVaultIo).toBe(true);
      const x = join(root, "wiki", "x.md");
      // The addon that verifies a pin on writes: the write lands in the pinned folder.
      under(reg, () => writeNoteAtomic(x, "new\n", false));
      expect(text(root, "open/x.md")).toBe("new\n");

      const mod = createRequire(import.meta.url)("@the-40-thieves/obsidian-tc-native") as Record<
        string,
        unknown
      >;
      const real = mod.SAFE_IO_PINNED_WRITE;
      mod.SAFE_IO_PINNED_WRITE = undefined;
      try {
        vi.resetModules();
        const io =
          await vi.importActual<typeof import("../src/vault/notes-io")>("../src/vault/notes-io");
        const links = await import("../src/vault/folder-links");
        const registry = await import("../src/vault/registry");
        const reg2 = new registry.VaultRegistry([
          { id: "v", path: root, wiki: { folder: "wiki" } },
        ]);
        links.withFolderPins(reg2.folderPins, () => {
          expect(() => io.writeNoteAtomic(x, "older\n", false)).toThrow(WHY);
          // Refused when staged, not only at commit.
          expect(() => io.stageNoteWrite(x, "older\n", false)).toThrow(WHY);
        });
        expect(text(root, "open/x.md")).toBe("new\n");
      } finally {
        mod.SAFE_IO_PINNED_WRITE = real;
        vi.resetModules();
      }
    });

    it("a write that creates folders under a pin is refused by an addon without that capability", async () => {
      const root = openAndRawVault();
      const x = join(root, "wiki", "a", "b", "n.md");
      const mod = createRequire(import.meta.url)("@the-40-thieves/obsidian-tc-native") as Record<
        string,
        unknown
      >;
      const real = mod.SAFE_IO_PINNED_MKDIR;
      mod.SAFE_IO_PINNED_MKDIR = undefined;
      try {
        vi.resetModules();
        const io =
          await vi.importActual<typeof import("../src/vault/notes-io")>("../src/vault/notes-io");
        const links = await import("../src/vault/folder-links");
        const registry = await import("../src/vault/registry");
        const reg2 = new registry.VaultRegistry([
          { id: "v", path: root, wiki: { folder: "wiki" } },
        ]);
        links.withFolderPins(reg2.folderPins, () => {
          expect(() => io.writeNoteAtomic(x, "older\n", true)).toThrow();
          expect(existsSync(join(root, "open", "a"))).toBe(false);
          // A write that makes no folder is unaffected by the missing capability.
          io.writeNoteAtomic(join(root, "wiki", "x.md"), "newer\n", false);
        });
      } finally {
        mod.SAFE_IO_PINNED_MKDIR = real;
        vi.resetModules();
      }
      expect(text(root, "open/x.md")).toBe("newer\n");
    });

    it("a nested write after the swap creates no directory in the swapped-in folder", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      swapInRaw(root);
      under(reg, () => {
        expect(() =>
          writeNoteAtomic(join(root, "open", "newsub", "deep", "p.md"), "planted\n", true),
        ).toThrow();
        expect(() =>
          writeNoteAtomic(join(root, "wiki", "sub2", "p.md"), "planted\n", true),
        ).toThrow();
      });
      expect(readdirSync(join(root, "open"))).toEqual(["x.md"]);
      expect(existsSync(join(root, "open-gone", "sub2"))).toBe(false);
    });

    it("a nested write through the alias still creates its folders under the pin", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      under(reg, () => writeNoteAtomic(join(root, "wiki", "a", "b", "n.md"), "deep\n", true));
      expect(text(root, "open/a/b/n.md")).toBe("deep\n");
      expect(text(root, "raw/x.md")).toBe(RAW);
    });

    it("a pinned folder moved away is not re-created by a write that creates folders", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      renameSync(join(root, "open"), join(root, "open-gone"));
      under(reg, () =>
        expect(() => writeNoteAtomic(join(root, "wiki", "p.md"), "x\n", true)).toThrow(),
      );
      expect(existsSync(join(root, "open"))).toBe(false);
    });

    it("with createDirs false on a missing pinned folder the refusal is acl_denied, not ENOENT", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      renameSync(join(root, "open"), join(root, "open-gone"));
      const code = under(reg, () =>
        codeOf(() => writeNoteAtomic(join(root, "wiki", "x.md"), "x\n", false)),
      );
      expect(code).toBe("acl_denied");
    });

    it("a batch that fails leaves no folder it made under the pin", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      expect(() =>
        under(reg, () =>
          applyWriteBatch([
            {
              abs: join(root, "wiki", "newdir", "a.md"),
              rel: "wiki/newdir/a.md",
              content: "a\n",
              prevRaw: null,
            },
            // planned from stale bytes: the commit's compare-and-swap throws
            {
              abs: join(root, "wiki", "x.md"),
              rel: "wiki/x.md",
              content: "y\n",
              prevRaw: "stale\n",
            },
          ]),
        ),
      ).toThrow();
      expect(existsSync(join(root, "open", "newdir"))).toBe(false);
      expect(text(root, "open/x.md")).toBe(OPEN);
    });

    it("after a retarget, a name the platform refuses is refused through the pin", () => {
      const root = openAndRawVault();
      const reg = wikiRegistry(root);
      const other = join(root, "elsewhere");
      mkdirSync(other);
      writeFileSync(join(other, "a:b.md"), "other\n");
      rmSync(join(root, "wiki"));
      symlinkSync(other, join(root, "wiki"));
      under(reg, () =>
        expect(() => writeNoteAtomic(join(root, "wiki", "a:b.md"), "planted\n", false)).toThrow(),
      );
      expect(existsSync(join(root, "open", "a:b.md"))).toBe(false);
      expect(text(root, "elsewhere/a:b.md")).toBe("other\n");
    });
  },
);
