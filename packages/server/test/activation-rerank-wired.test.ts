// THE-424 Part A — pins the serve-path behaviour of experiential.activationRerank.
//
// HISTORY, because this file's assertions inverted and a reader deserves to know why. Until Part A
// this was activation-rerank-inert.test.ts and it asserted the OPPOSITE: the flag built the
// activationFor lookup, threaded it to every M7 graphSearch call site, and changed no ranking,
// because the ACT-R bubble pass needs BOTH activationFor AND opts.bubbleSafe.enabled and nothing
// under src/ set the latter. THE-535 raised that as a bug; Part A wired bubbleSafe in the shared
// M7 options builder (tools/m7/knowledge/retrieval-runtime.ts), under the same flag.
//
// This test is THE-535's stated Done-when: "set experiential.activationRerank: true, supply an
// activationFor that would reorder, and assert the serve-path result order matches the flag's
// INTENDED semantics." It fails on any build where that wiring is absent, which is what makes it
// a gate rather than a description.
//
// It remains a TRIPWIRE, now pointing the other way. The flag still ships FALSE — Part B's A/B is
// what would move the default (paired permutation surviving BH-FDR AND dNDCG >= 0.010). If you are
// here because this test failed, the question to answer first is whether the bubble pass is still
// a SINGLE bounded pass: the one-position bound is what makes the activation feedback loop safe,
// and both the wiring comment and the query-cache key justification rest on it.

import { mkdtempSync, readFileSync } from "node:fs";
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
import { rmTemp } from "./tmp";

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
afterAll(() => rmTemp(root));

/** Mirrors runtime/stores.ts's `activationFor = experiential.activationRerank
 *  ? makeActivationLookup(...) : undefined`. cC carries the only signal (1.0 -> the full 1.2x
 *  multiplier); null reads as 0.5, which is provably inert at any k. So cC is the one item the
 *  bubble pass can move, and it can move exactly one slot. */
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
    // Models "experiential.activationRerank: true" -> runtime/stores.ts builds activationFor and
    // threads it to M7Deps. Since Part A, the M7 options builder reads exactly this field to decide
    // whether to set bubbleSafe, so presence here is the whole serve-path switch.
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

const ids = (r: { results: Array<{ chunk_id: string }> }) => r.results.map((x) => x.chunk_id);

async function search(withActivationFor: boolean): Promise<string[]> {
  const h = harness(withActivationFor);
  return ids(
    un<{ results: Array<{ chunk_id: string }> }>(
      await h.registry.dispatch("vault_graph_search", { vault: VAULT, query: "q" }, h.ctx),
    ),
  );
}

describe("activationRerank reaches the serve-path ranking — THE-424 Part A", () => {
  it("off (no activationFor) returns the trusted fused order", async () => {
    expect(await search(false)).toEqual(["cA", "cB", "cC"]);
  });

  it("on (activationFor present) composes activation into the order", async () => {
    const off = await search(false);
    const on = await search(true);
    // The assertion that fails on any build without Part A's wiring: before it, activationFor was
    // built, threaded, and ignored, so `on` equalled `off`. cC carries the only activation signal
    // and advances past cB.
    expect(on).not.toEqual(off);
    expect(on).toEqual(["cA", "cC", "cB"]);
  });

  it("no item moves more than one position — the bound the damping argument rests on", async () => {
    const off = await search(false);
    const on = await search(true);
    expect(on.length).toBe(off.length);
    expect([...on].sort()).toEqual([...off].sort()); // same set, only order differs
    for (const id of off) {
      expect(Math.abs(on.indexOf(id) - off.indexOf(id))).toBeLessThanOrEqual(1);
    }
  });
});
