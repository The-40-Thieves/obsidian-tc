// A changed ACL identity is promoted only with the content read from it. The walk demotes a name whose
// stored identity differs from its walk identity (UNRESOLVED) before anything reads it; this file pins
// the other half: the new identity lands on a stored row only once that row holds content read from
// the new identity in this pass and committed. A note the pass never read (unreadable to it), or whose
// replacement chunks never committed (an embedding outage, a quarantined embed, a cancelled pass), keeps
// its old content UNRESOLVED, never labeled with the new identity.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { ensureAclPathSet } from "../src/search/acl_path_set";
import { readGeneration } from "../src/search/generation";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import type { AclPath } from "../src/vault/acl-identity";
import { readableStoredRow } from "../src/vault/stored-acl-path";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v";
const OLD = "# Old\n\nOLD_SENTINEL private bytes\n";
const NEW = "# New\n\nNEW_CONTENT public bytes\n";
const OLD_IDENTITY = "old/private.md";
const base = fakeEmbeddingProvider({ dimensions: 32 });
const representation = buildRepresentationManifest(base, {});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** The embed fault for the next pass: undefined means the real (fake) embedding. */
let embedFault: (() => Error) | undefined;
const provider: EmbeddingProvider = {
  ...base,
  embed: (texts, opts) => {
    const fail = embedFault?.();
    return fail ? Promise.reject(fail) : base.embed(texts, opts);
  },
};
afterEach(() => {
  embedFault = undefined;
});

interface PassOpts {
  streaming: boolean;
  isReadable?: (aclRel: AclPath) => boolean;
  signal?: AbortSignal;
  onNotesPass?: () => void;
}

function index(db: Database, root: string, o: PassOpts): ReturnType<typeof indexVault> {
  return indexVault({
    db,
    provider,
    representation,
    vaultId: VAULT,
    root,
    isReadable: o.isReadable ?? (() => true),
    walk: { streaming: o.streaming },
    signal: o.signal,
    onNotesPass: o.onNotesPass,
  });
}

/** a.md indexed with OLD content, then stored under a DIFFERENT identity than this walk resolves:
 *  the shape a re-pointed symlink leaves (the walk now names `a.md`, the rows still name the old file). */
async function seedChangedIdentity(streaming: boolean): Promise<{ root: string; db: Database }> {
  const root = makeTempDir("obtc-identity-promotion-");
  cleanups.push(() => rmTemp(root));
  write(root, "a.md", OLD);
  write(root, "top.md", "# Top\n\nzebra top\n");
  const db = openMemoryDb();
  provisionCacheDb(db);
  await index(db, root, { streaming });
  for (const table of ["chunks", "notes"])
    db.prepare(`UPDATE ${table} SET acl_path = ? WHERE path = ?`).run(OLD_IDENTITY, "a.md");
  return { root, db };
}

const chunkRows = (db: Database): Array<{ acl_path: string | null; content: string }> =>
  db.prepare("SELECT acl_path, content FROM chunks WHERE path = ?").all("a.md") as Array<{
    acl_path: string | null;
    content: string;
  }>;

/** The OLD content must never carry the new identity, and the name must be readable to nobody. */
function expectOldContentUnresolved(db: Database): void {
  const oldUnderNew = chunkRows(db).filter(
    (r) => r.content.includes("OLD_SENTINEL") && r.acl_path === "a.md",
  );
  expect(oldUnderNew).toEqual([]);
  expect(readableStoredRow(db, VAULT, () => true)("a.md")).toBe(false);
}

