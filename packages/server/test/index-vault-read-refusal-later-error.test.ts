// A refused read is persisted the moment it is recorded, so a later error in the same pass cannot
// leave that note's stored identity resolved. Only acl_denied is swallowed: every other read error
// still fails the pass. A separate file: the readNote mock below must not reach other test modules.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { readableByFolder } from "../src/vault/acl-read-filter";
import { readableStoredRow } from "../src/vault/stored-acl-path";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

// The fault for a readNote call: undefined means the real read.
const fault = vi.hoisted(() => ({
  next: undefined as ((abs: string) => Error | undefined) | undefined,
}));

vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    readNote: (abs: string) => {
      const fail = fault.next?.(abs);
      if (fail) throw fail;
      return actual.readNote(abs);
    },
  };
});

const VAULT = "v";
const provider = fakeEmbeddingProvider({ dimensions: 32 });
const representation = buildRepresentationManifest(provider, {});
const OPEN_ACL = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });

const cleanups: Array<() => void> = [];
afterEach(() => {
  fault.next = undefined;
  for (const c of cleanups.splice(0)) c();
});

/** pages/a.md, pages/z.md and top.md: the walk reads them in this order. */
function makeRoot(): string {
  const root = makeTempDir("obtc-read-refusal-later-");
  cleanups.push(() => rmTemp(root));
  for (const rel of ["pages/a.md", "pages/z.md", "top.md"]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), `# ${rel}\n\nzebra ${rel}\n`);
  }
  return root;
}

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function index(db: Database, root: string, streaming: boolean): ReturnType<typeof indexVault> {
  return indexVault({
    db,
    provider,
    representation,
    vaultId: VAULT,
    root,
    isReadable: (rel) => readableByFolder(OPEN_ACL, rel),
    walk: { streaming },
  });
}

const storedIdentities = (db: Database, rel: string): Array<string | null> =>
  (
    db.prepare("SELECT DISTINCT acl_path FROM chunks WHERE path = ?").all(rel) as Array<{
      acl_path: string | null;
    }>
  ).map((r) => r.acl_path);

const enoent = (): Error => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

describe.each([false, true])(
  "a refusal is persisted before a later error can end the pass (streaming walk: %s)",
  (streaming) => {
    it("a refused note stays unresolved when a later note's read throws ENOENT", async () => {
      const root = makeRoot();
      const db = freshDb();
      await index(db, root, streaming);
      expect(storedIdentities(db, "pages/a.md")).toEqual(["pages/a.md"]);

      fault.next = (abs) => {
        if (abs.endsWith("/a.md"))
          return err.aclDenied("safe open refused the path: test", { path: abs });
        if (abs.endsWith("/z.md")) return enoent();
        return undefined;
      };
      await expect(index(db, root, streaming)).rejects.toMatchObject({ code: "ENOENT" });
      expect(storedIdentities(db, "pages/a.md").every((id) => id === "" || id === null)).toBe(true);
      expect(readableStoredRow(db, VAULT, () => true)("pages/a.md")).toBe(false);
    });
  },
);

describe.each([false, true])("only acl_denied is swallowed (streaming walk: %s)", (streaming) => {
  it("a path_invalid read error fails the pass", async () => {
    const root = makeRoot();
    fault.next = (abs) =>
      abs.endsWith("/a.md") ? err.pathInvalid("test: path is invalid", { path: abs }) : undefined;
    await expect(index(freshDb(), root, streaming)).rejects.toMatchObject({
      code: "path_invalid",
    });
  });

  it("an ENOENT read error fails the pass", async () => {
    const root = makeRoot();
    fault.next = (abs) => (abs.endsWith("/a.md") ? enoent() : undefined);
    await expect(index(freshDb(), root, streaming)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// A changed identity is demoted before anything reads it. The stored row names the identity the note
// had on an earlier pass; this pass's walk resolves the name to a different one (a retargeted folder
// pin does this on native I/O). The note's content changed too, so its replacement is still pending
// when a later error ends the pass: the old identity must not survive (it would keep authorizing the
// name), and the new one must not land on the old content.
describe.each([false, true])(
  "a changed identity is demoted before the pass can end early (streaming walk: %s)",
  (streaming) => {
    it("the old stored identity does not survive a later ENOENT", async () => {
      const root = makeRoot();
      const db = freshDb();
      await index(db, root, streaming);
      db.prepare("UPDATE chunks SET acl_path = ? WHERE path = ?").run("pages/old.md", "pages/a.md");
      db.prepare("UPDATE notes SET acl_path = ? WHERE path = ?").run("pages/old.md", "pages/a.md");
      writeFileSync(join(root, "pages/a.md"), "# pages/a.md\n\nzebra changed\n");

      fault.next = (abs) => (abs.endsWith("/z.md") ? enoent() : undefined);
      await expect(index(db, root, streaming)).rejects.toMatchObject({ code: "ENOENT" });
      expect(storedIdentities(db, "pages/a.md")).toEqual([""]);
      expect(readableStoredRow(db, VAULT, () => true)("pages/a.md")).toBe(false);
    });
  },
);
