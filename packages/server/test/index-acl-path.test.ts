// A stored index row is authorized on what it IS (`acl_path`), not on the name it was walked under.
//
// The index keys a note by its walked name. Through `wiki -> private` that name is an alias, and
// every DB-backed result (semantic, FTS, the notes-table tag/frontmatter legs, the GraphRAG
// permitted-path set) authorized the alias lexically: a caller whose ACL admits `wiki/**` was
// handed a note the same ACL refuses to read (read_note wiki/x.md resolves to private/x.md). The
// mirror failure: with `shared -> pages` and only `pages/**` readable, the note is readable yet the
// row (`shared/...`) was rejected. Each surface below has both a LEAK case and a FAIL-CLOSED-BUG case,
// plus the migration that marks pre-existing rows unresolved until a pass resolves them.
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS, provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { allChunkPaths, ensureAclPathSet } from "../src/search/acl_path_set";
import { readGeneration } from "../src/search/generation";
import { indexNote, indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM7Tools } from "../src/tools/m7";
import { readableByFolder, readableRel } from "../src/vault/acl-read-filter";
import { nativeVaultIo } from "../src/vault/notes-io";
import { VaultRegistry } from "../src/vault/registry";
import { readableStoredRow, storedAclPathOf } from "../src/vault/stored-acl-path";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

// With the native addon a safe open refuses any path through a symlinked folder, so a pass cannot
// read (and so cannot index) a note under an alias: the cases that index through one run on the JS
// fallback only. Every other case here, hard links included, runs on both.
const VAULT = "v";
const SECRET_PATH = "private/secret-project.md";
const OPEN_PATH = "pages/open-note.md";
const MARK = "TOPSECRETMARK";
const FILES: Record<string, string> = {
  [SECRET_PATH]: `---\ntags: [leaktag]\nkind: secret\n---\n# Secret\n\nzebra ${MARK} confidential\n`,
  [OPEN_PATH]: "---\ntags: [opentag]\nkind: open\n---\n# Open\n\nzebra open note body\n",
};
const SCOPES = new Set(["read:notes", "read:docs", "read:vault"]);
const cfg = (over: Partial<AclConfigT>): FolderAcl =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });

/** Indexed under `wiki/...`, by a caller who can read the TARGET `private/`. */
const ACL_TARGET = cfg({ readPaths: ["private", "private/**"] });
/** Names the alias only; the target `private/` is outside it. */
const ACL_ALIAS = cfg({ readPaths: ["wiki", "wiki/**", "pages", "pages/**"] });
/** Reads exactly the target of `shared -> pages`, never the alias name. */
const ACL_PAGES = cfg({ readPaths: ["pages", "pages/**"] });

interface World {
  root: string;
  db: Database;
  call: (
    tool: string,
    input: Record<string, unknown>,
    acl: FolderAcl,
  ) => Promise<{ ok: boolean; data?: any; error?: { code: string } }>;
  index: (sub: string | undefined, acl: FolderAcl, db?: Database) => Promise<void>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const provider = fakeEmbeddingProvider({ dimensions: 32 });
const representation = buildRepresentationManifest(provider, {});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeRoot(): string {
  const root = makeTempDir("obtc-acl-path-");
  cleanups.push(() => rmTemp(root));
  for (const [rel, content] of Object.entries(FILES)) write(root, rel, content);
  symlinkSync(join(root, "private"), join(root, "wiki"));
  symlinkSync(join(root, "pages"), join(root, "shared"));
  return root;
}

function makeWorld(db: Database = freshDb()): World {
  const root = makeRoot();
  const vaultRegistry = new VaultRegistry([{ id: VAULT, path: root }]);
  const aclByVault = new Map<string, FolderAcl>();
  const metadataIndex = { hasFts: true, ready: () => true };
  const registry = new ToolRegistry({
    aclResolver: (id) => aclByVault.get(id),
    rootResolver: (id) => vaultRegistry.resolve(id).root,
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "0.0.0",
    startedAt: 0,
    embeddings: { provider: provider.provider, model: provider.model },
    metadataIndex,
  });
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    representation,
    metadataIndex,
  });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    acl: undefined,
    aclByVault,
  });
  return {
    root,
    db,
    call: (tool, input, acl) => {
      aclByVault.set(VAULT, acl);
      const ctx: CallerContext = {
        caller: "tester",
        authenticated: true,
        grantedScopes: SCOPES,
        vaultId: VAULT,
        db,
        acl,
      };
      return registry.dispatch(tool, { vault: VAULT, ...input }, ctx) as Promise<any>;
    },
    // Index time is the caller-independent folder whitelist, exactly as index_vault tool applies it.
    index: async (sub, acl, into = db) => {
      await indexVault({
        db: into,
        provider,
        representation,
        vaultId: VAULT,
        root,
        ...(sub ? { sub } : {}),
        isReadable: (rel) => readableByFolder(acl, rel),
      });
    },
  };
}

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

