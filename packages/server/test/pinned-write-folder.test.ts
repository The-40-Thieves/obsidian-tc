// A configured folder that is a symlink (`wiki -> open`) is reached through its pin
// (vault/folder-links.ts). A write must follow the pin the way a read and a delete do: a write into
// the wiki folder lands in the folder it points at, and a write named by the target's own spelling
// is refused once that folder has been swapped for another directory after the ACL decision.
// Native-only: each test asserts the addon is loaded, so a silent JS fallback cannot pass.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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

describe.skipIf(process.platform === "win32")("writes into a symlinked wiki folder", () => {
  it("write_note wiki/new.md succeeds and lands in the folder the wiki symlink points at", async () => {
    v = makeTestVault({
      files: { "open/x.md": OPEN },
      wikiFolder: "wiki",
      setup: (root) => symlinkSync(join(root, "open"), join(root, "wiki")),
    });
    expect(nativeVaultIo).toBe(true);
    const r = await v.call("write_note", { vault: "test", path: "wiki/new.md", content: "new\n" });
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
      page: { path: "wiki/Topic.md", frontmatter: { type: "concept" }, body: "# Topic\n\nBody.\n" },
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
        writeNoteAtomic(join(root, "open", "planted.md"), "planted\n", false, { exclusive: true }),
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
      const reg2 = new registry.VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
      links.withFolderPins(reg2.folderPins, () => {
        expect(() => io.writeNoteAtomic(x, "older\n", false)).toThrow(WHY);
      });
      expect(text(root, "open/x.md")).toBe("new\n");
    } finally {
      mod.SAFE_IO_PINNED_WRITE = real;
      vi.resetModules();
    }
  });
});
