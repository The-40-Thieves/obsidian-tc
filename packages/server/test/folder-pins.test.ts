// A configured symlinked folder (`wiki -> pages`) is pinned ONCE, when the registry is built, and
// both the ACL and the native open use that pin: the ACL refuses a path whose live symlink no longer
// agrees with it, and the native open takes the pinned directory without reading the symlink again.
// So a retarget between the ACL decision and the I/O cannot make the two name different files.
//
// The seam: notes-io's `readNote` and `trashNote` are the handlers' I/O calls, made after every ACL
// stage (central + handler) has passed. The mock below runs a one-shot hook right before each, so a
// test flips the symlink exactly between the decision and the I/O, with no timing involved.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { pinnedFolderPath, replaceFolderPins } from "../src/vault/folder-links";
import { moveNoReplace, nativeVaultIo, readNote } from "../src/vault/notes-io";
import { resolveVaultPathChecked } from "../src/vault/paths";
import { VaultRegistry } from "../src/vault/registry";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const seam = vi.hoisted(() => ({
  beforeRead: null as null | (() => void),
  beforeTrash: null as null | (() => void),
}));
const fire = (key: "beforeRead" | "beforeTrash"): void => {
  const hook = seam[key];
  seam[key] = null;
  hook?.();
};
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...real,
    readNote: (abs: string) => {
      fire("beforeRead");
      return real.readNote(abs);
    },
    trashNote: (root: string, rel: string) => {
      fire("beforeTrash");
      return real.trashNote(root, rel);
    },
  };
});

const LOG = "# Log\n\n2026-01-01T00:00:00Z | create | wiki/Ada.md | alice-the-principal | m\n";
const NOTES_ONLY = { grantedScopes: new Set(["read:notes"]) };

/** Point the vault's `wiki` symlink at `target` (vault-relative). */
const retarget = (root: string, target: string): void => {
  unlinkSync(join(root, "wiki"));
  symlinkSync(join(root, target), join(root, "wiki"));
};

let v: TestVault | undefined;
const temps: string[] = [];
afterEach(() => {
  seam.beforeRead = null;
  seam.beforeTrash = null;
  v?.cleanup();
  v = undefined;
  for (const t of temps.splice(0)) rmTemp(t);
});

describe.skipIf(process.platform === "win32")(
  "a retargeted wiki symlink never splits ACL and I/O",
  () => {
    const wikiVault = (target: string, files: Record<string, string>): TestVault =>
      (v = makeTestVault({
        files,
        wikiFolder: "wiki",
        centralAcl: true,
        setup: (root) => symlinkSync(join(root, target), join(root, "wiki")),
      }));

    it("read: wiki -> scratch for the ACL, back to pages before the read, never returns pages/log.md", async () => {
      const t = wikiVault("pages", { "pages/log.md": LOG, "scratch/log.md": "a scratch log\n" });
      retarget(t.root, "scratch");
      seam.beforeRead = () => retarget(t.root, "pages");
      const r = await t.call("read_note", { vault: "test", path: "wiki/log.md" }, NOTES_ONLY);
      expect(JSON.stringify(r)).not.toContain("alice-the-principal");
      expect(r.ok).toBe(false);
    });

    it("trash: wiki -> open for the ACL, -> raw before the move, leaves the immutable raw/x.md alone", async () => {
      const t = wikiVault("open", { "open/x.md": "open note\n", "raw/x.md": "RAW SOURCE\n" });
      const input = { vault: "test", path: "wiki/x.md" };
      // delete_note is confirmed first (the dispatcher refuses it before the handler runs).
      const need = await t.call("delete_note", input);
      expect(need.ok).toBe(false);
      if (need.ok) return;
      const argsHash = String((need.error.details as { args_hash?: string }).args_hash);
      const token = issueElicitToken(t.db, {
        vaultId: t.id,
        toolName: "delete_note",
        argsHash,
        caller: "test",
      });
      seam.beforeTrash = () => retarget(t.root, "raw");
      await t.call("delete_note", input, { elicitToken: token });
      expect(readFileSync(join(t.root, "raw", "x.md"), "utf8")).toBe("RAW SOURCE\n");
      // With the native open the pinned directory is what moved; the JS fallback refuses a symlinked
      // component in a move outright, so there nothing moved at all.
      if (nativeVaultIo) expect(existsSync(join(t.root, "open", "x.md"))).toBe(false);
    });

    it("retarget, then request: the ACL refuses a path whose symlink no longer matches its pin", async () => {
      const t = wikiVault("pages", { "pages/log.md": LOG, "scratch/log.md": "a scratch log\n" });
      retarget(t.root, "scratch");
      const r = await t.call("read_note", { vault: "test", path: "wiki/log.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("acl_denied");
      expect(JSON.stringify(r)).not.toContain("a scratch log");
    });
  },
);

/** A fresh vault holding pages/a.md and open/x.md + raw/x.md, with `wiki -> <target>`. */
function plainVault(target: string): string {
  const base = makeTempDir("obtc-folder-pins-");
  temps.push(base);
  const root = join(base, "vault");
  for (const d of ["pages", "scratch", "open", "raw"])
    mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "pages", "a.md"), "page A\n");
  writeFileSync(join(root, "scratch", "a.md"), "scratch A\n");
  writeFileSync(join(root, "open", "x.md"), "open note\n");
  writeFileSync(join(root, "raw", "x.md"), "RAW SOURCE\n");
  symlinkSync(join(root, target), join(root, "wiki"));
  return root;
}