describe.each([false, true])(
  "a changed identity is promoted only with content read from it (streaming walk: %s)",
  (streaming) => {
    it("A: a changed note this pass cannot read keeps its old content unresolved", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      write(root, "a.md", NEW);
      await index(db, root, { streaming, isReadable: (rel) => rel !== "a.md" });
      expect(chunkRows(db).map((r) => r.acl_path)).toEqual([""]);
      expect(chunkRows(db)[0]?.content).toContain("OLD_SENTINEL");
      expectOldContentUnresolved(db);
    });

    it("B: an embedding outage in the final flush leaves no old chunk under the new identity", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      write(root, "a.md", NEW);
      embedFault = () => new Error("embedding outage");
      await expect(index(db, root, { streaming })).rejects.toThrow("embedding outage");
      expectOldContentUnresolved(db);
    });

    it("B: a pass cancelled before the final flush leaves no old chunk under the new identity", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      write(root, "a.md", NEW);
      const ac = new AbortController();
      await index(db, root, { streaming, signal: ac.signal, onNotesPass: () => ac.abort() });
      expectOldContentUnresolved(db);
    });

    it("B: a quarantined embed (provider rejects the note) leaves its old chunks unresolved", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      write(root, "a.md", NEW);
      embedFault = () => err.embeddingProviderError("context exceeded", { status: 400 });
      const stats = await index(db, root, { streaming });
      expect(stats.notes_embed_failed).toBe(1);
      expectOldContentUnresolved(db);
    });

    it("a changed note read and committed this pass is promoted, and a failed pass self-heals", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      write(root, "a.md", NEW);
      embedFault = () => new Error("embedding outage");
      await expect(index(db, root, { streaming })).rejects.toThrow("embedding outage");
      embedFault = undefined;
      await index(db, root, { streaming });
      const rows = chunkRows(db);
      expect(rows.map((r) => r.acl_path)).toEqual(["a.md"]);
      expect(rows[0]?.content).toContain("NEW_CONTENT");
      expect(readableStoredRow(db, VAULT, () => true)("a.md")).toBe(true);
    });

    it("a changed note whose content is unchanged is promoted once read", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      await index(db, root, { streaming });
      expect(chunkRows(db).map((r) => r.acl_path)).toEqual(["a.md"]);
      const notes = db.prepare("SELECT acl_path FROM notes WHERE path = ?").get("a.md");
      expect(notes).toEqual({ acl_path: "a.md" });
      expect(readableStoredRow(db, VAULT, () => true)("a.md")).toBe(true);
    });

    it("a permitted-path set built while a name is demoted is rebuilt once its notes row is promoted", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      write(root, "a.md", "---\ntitle: one\n---\n"); // frontmatter only: a notes row, no chunks
      await index(db, root, { streaming });
      db.prepare("UPDATE notes SET acl_path = ? WHERE path = ?").run(OLD_IDENTITY, "a.md");
      await index(db, root, { streaming, isReadable: (rel) => rel !== "a.md" }); // demoted, unread
      expect(chunkRows(db)).toEqual([]);
      const members = (): string[] => {
        const setId = ensureAclPathSet(db, {
          vaultId: VAULT,
          aclFingerprint: "caller",
          exclusionDigest: "",
          generation: readGeneration(db, VAULT),
          allPaths: () => ["a.md", "top.md"],
          isStoredPathReadable: readableStoredRow(db, VAULT, () => true),
          nowMs: 0,
        });
        return (
          db
            .prepare("SELECT path FROM acl_path_members WHERE set_id = ? ORDER BY path")
            .all(setId) as Array<{
            path: string;
          }>
        ).map((r) => r.path);
      };
      expect(members()).toEqual(["top.md"]);
      write(root, "a.md", "---\ntitle: two\n---\n"); // only the notes row is rewritten (flushNotes)
      await index(db, root, { streaming });
      expect(members()).toEqual(["a.md", "top.md"]);
    });

    it("an unchanged vault re-indexes with no identity write and no generation bump", async () => {
      const { root, db } = await seedChangedIdentity(streaming);
      await index(db, root, { streaming });
      const before = readGeneration(db, VAULT);
      await index(db, root, { streaming });
      expect(readGeneration(db, VAULT)).toBe(before);
    });
  },
);
