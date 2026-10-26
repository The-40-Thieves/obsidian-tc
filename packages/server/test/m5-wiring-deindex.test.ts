// The production M5 wiring hands its deindex hook to the memory tools: a confirmed delete_entity
// dispatched through wireM5Tools must reach the deindex spy. Dropping `deindex:` from the wiring
// makes this fail.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { wireM5Tools } from "../src/runtime/m5-wiring";
import { memoryVaultAccessors } from "../src/runtime/memory-vault-accessors";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

describe("production M5 wiring passes the index hooks", () => {
  it("delete_entity reaches the deindex hook through wireM5Tools", async () => {
    const root = makeTempDir("obtc-m5-wire-");
    const cacheDir = makeTempDir("obtc-m5-wire-cache-");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const reindex = vi.fn();
    const deindex = vi.fn();
    try {
      const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
      wireM5Tools(
        {
          registry,
          config: { cacheDir } as unknown as ServerConfig,
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
    } finally {
      rmTemp(root);
      rmTemp(cacheDir);
    }
  });
});
