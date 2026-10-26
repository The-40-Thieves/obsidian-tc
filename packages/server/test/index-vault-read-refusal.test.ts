// index_vault skips a note the safe open refuses (acl_denied) instead of aborting the whole pass.
//
// The walk lists every note under its symlink-resolved identity, but the read goes through the
// safe open, which refuses any path through an UNCONFIGURED symlinked folder. Before this, the one
// refusal escaped processNote and rejected the whole pass. Now the note is skipped, counted and
// reported, its identity is left UNRESOLVED (fail closed), and the pass continues.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
// (symlinkSync above: the symlinkOk probe below is the Windows guard, see acl-symlink-canonical.test.ts)
import { dirname, join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { toJson } from "../src/mcp/facade";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM2Tools } from "../src/tools/m2";
import { readableByFolder } from "../src/vault/acl-read-filter";
import { FolderPins, withFolderPins } from "../src/vault/folder-links";
import { nativeVaultIo } from "../src/vault/notes-io";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

// Forces a refusal for one walked path (undefined = none), to reach the response filter with a refusal
// the caller can read. Every other read goes through the real safe open.
const forced = vi.hoisted(() => ({ rel: undefined as string | undefined }));
vi.mock("../src/search/indexing/read-refusal", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/search/indexing/read-refusal")>();
  return {
    ...real,
    readIndexableNote: (root: string, rel: string) =>
      rel === forced.rel
        ? { refused: `native path classification failed: EACCES, open '${root}/${rel}'` }
        : real.readIndexableNote(root, rel),
  };
});

const VAULT = "v";
const REFUSED = 'safe open refused the path: refusing symlinked or missing path component: "wiki"';
const OPEN_ACL = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });

let symlinkOk = true;
try {
  const probe = makeTempDir("sl-probe-");
  symlinkSync(join(probe, "t"), join(probe, "l"), "dir");
  rmTemp(probe);
} catch {
  symlinkOk = false; // Windows without the privilege to create symlinks
}

const provider = fakeEmbeddingProvider({ dimensions: 32 });
const representation = buildRepresentationManifest(provider, {});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** pages/a.md and top.md, plus `wiki -> pages` (an UNCONFIGURED symlink) and `outside -> <elsewhere>`. */
function makeRoot(): { root: string; elsewhere: string } {
  const root = makeTempDir("obtc-read-refusal-");
  const elsewhere = makeTempDir("obtc-read-refusal-out-");
  cleanups.push(
    () => rmTemp(root),
    () => rmTemp(elsewhere),
  );
  write(root, "pages/a.md", "# A\n\nzebra alpha\n");
  write(root, "top.md", "# Top\n\nzebra top\n");
  write(elsewhere, "o.md", "# O\n\nzebra outside\n");
  symlinkSync(join(root, "pages"), join(root, "wiki"), "dir");
  symlinkSync(elsewhere, join(root, "outside"), "dir");
  return { root, elsewhere };
}

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function index(
  db: Database,
  root: string,
  sub: string | undefined,
  streaming = false,
): ReturnType<typeof indexVault> {
  return withFolderPins(new FolderPins([]), () =>
    indexVault({
      db,
      provider,
      representation,
      vaultId: VAULT,
      root,
      ...(sub ? { sub } : {}),
      isReadable: (rel) => readableByFolder(OPEN_ACL, rel),
      walk: { streaming },
    }),
  );
}

const chunkPaths = (db: Database, prefix: string): string[] =>
  (
    db.prepare("SELECT DISTINCT path FROM chunks WHERE path LIKE ?").all(`${prefix}%`) as Array<{
      path: string;
    }>
  ).map((r) => r.path);

describe.skipIf(!symlinkOk).each([false, true])(
  "a refused read is skipped and reported (streaming walk: %s)",
  (streaming) => {
    it("a sub-folder that is an unconfigured symlink is skipped and reported, not an aborted pass", async () => {
      const { root } = makeRoot();
      const db = freshDb();
      const stats = await index(db, root, "wiki", streaming);
      expect(stats.notes_read_refused).toBe(1);
      expect(stats.read_refusals.map((r) => r.path)).toEqual(["wiki/a.md"]);
      expect(stats.read_refusals[0]?.error).toContain(REFUSED);
      expect(chunkPaths(db, "wiki/")).toEqual([]);
    });

    it("indexVault({ sub: 'outside' }) still rejects the request: the path escapes the vault root", async () => {
      const { root } = makeRoot();
      await expect(index(freshDb(), root, "outside", streaming)).rejects.toMatchObject({
        code: "path_invalid",
        message: expect.stringContaining("path escapes the vault root"),
      });
    });

    it("a root pass indexes exactly pages/a.md and top.md, and nothing under wiki/ or outside/", async () => {
      const { root } = makeRoot();
      const db = freshDb();
      await index(db, root, undefined, streaming);
      expect(chunkPaths(db, "")).toEqual(["pages/a.md", "top.md"]);
      expect(chunkPaths(db, "wiki/")).toEqual([]);
      expect(chunkPaths(db, "outside/")).toEqual([]);
    });
  },
);

