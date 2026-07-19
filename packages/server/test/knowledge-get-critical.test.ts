// THE-444 — knowledge_get_critical: the severity=critical pre-filter over the docs corpus.
// Proves the read:docs isolation gate, that only critical-frontmatter notes are returned for the
// corpus vault (sorted by source), and the optional source narrow. Populates the notes table
// directly (the ingestion path is a separate increment).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;
const VAULT = "vendor-docs";

function docsDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, '[]', ?, ?, ?, 100, ?)",
  );
  ins.run(
    VAULT,
    "context7/leading-slash.md",
    "Strict Leading Slash Requirement",
    JSON.stringify({ severity: "critical", category: "breaking_change", source: "context7" }),
    "h1",
    NOW,
    NOW,
  );
  ins.run(
    VAULT,
    "context7/token-budget.md",
    "Optimal 5000 Token Budget",
    JSON.stringify({ severity: "informational", category: "performance", source: "context7" }),
    "h2",
    NOW,
    NOW,
  );
  ins.run(
    VAULT,
    "midjourney/policy.md",
    "Content Policy Hard Blocks",
    JSON.stringify({ severity: "critical", category: "policy", source: "midjourney" }),
    "h3",
    NOW,
    NOW,
  );
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-kcrit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(scopes: string[]) {
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: { provider: "ollama", model: "stub", embed: async () => [] } as any,
    reranker: null,
    roles: null,
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: VAULT,
    db: docsDb(),
    now: () => NOW,
  };
  return { registry, ctx };
}

interface CritData {
  vault: string;
  count: number;
  items: Array<{ path: string; source: string | null; severity: string }>;
}

describe("knowledge_get_critical (docs corpus severity pre-filter)", () => {
  it("is denied without read:docs", async () => {
    const { registry, ctx } = harness(["read:notes"]);
    const r = (await registry.dispatch("knowledge_get_critical", { vault: VAULT }, ctx)) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
  });

  it("returns only critical-severity docs, sorted by source, under read:docs", async () => {
    const { registry, ctx } = harness(["read:docs"]);
    const res = un<CritData>(
      await registry.dispatch("knowledge_get_critical", { vault: VAULT }, ctx),
    );
    expect(res.count).toBe(2);
    const paths = res.items.map((x) => x.path);
    expect(paths).toContain("context7/leading-slash.md");
    expect(paths).toContain("midjourney/policy.md");
    expect(paths).not.toContain("context7/token-budget.md");
    expect(res.items[0]?.source).toBe("context7");
  });

  it("narrows by source", async () => {
    const { registry, ctx } = harness(["read:docs"]);
    const res = un<CritData>(
      await registry.dispatch(
        "knowledge_get_critical",
        { vault: VAULT, source: "midjourney" },
        ctx,
      ),
    );
    expect(res.count).toBe(1);
    expect(res.items[0]?.path).toBe("midjourney/policy.md");
  });
});
