// THE-535 — pins the ACTUAL (not documented-as-intended) behaviour of
// experiential.activationRerank on the serve path. The lookup (activationFor) is built and
// threaded to every M7 graphSearch call site, but the ACT-R bubble pass only fires when BOTH
// activationFor AND opts.bubbleSafe.enabled are set (graph_search_stages/projection.ts:33), and
// nothing under src/ ever sets bubbleSafe — only eval/run.ts and test/bubble-safe-wiring.test.ts
// do. So today, activationFor alone (however it got built) changes NOTHING on the serve path.
//
// This is a TRIPWIRE: whoever wires THE-424 (bubbleSafe into the serve path) must consciously
// update this test rather than silently changing ranking behavior. Do NOT "fix" this test by
// making it pass through a code change — if this test starts failing, the fix is to rewrite it to
// document the NEW (now-wired) behavior, with THE-424 as the ticket that made that call.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ToolRegistry } from "../src/mcp/registry";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const VAULT = "main";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

// Unit vector with cosine `c` to the query vec [1,0,0,0] — same fixture convention as
// bubble-safe-wiring.test.ts.
function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function seedDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  // Empty edge table so literal expansion runs (and finds nothing) instead of throwing.
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  // Three seeds with distinct cosines fix the fused order cA > cB > cC (same fixture as
  // bubble-safe-wiring.test.ts). cC would carry the strong activation boost if the bubble pass
  // ever fired on this path.
  addChunk(db, "cA", "A.md", vd(0.95));
  addChunk(db, "cB", "B.md", vd(0.9));
  addChunk(db, "cC", "C.md", vd(0.85));
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-activation-inert-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Mirrors cli.ts's `activationFor = config.experiential.activationRerank ? makeActivationLookup(...)
 *  : undefined`: an activationFor that WOULD reorder cC ahead of cB if the bubble pass fired. */
const activationFor = (id: string) => (id === "cC" ? 1.0 : null);

function harness(withActivationFor: boolean) {
  const db = seedDb();
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: {
      id: "test:embed",
      provider: "ollama",
      model: "stub",
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
    } as any,
    reranker: null,
    roles: null,
    // Models "experiential.activationRerank: true" -> cli.ts builds activationFor and threads it
    // to M7Deps. This is the ONLY thing activationRerank:true does today.
    ...(withActivationFor ? { activationFor } : {}),
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: VAULT,
    db,
  };
  return { registry, ctx };
}

describe("activationRerank is currently INERT on the serve path — see THE-424", () => {
  it("experiential.activationRerank: true (activationFor present) changes nothing: same order as activationFor absent", async () => {
    const offHarness = harness(false);
    const off = un<{ results: Array<{ chunk_id: string }> }>(
      await offHarness.registry.dispatch(
        "vault_graph_search",
        { vault: VAULT, query: "q" },
        offHarness.ctx,
      ),
    );
    const onHarness = harness(true);
    const on = un<{ results: Array<{ chunk_id: string }> }>(
      await onHarness.registry.dispatch(
        "vault_graph_search",
        { vault: VAULT, query: "q" },
        onHarness.ctx,
      ),
    );
    const ids = (r: { results: Array<{ chunk_id: string }> }) => r.results.map((x) => x.chunk_id);
    // Trusted fused order (no activation composition applied).
    expect(ids(off)).toEqual(["cA", "cB", "cC"]);
    // Even with activationFor wired in (the config flag's only current effect), cC — which would
    // move up one slot under the bubble pass (see bubble-safe-wiring.test.ts) — stays last. The
    // flag changes NO ranking today because src/ never sets opts.bubbleSafe.
    expect(ids(on)).toEqual(ids(off));
  });
});
