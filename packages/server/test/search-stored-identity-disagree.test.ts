// M2 search (search_semantic, indexed search_text) authorizes a stored row on its ACL identity
// (`chunks.acl_path` / `notes.acl_path`). When the two tables name DIFFERENT identities for one path
// the row cannot be trusted: it is hidden, exactly as `readableStoredRow` (M7, M8) already does.
// The shared `storedAclPathOf` used to drop a self-identity row from the comparison, so chunks
// `wiki/x.md -> wiki/x.md` against notes `wiki/x.md -> private/x.md` resolved as `private/x.md`, and a
// caller who reads `private/**` was handed the row. ONE identity rule now (currentIdentityOf).
// No symlink is involved (the disagreement is set directly on the rows), so this runs with the native
// addon too.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v";
const PATH = "wiki/x.md";
const SCOPES = new Set(["read:notes", "read:docs", "read:vault"]);
const cfg = (readPaths: string[]): FolderAcl =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths });
const READS_PRIVATE = cfg(["private", "private/**"]);
const READS_WIKI = cfg(["wiki", "wiki/**"]);

const provider = fakeEmbeddingProvider({ dimensions: 32 });
const representation = buildRepresentationManifest(provider, {});
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A real `wiki/x.md` on disk (so the FTS leg's disk re-verify finds it), indexed under its own name. */
async function world(acls: { chunks: string; notes: string }) {
  const root = makeTempDir("obtc-ident-disagree-");
  cleanups.push(() => rmTemp(root));
  mkdirSync(dirname(join(root, PATH)), { recursive: true });
  writeFileSync(join(root, PATH), "# X\n\nzebra marker body\n");
  const db: Database = openMemoryDb();
  provisionCacheDb(db);
  await indexVault({
    db,
    provider,
    representation,
    vaultId: VAULT,
    root,
    isReadable: () => true,
  });
  db.prepare("UPDATE chunks SET acl_path = ? WHERE vault_id = ? AND path = ?").run(
    acls.chunks,
    VAULT,
    PATH,
  );
  db.prepare("UPDATE notes SET acl_path = ? WHERE vault_id = ? AND path = ?").run(
    acls.notes,
    VAULT,
    PATH,
  );
  const vaultRegistry = new VaultRegistry([{ id: VAULT, path: root }]);
  const registry = new ToolRegistry({});
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    representation,
    metadataIndex: { hasFts: true, ready: () => true },
  });
  return async (tool: string, acl: FolderAcl): Promise<string[]> => {
    const ctx: CallerContext = {
      caller: "tester",
      authenticated: true,
      grantedScopes: SCOPES,
      vaultId: VAULT,
      db,
      acl,
    };
    const res = (await registry.dispatch(
      tool,
      { vault: VAULT, query: "zebra", ...(tool === "search_semantic" ? { k: 20 } : {}) },
      ctx,
    )) as unknown as { ok: boolean; data?: { items: Array<{ path: string }> } };
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return (res.data?.items ?? []).map((i) => i.path);
  };
}

const TOOLS = ["search_semantic", "search_text"] as const;

describe.skipIf(process.platform === "win32")(
  "M2 search: chunks/notes identity disagreement",
  () => {
    for (const tool of TOOLS) {
      it(`${tool}: chunks self + notes alias is hidden from the alias target's reader`, async () => {
        const call = await world({ chunks: PATH, notes: "private/x.md" });
        expect(await call(tool, READS_PRIVATE)).toEqual([]);
      });

      it(`${tool}: chunks alias + notes self is hidden from the alias target's reader`, async () => {
        const call = await world({ chunks: "private/x.md", notes: PATH });
        expect(await call(tool, READS_PRIVATE)).toEqual([]);
      });

      it(`${tool}: chunks self + notes alias is hidden from the name's reader too`, async () => {
        const call = await world({ chunks: PATH, notes: "private/x.md" });
        expect(await call(tool, READS_WIKI)).toEqual([]);
      });

      it(`${tool}: an agreeing alias pair is returned to the reader of its identity only`, async () => {
        const call = await world({ chunks: "private/x.md", notes: "private/x.md" });
        expect(await call(tool, READS_PRIVATE)).toEqual([PATH]);
        expect(await call(tool, READS_WIKI)).toEqual([]);
      });

      it(`${tool}: an agreeing self pair is returned`, async () => {
        const call = await world({ chunks: PATH, notes: PATH });
        expect(await call(tool, READS_WIKI)).toEqual([PATH]);
      });
    }
  },
);
