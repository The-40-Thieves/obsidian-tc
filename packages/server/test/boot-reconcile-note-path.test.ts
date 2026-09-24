// THE-823 (deferred half): the boot-reconcile degraded log used to name neither the YAML error
// detail nor the offending note — "[index] reconcile degraded for vault "x": frontmatter is not
// valid YAML: <line/col>" across a large vault gives no clue WHICH note broke. index-vault.ts's
// per-note walk (processNote) already has `rel` in scope at its parseNote(raw) call — the fix
// there is the cheapest one available: thread that path through instead of dropping it.
//
// THE-1073 changed WHERE that message ends up: a malformed-frontmatter note no longer rejects the
// whole indexVault pass (see index-vault-frontmatter-skip.test.ts for that contract) — it is
// skipped, counted in IndexStats.notes_frontmatter_failed, and listed verbatim in
// frontmatter_failures. THE-823's promise — that the note path AND the YAML line/column survive to
// the operator-visible stderr line — still holds; it now travels through
// reconcileResultsForVault (runtime/plane-wiring.ts) instead of a rejected promise's message. This
// test exercises that REAL chain: indexVault (src/search/indexer.ts) ->
// IndexStats.frontmatter_failures -> reconcileResultsForVault -> applyReconcileOutcome's stderr
// line (runtime/reconcile-outcome.ts). A test that only asserted on parseNote in isolation could
// pass while the note path was still dropped somewhere along that chain.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { reconcileResultsForVault } from "../src/runtime/plane-wiring";
import { applyReconcileOutcome, type ReconcileHealth } from "../src/runtime/reconcile-outcome";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

const fakeProvider: EmbeddingProvider = {
  id: "fake:embed",
  provider: "fake",
  model: "embed",
  dimensions: 3,
  embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
};

function baseDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX idx_vault_edges_unique ON vault_edges(vault_id, source_path, target_path, edge_type);`,
  );
  return db;
}

describe("boot reconcile names the offending note on malformed frontmatter", () => {
  it("indexVault resolves, skipping the note, and names its path AND the YAML line/column (THE-1073)", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-reconcile-path-"));
    try {
      writeFileSync(join(root, "good.md"), "# Fine\nnothing wrong here\n");
      writeFileSync(join(root, "broken.md"), "---\na: [1, 2\nb: bad\n---\nbody\n");
      // THE-1073: this no longer rejects — the malformed note is skipped, and the OTHER note in
      // the vault still indexes (see index-vault-frontmatter-skip.test.ts for that full contract).
      const stats = await indexVault({
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        now: () => 1,
      });
      expect(stats.notes_frontmatter_failed).toBe(1);
      expect(stats.frontmatter_failures).toHaveLength(1);
      const message = stats.frontmatter_failures[0]?.error ?? "";
      expect(message).toContain("broken.md");
      expect(message).toMatch(/line 2, column 1/);

      // Fold it through the SAME mapping a real reconcile pass uses (reconcileResultsForVault +
      // applyReconcileOutcome, runtime/plane-wiring.ts / runtime/reconcile-outcome.ts), and assert
      // the stderr line an operator actually sees names the note — not just that IndexStats
      // happens to carry it.
      const health: ReconcileHealth = {
        reconcile: "pending",
        reconcileAt: null,
        reconcileErrors: [],
      };
      const written: string[] = [];
      applyReconcileOutcome(reconcileResultsForVault("v1", stats), health, {
        now: () => 1,
        write: (s) => written.push(s),
      });
      expect(health.reconcile).toBe("degraded");
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('vault "v1"');
      expect(written[0]).toContain("broken.md");
    } finally {
      rmTemp(root);
    }
  });
});