describe.skipIf(process.platform === "win32" || !nativeVaultIo)(
  "the native sink takes the pin, never the live symlink",
  () => {
    it("a read after a retarget still opens the pinned directory", () => {
      const root = plainVault("pages");
      new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
      retarget(root, "scratch");
      expect(readNote(join(root, "wiki", "a.md")).raw).toBe("page A\n");
    });

    it("a move after a retarget moves the pinned file, not the retargeted one", () => {
      const root = plainVault("open");
      new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
      retarget(root, "raw");
      moveNoReplace(join(root, "wiki", "x.md"), join(root, "moved.md"));
      expect(readFileSync(join(root, "moved.md"), "utf8")).toBe("open note\n");
      expect(readFileSync(join(root, "raw", "x.md"), "utf8")).toBe("RAW SOURCE\n");
    });

    it("a registry rebuilt without the wiki config takes the pin away", () => {
      const root = plainVault("pages");
      new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
      expect(readNote(join(root, "wiki", "a.md")).raw).toBe("page A\n");
      new VaultRegistry([{ id: "v", path: root }]);
      expect(() => readNote(join(root, "wiki", "a.md"))).toThrow(/safe open refused/);
    });

    // Vault A at /v, vault B at /v/inner. B's `wiki` leads out of B (into A), so B pins nothing;
    // A's `inner/wiki` is inside A and pinned. The result must not depend on registration order.
    it("nested roots resolve the same way whatever order the vaults are registered in", () => {
      for (const order of ["inner-first", "outer-first"] as const) {
        const base = makeTempDir("obtc-folder-pins-nested-");
        temps.push(base);
        const a = join(base, "v");
        const b = join(a, "inner");
        mkdirSync(join(a, "pagesA"), { recursive: true });
        mkdirSync(b);
        writeFileSync(join(a, "pagesA", "x.md"), "A's page\n");
        symlinkSync(join(a, "pagesA"), join(b, "wiki"));
        const va = { id: "a", path: a, wiki: { folder: "inner/wiki" } };
        const vb = { id: "b", path: b, wiki: { folder: "wiki" } };
        new VaultRegistry(order === "inner-first" ? [vb, va] : [va, vb]);
        expect(readNote(join(a, "inner", "wiki", "x.md")).raw, order).toBe("A's page\n");
      }
    });
  },
);

describe.skipIf(process.platform === "win32")("the pin table", () => {
  it("two vault ids on one root with different wiki folders are refused at load", () => {
    const root = plainVault("pages");
    const alias = join(root, "..", "alias");
    symlinkSync(root, alias);
    expect(
      () =>
        new VaultRegistry([
          { id: "a", path: root, wiki: { folder: "wiki" } },
          { id: "b", path: root },
        ]),
    ).toThrow(/share the vault root/);
    // the same root reached by another spelling is the same root
    expect(
      () =>
        new VaultRegistry([
          { id: "a", path: root, wiki: { folder: "wiki" } },
          { id: "b", path: alias, wiki: { folder: "wiki", rawFolder: "scratch" } },
        ]),
    ).toThrow(/share the vault root/);
    // identical wiki configuration on a shared root is unambiguous, and so is none at all
    expect(
      () =>
        new VaultRegistry([
          { id: "a", path: root, wiki: { folder: "wiki" } },
          { id: "b", path: alias, wiki: { folder: "wiki" } },
        ]),
    ).not.toThrow();
    expect(
      () =>
        new VaultRegistry([
          { id: "a", path: root },
          { id: "b", path: root },
        ]),
    ).not.toThrow();
    // a vault added at runtime has no wiki config, so it cannot share a wiki vault's root either
    const reg = new VaultRegistry([{ id: "a", path: root, wiki: { folder: "wiki" } }]);
    expect(() => reg.register({ id: "b", path: alias })).toThrow(/share the vault root/);
  });

  it("a root missing at build is pinned by its first resolution through the folder, once", () => {
    const base = makeTempDir("obtc-folder-pins-late-");
    temps.push(base);
    const root = join(base, "vault");
    new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
    for (const d of ["pages", "scratch"]) mkdirSync(join(root, d), { recursive: true });
    symlinkSync(join(root, "pages"), join(root, "wiki"));
    expect(pinnedFolderPath(join(root, "wiki", "a.md"))).toBe(join(root, "wiki", "a.md"));
    expect(resolveVaultPathChecked(root, "wiki/a.md").aclRel).toBe("pages/a.md");
    expect(pinnedFolderPath(join(root, "wiki", "a.md"))).toBe(join(root, "pages", "a.md"));
    retarget(root, "scratch");
    expect(() => resolveVaultPathChecked(root, "wiki/a.md")).toThrow(/no longer leads/);
  });

  it("the more specific root's pin wins, in either table order", () => {
    const outer = { root: "/v", alias: "/v/inner/wiki", target: "/v/outer-pages" };
    const inner = { root: "/v/inner", alias: "/v/inner/wiki", target: "/v/inner/pages" };
    for (const table of [
      [outer, inner],
      [inner, outer],
    ]) {
      replaceFolderPins(table);
      expect(pinnedFolderPath("/v/inner/wiki/x.md")).toBe("/v/inner/pages/x.md");
      expect(pinnedFolderPath("/v/inner/wikipedia/x.md")).toBe("/v/inner/wikipedia/x.md");
    }
    replaceFolderPins([]);
    expect(pinnedFolderPath("/v/inner/wiki/x.md")).toBe("/v/inner/wiki/x.md");
  });
});