const pathsOf = (v: unknown): string[] => {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) for (const i of x) walk(i);
    else if (x && typeof x === "object")
      for (const [k, val] of Object.entries(x)) {
        if ((k === "path" || k === "source_path") && typeof val === "string") out.push(val);
        else walk(val);
      }
  };
  walk(v);
  return out;
};
const dump = (v: unknown): string => JSON.stringify(v);

/** Every DB-backed retrieval family, as a (tool, input) pair whose result names note paths. */
const FAMILIES: Array<{ name: string; tool: string; input: Record<string, unknown> }> = [
  { name: "search_semantic", tool: "search_semantic", input: { query: "zebra", k: 20 } },
  { name: "search_text (indexed FTS)", tool: "search_text", input: { query: "zebra" } },
  { name: "find_notes_by_tag (notes table)", tool: "find_notes_by_tag", input: { tag: "leaktag" } },
  {
    name: "find_notes_by_property (notes table)",
    tool: "find_notes_by_property",
    input: { key: "kind", value: "secret" },
  },
  {
    name: "vault_graph_search",
    tool: "vault_graph_search",
    input: { query: "zebra", final_top_k: 20 },
  },
];

describe.skipIf(process.platform === "win32")("a stored row is authorized on its acl_path", () => {
  describe.skipIf(nativeVaultIo)(
    "LEAK: wiki -> private; the row was indexed under the alias",
    () => {
      for (const f of FAMILIES) {
        it(`${f.name}: a caller who reads only the alias NAME gets no row`, async () => {
          const w = makeWorld();
          await w.index("wiki", ACL_TARGET);
          // The premise: the alias name is not a way to read the note.
          const direct = await w.call("read_note", { path: "wiki/secret-project.md" }, ACL_ALIAS);
          expect(direct.ok).toBe(false);
          const r = await w.call(f.tool, f.input, ACL_ALIAS);
          expect(r.ok, dump(r)).toBe(true);
          expect(pathsOf(r.data)).toEqual([]);
          expect(dump(r.data)).not.toContain(MARK);
        });

        it(`${f.name}: the caller who can read the target still gets it, under its display path`, async () => {
          const w = makeWorld();
          await w.index("wiki", ACL_TARGET);
          const r = await w.call(f.tool, f.input, ACL_TARGET);
          expect(r.ok, dump(r)).toBe(true);
          expect(pathsOf(r.data)).toContain("wiki/secret-project.md");
        });
      }

      it("tag and property aggregates (list_tags, list_properties) do not count the aliased note", async () => {
        const w = makeWorld();
        await w.index("wiki", ACL_TARGET);
        const tags = await w.call("list_tags", {}, ACL_ALIAS);
        const props = await w.call("list_properties", {}, ACL_ALIAS);
        expect(dump(tags.data)).not.toContain("leaktag");
        expect(dump(props.data)).not.toContain("secret");
      });

      it("the GraphRAG permitted-path set omits the alias row", async () => {
        const w = makeWorld();
        await w.index("wiki", ACL_TARGET);
        await w.index("pages", ACL_PAGES);
        const r = await w.call(
          "vault_graph_search",
          { query: "zebra", final_top_k: 20 },
          ACL_ALIAS,
        );
        expect(r.ok, dump(r)).toBe(true);
        const members = (
          w.db.prepare("SELECT path FROM acl_path_members").all() as Array<{ path: string }>
        ).map((m) => m.path);
        expect(members).toContain(OPEN_PATH); // positive control: a set WAS built for this caller
        expect(members).not.toContain("wiki/secret-project.md");
        expect(pathsOf(r.data)).not.toContain("wiki/secret-project.md");
      });

      it("the permitted-path set a caller builds is keyed on acl_path, not on the name", async () => {
        const w = makeWorld();
        await w.index("wiki", ACL_TARGET);
        await w.index("pages", ACL_PAGES);
        const decide = (acl: FolderAcl) =>
          readableStoredRow(w.db, VAULT, (rel) => readableRel(acl, rel, SCOPES));
        const setFor = (acl: FolderAcl, fingerprint: string): string[] => {
          const id = ensureAclPathSet(w.db, {
            vaultId: VAULT,
            aclFingerprint: fingerprint,
            exclusionDigest: "x",
            generation: readGeneration(w.db, VAULT),
            allPaths: () => allChunkPaths(w.db, VAULT),
            isReadable: decide(acl),
            nowMs: 0,
          });
          expect(id).not.toBeNull();
          return (
            w.db.prepare("SELECT path FROM acl_path_members WHERE set_id = ?").all(id) as Array<{
              path: string;
            }>
          ).map((m) => m.path);
        };
        expect(setFor(ACL_ALIAS, "alias")).toEqual([OPEN_PATH]);
        expect(setFor(ACL_TARGET, "target")).toEqual(["wiki/secret-project.md"]);
      });
    },
  );

  describe.skipIf(nativeVaultIo)("FAIL-CLOSED BUG: shared -> pages, only pages/** readable", () => {
    for (const f of FAMILIES.filter((x) => x.name !== "find_notes_by_tag (notes table)")) {
      it(`${f.name}: the readable note is returned under its display path`, async () => {
        const w = makeWorld();
        await w.index("shared", ACL_PAGES);
        const input =
          f.tool === "find_notes_by_property" ? { key: "kind", value: "open" } : { ...f.input };
        const r = await w.call(f.tool, input, ACL_PAGES);
        expect(r.ok, dump(r)).toBe(true);
        expect(pathsOf(r.data)).toContain("shared/open-note.md");
      });
    }

    it("find_notes_by_tag (notes table): the readable note is returned", async () => {
      const w = makeWorld();
      await w.index("shared", ACL_PAGES);
      const r = await w.call("find_notes_by_tag", { tag: "opentag" }, ACL_PAGES);
      expect(pathsOf(r.data)).toContain("shared/open-note.md");
    });
  });

  describe.skipIf(nativeVaultIo)(
    "legacy rows: the migration marks them unresolved, a pass resolves them",
    () => {
      const preMigration = (): Database => {
        const db = openMemoryDb();
        runMigrations(
          db,
          CACHE_MIGRATIONS.filter((m) => m.version !== "20261009_001"),
        );
        return db;
      };

      it("a pre-migration index (alias-keyed rows) is closed after the migration, open after one pass", async () => {
        const db = preMigration();
        const w = makeWorld(db);
        // Legacy writers: no acl_path column exists yet. The pass must not need it.
        await w.index("wiki", ACL_TARGET);
        await w.index("pages", ACL_PAGES);
        expect(
          (db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).some(
            (c) => c.name === "acl_path",
          ),
        ).toBe(false);

        provisionCacheDb(db); // the upgrade
        const chunkAcl = db
          .prepare("SELECT DISTINCT path, acl_path FROM chunks ORDER BY path")
          .all() as Array<{ path: string; acl_path: string | null }>;
        expect(chunkAcl.length).toBeGreaterThan(0);
        for (const r of chunkAcl) expect(r.acl_path, r.path).toBeNull(); // unresolved (NULL), never trusted
        expect(
          (
            db.prepare("SELECT acl_path FROM notes").all() as Array<{ acl_path: string | null }>
          ).every((n) => n.acl_path === null),
        ).toBe(true);

        // Fail CLOSED: until resolved, nothing is returned to anybody, even the target's reader.
        for (const acl of [ACL_TARGET, ACL_ALIAS, ACL_PAGES]) {
          const sem = await w.call("search_semantic", { query: "zebra", k: 20 }, acl);
          expect(pathsOf(sem.data), "semantic").toEqual([]);
          const tag = await w.call("find_notes_by_tag", { tag: "leaktag" }, acl);
          expect(pathsOf(tag.data), "tag").toEqual([]);
        }

        // One pass resolves every row against the vault, with no re-embedding.
        let embedCalls = 0;
        const counting = {
          ...provider,
          embed: (t: string[]) => {
            embedCalls++;
            return provider.embed(t);
          },
        };
        await indexVault({
          db,
          provider: counting,
          representation: buildRepresentationManifest(counting, {}),
          vaultId: VAULT,
          root: w.root,
          sub: "wiki",
          isReadable: (rel) => readableByFolder(ACL_TARGET, rel),
        });
        expect(embedCalls).toBe(0);
        const after = db
          .prepare("SELECT DISTINCT path, acl_path FROM chunks WHERE path LIKE 'wiki/%'")
          .all() as Array<{ path: string; acl_path: string }>;
        expect(after).toEqual([{ path: "wiki/secret-project.md", acl_path: SECRET_PATH }]);
        const sem = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_TARGET);
        expect(pathsOf(sem.data)).toContain("wiki/secret-project.md");
        const blocked = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALIAS);
        expect(pathsOf(blocked.data)).not.toContain("wiki/secret-project.md");
      });

      it("an unresolvable legacy row stays closed after a pass that does not see its file", async () => {
        const db = preMigration();
        const w = makeWorld(db);
        await w.index("wiki", ACL_TARGET);
        provisionCacheDb(db);
        // The alias is gone from disk: the file cannot be resolved, so the pass cannot set its identity.
        rmSync(join(w.root, "wiki"));
        await w.index("pages", ACL_PAGES); // a pass over something else
        expect(storedAclPathOf(db, VAULT)("wiki/secret-project.md")).toBeNull();
        const sem = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALIAS);
        expect(pathsOf(sem.data)).not.toContain("wiki/secret-project.md");
      });
    },
  );

  describe("the indexer records the identity", () => {
    it.skipIf(nativeVaultIo)(
      "a pass stores display path and acl_path on chunks and notes; plain notes are their own identity",
      async () => {
        const w = makeWorld();
        await w.index("wiki", ACL_TARGET);
        await w.index("pages", ACL_PAGES);
        const rows = (table: string): Array<{ path: string; acl_path: string | null }> =>
          w.db.prepare(`SELECT DISTINCT path, acl_path FROM ${table} ORDER BY path`).all() as never;
        for (const t of ["chunks", "notes"]) {
          expect(rows(t), t).toEqual([
            { path: OPEN_PATH, acl_path: OPEN_PATH },
            { path: "wiki/secret-project.md", acl_path: SECRET_PATH },
          ]);
        }
      },
    );

    it.skipIf(nativeVaultIo)(
      "an unchanged note whose stored identity is stale is re-synced with no re-embed, and the generation moves",
      async () => {
        const w = makeWorld();
        await w.index("wiki", ACL_TARGET);
        w.db.prepare("UPDATE chunks SET acl_path = 'elsewhere/x.md'").run();
        w.db.prepare("UPDATE notes SET acl_path = NULL").run();
        const before = readGeneration(w.db, VAULT);
        await w.index("wiki", ACL_TARGET);
        expect(
          w.db.prepare("SELECT DISTINCT acl_path FROM chunks").all() as Array<{ acl_path: string }>,
        ).toEqual([{ acl_path: SECRET_PATH }]);
        expect(
          w.db.prepare("SELECT DISTINCT acl_path FROM notes").all() as Array<{ acl_path: string }>,
        ).toEqual([{ acl_path: SECRET_PATH }]);
        expect(readGeneration(w.db, VAULT)).toBeGreaterThan(before);
      },
    );

    it.skipIf(nativeVaultIo)("the streaming walk records it too", async () => {
      const w = makeWorld();
      await indexVault({
        db: w.db,
        provider,
        representation,
        vaultId: VAULT,
        root: w.root,
        sub: "wiki",
        isReadable: (rel) => readableByFolder(ACL_TARGET, rel),
        walk: { streaming: true },
      });
      expect(w.db.prepare("SELECT DISTINCT path, acl_path FROM chunks").all()).toEqual([
        { path: "wiki/secret-project.md", acl_path: SECRET_PATH },
      ]);
    });

    it("indexNote (index-on-write) records the identity the caller resolved", async () => {
      const w = makeWorld();
      await indexNote(
        w.db,
        provider,
        VAULT,
        "wiki/secret-project.md",
        FILES[SECRET_PATH] as string,
        false,
        Date.now,
        undefined,
        false,
        undefined,
        undefined,
        SECRET_PATH,
      );
      expect(w.db.prepare("SELECT DISTINCT path, acl_path FROM chunks").all()).toEqual([
        { path: "wiki/secret-project.md", acl_path: SECRET_PATH },
      ]);
      expect(w.db.prepare("SELECT path, acl_path FROM notes").all()).toEqual([
        { path: "wiki/secret-project.md", acl_path: SECRET_PATH },
      ]);
    });
  });

  describe("FAIL OPEN BUG: a writer that does not supply an identity", () => {
    it("indexNote WITHOUT aclPath stores the row unresolved and no principal reads it", async () => {
      const w = makeWorld();
      await indexNote(
        w.db,
        provider,
        VAULT,
        "wiki/secret-project.md",
        FILES[SECRET_PATH] as string,
        false,
        Date.now,
      );
      for (const table of ["chunks", "notes"]) {
        const rows = w.db.prepare(`SELECT DISTINCT acl_path FROM ${table}`).all() as Array<{
          acl_path: string | null;
        }>;
        expect(rows.length, table).toBeGreaterThan(0);
        for (const r of rows) expect(r.acl_path === null || r.acl_path === "", table).toBe(true);
      }
      for (const acl of [ACL_ALIAS, ACL_TARGET]) {
        const sem = await w.call("search_semantic", { query: "zebra", k: 20 }, acl);
        expect(pathsOf(sem.data)).not.toContain("wiki/secret-project.md");
        const tag = await w.call("find_notes_by_tag", { tag: "leaktag" }, acl);
        expect(pathsOf(tag.data)).not.toContain("wiki/secret-project.md");
      }
    });

    it.skipIf(nativeVaultIo)(
      "an unchanged note re-indexed without an identity does not keep a stale one trusted",
      async () => {
        const w = makeWorld();
        await w.index("wiki", ACL_TARGET);
        await indexNote(
          w.db,
          provider,
          VAULT,
          "wiki/secret-project.md",
          FILES[SECRET_PATH] as string,
          false,
          Date.now,
        );
        const sem = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALIAS);
        expect(pathsOf(sem.data)).not.toContain("wiki/secret-project.md");
      },
    );
  });

  // read_note refuses a hard-linked file (st_nlink > 1: realpath cannot see through a hard link, so
  // `allowed/hard.md` may be `private/secret.md`) and hard-denies canonical .obsidian/.git/.trash.
  // A stored row must be no more readable than the file it came from, so indexing applies both.
  describe("read_note parity: hard links and hard-denied control folders", () => {
    /** Folder whitelist the index runs under: everything the vault's callers could ever read. */
    const ACL_WIDE = cfg({
      readPaths: ["private", "private/**", "allowed", "allowed/**", "pages", "pages/**"],
    });
    const ACL_ALLOWED = cfg({ readPaths: ["allowed", "allowed/**"] });
    const hardLinkWorld = (): World => {
      const w = makeWorld();
      write(w.root, "allowed/plain.md", FILES[SECRET_PATH] as string);
      linkSync(join(w.root, SECRET_PATH), join(w.root, "allowed/hard.md"));
      return w;
    };

    it("premise: read_note refuses the hard link, and reads the plain copy", async () => {
      const w = hardLinkWorld();
      const hard = await w.call("read_note", { path: "allowed/hard.md" }, ACL_ALLOWED);
      expect(hard.ok).toBe(false);
      const plain = await w.call("read_note", { path: "allowed/plain.md" }, ACL_ALLOWED);
      expect(plain.ok).toBe(true);
    });

    for (const streaming of [false, true]) {
      for (const f of FAMILIES) {
        it(`${f.name}${streaming ? " (streaming walk)" : ""}: a hard-linked note is not returned to the principal allowed its alias path`, async () => {
          const w = hardLinkWorld();
          await indexVault({
            db: w.db,
            provider,
            representation,
            vaultId: VAULT,
            root: w.root,
            isReadable: (rel) => readableByFolder(ACL_WIDE, rel),
            ...(streaming ? { walk: { streaming: true } } : {}),
          });
          const r = await w.call(f.tool, f.input, ACL_ALLOWED);
          expect(r.ok, dump(r)).toBe(true);
          expect(pathsOf(r.data)).toContain("allowed/plain.md"); // positive control
          expect(pathsOf(r.data)).not.toContain("allowed/hard.md");
        });
      }
    }

    it("a note that BECOMES hard-linked after it was indexed is closed by the next pass", async () => {
      const w = makeWorld();
      write(w.root, "allowed/hard.md", FILES[SECRET_PATH] as string);
      const idx = () =>
        indexVault({
          db: w.db,
          provider,
          representation,
          vaultId: VAULT,
          root: w.root,
          isReadable: (rel) => readableByFolder(ACL_WIDE, rel),
        });
      await idx();
      const before = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALLOWED);
      expect(pathsOf(before.data)).toContain("allowed/hard.md");
      rmSync(join(w.root, "allowed/hard.md"));
      linkSync(join(w.root, SECRET_PATH), join(w.root, "allowed/hard.md"));
      await idx();
      const after = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALLOWED);
      expect(pathsOf(after.data)).not.toContain("allowed/hard.md");
    });

    it("indexNote for a hard-linked path stores no readable identity (the index-on-write shape)", async () => {
      const w = hardLinkWorld();
      await indexNote(
        w.db,
        provider,
        VAULT,
        "allowed/hard.md",
        FILES[SECRET_PATH] as string,
        false,
        Date.now,
        undefined,
        false,
        undefined,
        undefined,
        undefined, // the wiring resolves the identity; a hard link resolves to none
      );
      const sem = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALLOWED);
      expect(pathsOf(sem.data)).not.toContain("allowed/hard.md");
    });

    it("index-on-write (wireIndexCoordinator): a hard-linked path and a path under alias -> .obsidian store no readable row", async () => {
      const w = hardLinkWorld();
      write(w.root, ".obsidian/plugins/p/notes.md", "zebra OBSIDIANMARK\n");
      symlinkSync(join(w.root, ".obsidian"), join(w.root, "oalias"));
      const wiring = wireIndexCoordinator({
        db: w.db,
        metrics: new MetricsRecorder(),
        embeddingProvider: provider,
        hasVec: false,
        chunkContext: false,
        indexing: { writeConcurrency: 2, writeConcurrencyPerVault: 2, queueMax: 100 },
        vaults: [{ id: VAULT, path: w.root }],
        watch: { enabled: false, debounceMs: 0 },
        sqlHooksFor: () => ({}),
        indexHealth: {
          writeFailures: 0,
          frontmatterFailures: new Map(),
          indexQueueBackpressures: 0,
        },
        acl: ACL_WIDE,
        aclByVault: new Map(),
        makeOnIndexed: () => undefined,
      });
      wiring.reindexHook(VAULT, "allowed/plain.md", FILES[SECRET_PATH] as string);
      wiring.reindexHook(VAULT, "allowed/hard.md", FILES[SECRET_PATH] as string);
      wiring.reindexHook(VAULT, "oalias/plugins/p/notes.md", "zebra OBSIDIANMARK\n");
      await wiring.indexCoordinator.idle();
      const r = await w.call("search_semantic", { query: "zebra", k: 20 }, ACL_ALLOWED);
      expect(pathsOf(r.data)).toContain("allowed/plain.md"); // positive control
      expect(pathsOf(r.data)).not.toContain("allowed/hard.md");
      expect(dump(r.data)).not.toContain("OBSIDIANMARK");
      const open = await w.call("search_semantic", { query: "zebra", k: 20 }, cfg({}));
      expect(dump(open.data)).not.toContain("OBSIDIANMARK");
      expect(pathsOf(open.data)).not.toContain("allowed/hard.md");
    });

    it("alias -> .obsidian is not indexed under a default ACL, nor served", async () => {
      const w = makeWorld();
      write(
        w.root,
        ".obsidian/plugins/p/notes.md",
        "---\ntags: [obstag]\n---\nzebra OBSIDIANMARK\n",
      );
      symlinkSync(join(w.root, ".obsidian"), join(w.root, "oalias"));
      const DEFAULT_ACL = cfg({});
      // Control: the walk does reach the note; only the hard-deny on its identity stops it.
      if (!nativeVaultIo) {
        const open = freshDb();
        await w.index("oalias", undefined as unknown as FolderAcl, open);
        expect(
          (open.prepare("SELECT path FROM chunks WHERE path LIKE 'oalias%'").all() as unknown[])
            .length,
        ).toBeGreaterThan(0);
      }
      await w.index("oalias", DEFAULT_ACL);
      await w.index(undefined, DEFAULT_ACL);
      expect(
        (w.db.prepare("SELECT path FROM chunks WHERE path LIKE 'oalias%'").all() as unknown[])
          .length,
      ).toBe(0);
      expect(
        (w.db.prepare("SELECT path FROM notes WHERE path LIKE 'oalias%'").all() as unknown[])
          .length,
      ).toBe(0);
      for (const f of FAMILIES) {
        const r = await w.call(f.tool, f.input, DEFAULT_ACL);
        expect(dump(r.data), f.name).not.toContain("OBSIDIANMARK");
        expect(
          pathsOf(r.data).filter((p) => p.startsWith("oalias")),
          f.name,
        ).toEqual([]);
      }
    });
  });

  describe("the resolver", () => {
    it("an identity is the row's own acl_path; a name whose rows disagree, or that is unresolved, is closed", () => {
      const db = freshDb();
      const ins = db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, acl_path) VALUES (?, ?, ?, 0, '[]', 'c', ?, 1, 0, 0, ?)",
      );
      ins.run("1", VAULT, "a.md", "h1", "a.md"); // its own identity
      ins.run("2", VAULT, "b.md", "h2", null); // NULL = unresolved: closed
      ins.run("3", VAULT, "wiki/c.md", "h3", "private/c.md"); // alias
      ins.run("4", VAULT, "d.md", "h4", ""); // unresolved
      ins.run("5", VAULT, "e.md", "h5", "x/e.md"); // two identities for one name
      ins.run("6", VAULT, "e.md", "h6", "y/e.md");
      const identityOf = storedAclPathOf(db, VAULT);
      expect(["a.md", "b.md", "wiki/c.md", "d.md", "e.md", "gone.md"].map(identityOf)).toEqual([
        "a.md",
        null,
        "private/c.md",
        null,
        null,
        null, // no row at all: nothing to authorize
      ]);
    });

    it("a store whose chain predates the column treats every name as its own identity", () => {
      const db = openMemoryDb();
      runMigrations(
        db,
        CACHE_MIGRATIONS.filter((m) => m.version !== "20261009_001"),
      );
      expect(storedAclPathOf(db, VAULT)("any/name.md")).toBe("any/name.md");
    });
  });
});
