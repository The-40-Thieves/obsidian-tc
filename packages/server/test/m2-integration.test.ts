// Cross-milestone live integration: M1 and M2 tools share one ToolRegistry (as
// cli.ts assembles it), and a note created through the M1 write path is indexed
// and then found by both lexical and semantic M2 search — all through the full
// M0 dispatch pipeline against a real on-disk temp vault, with audit rows asserted.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function dataOf(res: ToolResult): any {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.data;
}

describe("M1 + M2 cross-milestone integration (one shared registry)", () => {
  it("write_note -> index_vault -> search finds the note end-to-end", async () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-m12-"));
    const db = openMemoryDb();
    db.exec(schemaSql);
    const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
    const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const registry = new ToolRegistry();
    registerM1Tools(registry, {
      vaultRegistry,
      version: "test",
      startedAt: 0,
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
    });
    registerM2Tools(registry, {
      vaultRegistry,
      embeddingProvider: fakeEmbeddingProvider({ dimensions: 32 }),
    });

    const ctx = (): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "test",
      db,
      acl,
    });
    const call = (n: string, i: Record<string, unknown>): Promise<ToolResult> =>
      registry.dispatch(n, i, ctx());

    try {
      // M1 + M2 tools coexist on one registry with no name collision.
      const names = registry.list().map((t) => t.name);
      expect(names).toContain("write_note");
      expect(names).toContain("index_vault");
      expect(names).toContain("search_semantic");
      expect(new Set(names).size).toBe(names.length);

      const created = await call("write_note", {
        vault: "test",
        path: "ideas/spaceship.md",
        content: "# Spaceship\n\nplans for a reusable orbital rocket booster",
      });
      expect(created.ok).toBe(true);

      const indexed = dataOf(await call("index_vault", { vault: "test" }));
      expect(indexed.chunks_upserted).toBeGreaterThan(0);

      const text = dataOf(await call("search_text", { vault: "test", query: "rocket" }));
      expect(text.items.map((i: { path: string }) => i.path)).toContain("ideas/spaceship.md");

      const sem = dataOf(
        await call("search_semantic", { vault: "test", query: "orbital booster", k: 5 }),
      );
      expect(sem.items.some((i: { path: string }) => i.path === "ideas/spaceship.md")).toBe(true);

      const events = db.prepare("SELECT tool_name, status FROM event_log").all() as Array<{
        tool_name: string;
        status: string;
      }>;
      expect(events.some((e) => e.tool_name === "index_vault" && e.status === "ok")).toBe(true);
      expect(events.some((e) => e.tool_name === "search_semantic" && e.status === "ok")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
