// GH #995 follow-up: a runtime add_vault's notes pass (tool-wiring.ts) persists notes_ready too, so a
// follower reports it. registerM1Tools is mocked so the test can call the indexVault closure that
// wireM1Tools hands it, without wiring the whole M1 tool surface.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { readPersistedReconcileState } from "../src/runtime/reconcile-state";
import { type M1WiringDeps, wireM1Tools } from "../src/runtime/tool-wiring";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const captured = vi.hoisted(() => ({
  indexVault: undefined as undefined | ((vaultId: string) => Promise<unknown>),
}));

vi.mock("../src/tools/m1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/m1")>();
  return {
    ...actual,
    registerM1Tools: (_registry: unknown, opts: { indexVault?: typeof captured.indexVault }) => {
      captured.indexVault = opts.indexVault;
    },
  };
});

describe("a runtime add_vault's notes pass persists notes_ready (tool-wiring.ts)", () => {
  it("the indexVault closure writes notes_ready to the cache.db row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "add-vault-notes-ready-"));
    try {
      const db = openMemoryDb();
      provisionCacheDb(db);
      const config = ServerConfigSchema.parse({ vaults: [{ id: "v1", path: dir }], cacheDir: dir });
      const deps = {
        registry: {},
        config,
        vaultRegistry: new VaultRegistry([{ id: "v1", path: dir }]),
        db,
        embeddingProvider: {},
        embedConfig: { batchSize: 8, concurrency: 1, maxBatchTokens: 2048 },
        representation: {},
        fts: { metadataIndex: () => ({}) },
        indexHealth: { notesReady: false },
        indexReadableFor: () => () => true,
        sqlHooksFor: () => ({}),
        makeOnIndexed: () => undefined,
        onVecRebuild: () => {},
        experientialOpen: false,
        indexVaultRecorded: async (o: { onNotesPass?: () => void }) => {
          o.onNotesPass?.();
          return { notes_seen: 0 };
        },
      };
      wireM1Tools(deps as unknown as M1WiringDeps);
      await captured.indexVault?.("v1");
      expect(readPersistedReconcileState(db)).toEqual({
        reconcile: "pending",
        reconcileAt: null,
        reconcileErrors: [],
        notesReady: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
