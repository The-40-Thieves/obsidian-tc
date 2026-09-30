// ADR-0007 class (b): an operator must be able to see WHICH source won for each stat-conditional
// retrieval default, per vault — otherwise "why is rrfK 4 on this vault" has no answer. The surface
// is get_server_config's `retrieval_defaults` block. Non-secret numbers only.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolRegistry } from "../src/mcp/registry";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import type { M6Deps } from "../src/tools/m6/shared";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const register = (r: ToolRegistry, d: M6Deps) => {
  for (const t of buildAdminTools(d)) r.register(t);
};

interface RetrievalDefaults {
  derived_defaults_enabled: boolean;
  knn_min_sim: { value: number; source: string };
  vaults: Array<{
    id: string;
    rrf_k: { value: number; source: string };
    derived_rrf_k: number | null;
    index_stats: {
      chunk_count: number;
      note_count: number;
      edge_count: number;
      avg_chunks_per_note: number;
      edges_per_note: number;
    } | null;
  }>;
}

function block(r: ToolResult): RetrievalDefaults {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return (r.data as { retrieval_defaults: RetrievalDefaults }).retrieval_defaults;
}

function addChunks(v: M6Vault, n: number): void {
  const ins = v.db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < n; i++) ins.run(`c${i}`, v.id, `n${i}.md`, "0", "[]", "x", `h${i}`, 1, 0, 0);
}

let v: M6Vault | undefined;
afterEach(() => v?.cleanup());

describe("get_server_config retrieval_defaults", () => {
  it("flag off, nothing configured: constant wins, source=default, stats + would-be derived value shown", async () => {
    v = makeM6Vault({ register });
    addChunks(v, 6);
    const b = block(await v.call("get_server_config", {}));
    expect(b.derived_defaults_enabled).toBe(false);
    expect(b.knn_min_sim).toEqual({ value: 0, source: "default" });
    expect(b.vaults).toEqual([
      {
        id: "test",
        rrf_k: { value: 10, source: "default" },
        derived_rrf_k: 2,
        index_stats: {
          chunk_count: 6,
          note_count: 6,
          edge_count: 0,
          avg_chunks_per_note: 1,
          edges_per_note: 0,
        },
      },
    ]);
  });

  it("flag on: the derived value wins and says so", async () => {
    v = makeM6Vault({ register });
    addChunks(v, 6);
    v.deps.retrieval = { derivedDefaults: true };
    const b = block(await v.call("get_server_config", {}));
    expect(b.derived_defaults_enabled).toBe(true);
    expect(b.vaults[0]?.rrf_k).toEqual({ value: 2, source: "derived" });
  });

  it("flag on + explicit rrfK: config wins", async () => {
    v = makeM6Vault({ register });
    addChunks(v, 6);
    v.deps.retrieval = { derivedDefaults: true, rrfK: 60 };
    const b = block(await v.call("get_server_config", {}));
    expect(b.vaults[0]?.rrf_k).toEqual({ value: 60, source: "config" });
    expect(b.vaults[0]?.derived_rrf_k).toBe(2);
  });

  it("an unmeasurable vault (no chunks) reports the constant and no derived value", async () => {
    v = makeM6Vault({ register });
    v.deps.retrieval = { derivedDefaults: true };
    const b = block(await v.call("get_server_config", {}));
    expect(b.vaults[0]?.rrf_k).toEqual({ value: 10, source: "default" });
    expect(b.vaults[0]?.derived_rrf_k).toBeNull();
    expect(b.vaults[0]?.index_stats?.chunk_count).toBe(0);
  });

  it("knnMinSim reports its configured source", async () => {
    v = makeM6Vault({ register });
    v.deps.retrieval = { knnMinSim: 0.8 };
    expect(block(await v.call("get_server_config", {})).knn_min_sim).toEqual({
      value: 0.8,
      source: "config",
    });
  });

  it("leaks no secret-bearing key", async () => {
    v = makeM6Vault({ register });
    addChunks(v, 6);
    const keys: string[] = [];
    (function walk(o: unknown) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object")
        for (const [k, val] of Object.entries(o)) {
          keys.push(k);
          walk(val);
        }
    })(block(await v.call("get_server_config", {})));
    expect(keys.filter((k) => /secret|token|password|key$|credential/i.test(k))).toEqual([]);
  });
});
