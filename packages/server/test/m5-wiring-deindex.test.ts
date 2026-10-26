// The production M5 wiring hands its deindex hook to the memory tools: a confirmed delete_entity
// dispatched through wireM5Tools, and through the wireDomainTools entry point that calls it, must
// reach the deindex spy. Dropping `deindex:` from either wiring makes this fail.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { wireM5Tools } from "../src/runtime/m5-wiring";
import { memoryVaultAccessors } from "../src/runtime/memory-vault-accessors";
import { type DomainToolsDeps, wireDomainTools } from "../src/runtime/tool-wiring";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

/** Creates Alice, then confirms delete_entity through the registry the wiring populated. */
async function createThenDeleteAlice(
  wire: (registry: ToolRegistry, root: string, cacheDir: string) => void,
  deindex: ReturnType<typeof vi.fn>,
): Promise<void> {
  const root = makeTempDir("obtc-m5-wire-");
  const cacheDir = makeTempDir("obtc-m5-wire-cache-");
  const db = openMemoryDb();
  provisionCacheDb(db);
  try {
    const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
    wire(registry, root, cacheDir);
    const ctx: CallerContext = {
      caller: "test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "test",
      db,
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    };
    const created = await registry.dispatch(
      "create_entity",
      { vault: "test", type: "person", name: "Alice" },
      ctx,
    );
    if (!created.ok) throw new Error("create_entity failed");
    const entityId = (created.data as { entity_id: string }).entity_id;
    const input = { vault: "test", entity_id: entityId, cascade: false, permanent: false };
    const token = issueElicitToken(db, {
      vaultId: "test",
      toolName: "delete_entity",
      argsHash: argsHash("delete_entity", input),
      caller: "test",
    });
    const r = await registry.dispatch("delete_entity", input, { ...ctx, elicitToken: token });
    expect(r.ok).toBe(true);
    expect(deindex.mock.calls).toEqual([["test", "memory/person/Alice.md"]]);
    // The wiring also hands over the snapshot config (on by default), so the delete keeps a pre-image.
    const snaps = db.prepare("SELECT count(*) AS n FROM note_snapshots").get() as { n: number };
    expect(snaps.n).toBe(1);
  } finally {
    rmTemp(root);
    rmTemp(cacheDir);
  }
}

describe("production M5 wiring passes the index hooks", () => {
  it("delete_entity reaches the deindex hook through wireM5Tools", async () => {
    const reindex = vi.fn();
    const deindex = vi.fn();
    await createThenDeleteAlice((registry, root, cacheDir) => {
      wireM5Tools(
        {
          registry,
          config: ServerConfigSchema.parse({ vaults: [{ id: "test", path: root }], cacheDir }),
          vaultRegistry: new VaultRegistry([{ id: "test", path: root }]),
          reindex,
          deindex,
        },
        memoryVaultAccessors({
          memoryFolderByVault: new Map(),
          supersededInNoteByVault: new Map(),
          traceFolderByVault: new Map(),
          memoryDefenseByVault: new Map(),
        }),
      );
    }, deindex);
  });

  it("delete_entity reaches the deindex hook through wireDomainTools", async () => {
    const reindex = vi.fn();
    const deindex = vi.fn();
    await createThenDeleteAlice((registry, root, cacheDir) => {
      const config = ServerConfigSchema.parse({ vaults: [{ id: "test", path: root }], cacheDir });
      // Only the M5 path is exercised: every other seam is an inert stub, never reached here.
      const deps = {
        registry,
        config,
        vaultRegistry: new VaultRegistry([{ id: "test", path: root }]),
        reindex,
        deindex,
        memoryFolderByVault: new Map(),
        supersededInNoteByVault: new Map(),
        traceFolderByVault: new Map(),
        memoryDefenseByVault: new Map(),
        reflectDefaultsByVault: new Map(),
        experientialOpen: false,
        fts: { metadataIndex: () => ({}) },
        indexHealth: { notesReady: true },
        reranker: null,
        roles: null,
      } as unknown as DomainToolsDeps;
      wireDomainTools(deps);
    }, deindex);
  });
});