describe.each([false, true])(
  "a stored alias row goes unresolved when its read is later refused (streaming walk: %s)",
  (streaming) => {
    it.skipIf(!nativeVaultIo || !symlinkOk)(
      "re-indexing the alias with no pins leaves no row under its old identity",
      async () => {
        const { root } = makeRoot();
        const db = freshDb();
        await withFolderPins(new FolderPins([{ root, wikiFolder: "wiki" }]), () =>
          indexVault({
            db,
            provider,
            representation,
            vaultId: VAULT,
            root,
            sub: "wiki",
            isReadable: (rel) => readableByFolder(OPEN_ACL, rel),
          }),
        );
        const before = db
          .prepare("SELECT DISTINCT acl_path FROM chunks WHERE path = 'wiki/a.md'")
          .all() as Array<{ acl_path: string | null }>;
        expect(before).toEqual([{ acl_path: "pages/a.md" }]);

        const stats = await index(db, root, "wiki", streaming);
        expect(stats.notes_read_refused).toBe(1);
        const after = db
          .prepare("SELECT DISTINCT acl_path FROM chunks WHERE path = 'wiki/a.md'")
          .all() as Array<{ acl_path: string | null }>;
        expect(after.every((r) => r.acl_path === "" || r.acl_path === null)).toBe(true);
        expect(after.length).toBeGreaterThan(0);
      },
    );
  },
);

// Not on Windows: the tool's path resolver answers path_invalid for the in-vault "wiki" symlink
// there, before the safe open runs (the wiki-symlinked-folders suites skip win32 for the same reason).
describe.skipIf(!symlinkOk || process.platform === "win32")(
  "index_vault through the tool registry",
  () => {
    function registry(root: string, db: Database): ToolRegistry {
      const vaultRegistry = new VaultRegistry([{ id: VAULT, path: root }]);
      const reg = new ToolRegistry({
        aclResolver: () => OPEN_ACL,
        folderPins: new FolderPins([]),
        rootResolver: (id) => vaultRegistry.resolve(id).root,
      });
      registerM2Tools(reg, {
        vaultRegistry,
        embeddingProvider: provider,
        representation,
        metadataIndex: { hasFts: true, ready: () => true },
      });
      void db;
      return reg;
    }

    const ctxFor = (db: Database): CallerContext => ({
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["admin:vault", "read:notes", "read:vault"]),
      vaultId: VAULT,
      db,
      acl: OPEN_ACL,
    });

    for (const response_format of ["concise", undefined] as const) {
      it(`index_vault { folder: "wiki" } counts the refusal but does not name it in read_refusals (response_format: ${response_format ?? "default"})`, async () => {
        const { root } = makeRoot();
        const db = freshDb();
        const reg = registry(root, db);
        const r = (await reg.dispatch(
          "index_vault",
          { vault: VAULT, folder: "wiki", ...(response_format ? { response_format } : {}) },
          ctxFor(db),
        )) as {
          ok: boolean;
          data?: Record<string, unknown>;
          error?: { code: string; message?: string };
        };
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.data?.notes_read_refused).toBe(1);
        // The caller cannot read wiki/a.md (read_note refuses it too): counted in the total, not named.
        expect(r.data?.read_refusals).toEqual([]);
      });
    }

    it("a refusal the caller CAN read stays listed in read_refusals, its error vault-relative", async () => {
      const { root } = makeRoot();
      const db = freshDb();
      const reg = registry(root, db);
      forced.rel = "top.md";
      try {
        const r = (await reg.dispatch(
          "index_vault",
          { vault: VAULT, response_format: "concise" },
          ctxFor(db),
        )) as { ok: boolean; data?: Record<string, unknown> };
        expect(r.ok).toBe(true);
        expect(r.data?.notes_read_refused).toBe(1);
        expect(r.data?.read_refusals).toEqual([
          { path: "top.md", error: expect.stringContaining("EACCES") },
        ]);
        expect(JSON.stringify(r.data)).not.toContain(root);
      } finally {
        forced.rel = undefined;
      }
    });

    it("the advertised output schema (ajv, the SDK validator) accepts the refusal fields", async () => {
      const { root } = makeRoot();
      const db = freshDb();
      const reg = registry(root, db);
      const r = (await reg.dispatch(
        "index_vault",
        { vault: VAULT, folder: "wiki", response_format: "concise" },
        ctxFor(db),
      )) as { ok: boolean; data?: unknown };
      expect(r.ok).toBe(true);
      const def = reg.list().find((t) => t.name === "index_vault");
      if (!def?.outputSchema) throw new Error("index_vault advertises no outputSchema");
      const validate = new AjvJsonSchemaValidator().getValidator(toJson(def.outputSchema) as never);
      const result = validate(JSON.parse(JSON.stringify(r.data)));
      expect(result.valid, JSON.stringify(result)).toBe(true);
    });
  },
);
