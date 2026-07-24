// THE-222 — reflect MCP tool pins, via the lexical-route harness (rare term, throwing embed
// stub — no embedding backend). Covers: graceful degradation without the gateway (recall still
// returns sources), synthesis mode with a mock roles seam, challenge-mode delegation to the
// red-team core, persist provenance (and its write:notes gate).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  ins.run(
    "d1",
    "09-reference/decisions/2026-01-01-quorble.md",
    "decision: quorble it",
    "h2",
    NOW,
    NOW,
  );
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-reflect-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(roles: GatewayRoles | null, scopes: string[] = ["read:notes"]) {
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
    roles,
    classRouter: true,
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: "main",
    db: cacheDb0(),
    now: () => NOW,
  };
  return { registry, ctx };
}

const mockRoles: GatewayRoles = {
  extract: async () => ({ text: "{}", model: "mock" }),
  synthesize: async () => ({ text: "the grounded answer [1]", model: "mock-synth" }),
  judge: async () => ({
    text: JSON.stringify({ verdict: "reconsider", summary: "seen before", categories: [] }),
    model: "mock-judge",
  }),
};

interface ReflectData {
  mode: string;
  available: boolean;
  answer?: string | null;
  model?: string;
  sources: Array<{ chunk_id: string; path: string }>;
  challenge?: { verdict: string; summary: string };
  persisted?: { path: string };
}

describe("reflect tool (THE-222)", () => {
  it("degrades gracefully: no gateway -> available false, recall sources still returned", async () => {
    const { registry, ctx } = harness(null);
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble pattern" }, ctx),
    );
    expect(res.available).toBe(false);
    expect(res.answer).toBeNull();
    expect(res.sources.map((s) => s.chunk_id)).toContain("c1");
  });

  it("synthesis mode returns the grounded answer with model + sources", async () => {
    const { registry, ctx } = harness(mockRoles);
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble pattern" }, ctx),
    );
    expect(res).toMatchObject({ mode: "synthesis", available: true, model: "mock-synth" });
    expect(res.answer).toContain("grounded answer");
    expect(res.sources.length).toBeGreaterThan(0);
  });

  it("scope filters recall to the path prefix", async () => {
    const { registry, ctx } = harness(mockRoles);
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble", scope: "09-reference/" },
        ctx,
      ),
    );
    expect(res.sources.every((s) => s.path.startsWith("09-reference/"))).toBe(true);
  });

  it("challenge mode delegates to the red-team core", async () => {
    const { registry, ctx } = harness(mockRoles);
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "let us quorble the whole vault", mode: "challenge" },
        ctx,
      ),
    );
    expect(res.mode).toBe("challenge");
    expect(res.challenge?.verdict).toBe("reconsider");
    expect(res.model).toBe("mock-judge");
  });

  it("persist writes the derived note with provenance; gated on write:notes", async () => {
    const denied = harness(mockRoles); // read:notes only
    const r = (await denied.registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble pattern", persist: true },
      denied.ctx,
    )) as { ok: boolean };
    expect(r.ok).toBe(false);

    const { registry, ctx } = harness(mockRoles, ["read:notes", "write:notes"]);
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble pattern", persist: true },
        ctx,
      ),
    );
    expect(res.persisted?.path).toMatch(
      /^memory\/reflections\/\d{4}-\d{2}-\d{2}-quorble-pattern\.md$/,
    );
    const abs = join(root, res.persisted?.path ?? "");
    expect(existsSync(abs)).toBe(true);
    const text = readFileSync(abs, "utf8");
    expect(text).toContain("source_model: mock-synth");
    expect(text).toContain("the grounded answer");
    expect(text).toContain("source_chunks:");
  });

  it("persist accepts a wildcard scope caller (grantsAll, not raw has)", async () => {
    // A caller holding `*` satisfies write:notes everywhere else (dispatch uses grantsAll), but the
    // old persist check was a raw Set `.has("write:notes")` that rejected them (audit THE-562 / P1.6).
    const { registry, ctx } = harness(mockRoles, ["*"]);
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble", persist: true }, ctx),
    );
    expect(res.persisted?.path).toMatch(/^memory\/reflections\/\d{4}-\d{2}-\d{2}-quorble\.md$/);
    expect(existsSync(join(root, res.persisted?.path ?? ""))).toBe(true);
  });
});
