// THE-562 P1.6 (deep half): reflect.persist writes a derived note with a raw writeFileSync,
// bypassing the snapshot, atomic write, and index-on-write/generation-bump that the governed
// write_note (M1) uses. This pins reflect.persist routed through the shared persistGovernedNote
// helper: a second persist of the same query snapshots the first note's prior content, and every
// persist reindexes so the note is searchable and the vault generation bumps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import type { GatewayRoles } from "../src/plane/gateway";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;

function cacheDb0() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
  );
  ins.run("c1", "notes/topic.md", "the quorble pattern part one", "h1", NOW, NOW);
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

const root = mkdtempSync(join(tmpdir(), "obtc-reflect-persist-governed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mockRoles: GatewayRoles = {
  extract: async () => ({ text: "{}", model: "mock" }),
  synthesize: async () => ({ text: "the grounded answer [1]", model: "mock-synth" }),
  judge: async () => ({
    text: JSON.stringify({ verdict: "reconsider", summary: "seen before", categories: [] }),
    model: "mock-judge",
  }),
};

describe("reflect.persist routes through the governed note-write service (THE-562 P1.6)", () => {
  it("reflect.persist snapshots the prior note and reindexes", async () => {
    const reindexed: Array<[string, string, string]> = [];
    const db = cacheDb0();
    const registry = new ToolRegistry({});
    const vaultRegistry = new VaultRegistry([{ id: "main", name: "main", path: root }]);
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider: {
        provider: "ollama",
        model: "stub",
        embed: async () => {
          throw new Error("embed must not be called");
        },
      } as any,
      reranker: null,
      roles: mockRoles,
      classRouter: true,
      snapshots: { enabled: true, retention: 5 },
      reindex: (vaultId, path, content) => reindexed.push([vaultId, path, content]),
    });
    const ctxWrite = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes", "write:notes"]),
      vaultId: "main",
      db,
      now: () => NOW,
    };

    const dispatch = () =>
      registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble pattern", persist: true, mode: "synthesis" },
        ctxWrite,
      );

    const first = (await dispatch()) as { data: { persisted?: { path: string } } };
    const second = (await dispatch()) as { data: { persisted?: { path: string } } };

    expect(first.data.persisted?.path).toBeDefined();
    // Same day, same slug -> the second persist overwrites the same note the first one wrote.
    expect(second.data.persisted?.path).toBe(first.data.persisted?.path);

    expect(reindexed.length).toBeGreaterThanOrEqual(2);
    for (const [vaultId, path] of reindexed) {
      expect(vaultId).toBe("main");
      expect(path).toBe(first.data.persisted?.path);
    }

    const snaps = db.prepare("SELECT COUNT(*) AS n FROM snapshot_blobs").get() as { n: number };
    expect(snaps.n).toBeGreaterThanOrEqual(1);
    const ledger = db.prepare("SELECT COUNT(*) AS n FROM note_snapshots").get() as { n: number };
    expect(ledger.n).toBeGreaterThanOrEqual(1);
  });
});
