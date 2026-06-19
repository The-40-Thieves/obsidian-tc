// Domain 1 — Multi-vault registry (G2.1 r2). list_vaults / get_vault (read:vault)
// and reload_vault / reset_vault_cache (admin:vault). reset_vault_cache is the
// first destructive tool: destructive:true engages the dispatch HITL gate.
import { ElicitToken, VaultId, err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { loadConfig } from "../../config/load";
import type { Database } from "../../db/types";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

const nowMs = (ctx: CallerContext): number => (ctx.now ?? Date.now)();
const iso = (ms: number): string => new Date(ms).toISOString();

function countRows(db: Database, table: string, vaultId: string): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id = ?`).get(vaultId) as
      | { n: number }
      | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

function dbSizeBytes(db: Database): number {
  try {
    const pc = db.prepare("PRAGMA page_count").get() as Record<string, number> | undefined;
    const ps = db.prepare("PRAGMA page_size").get() as Record<string, number> | undefined;
    const pcv = pc ? (Object.values(pc)[0] ?? 0) : 0;
    const psv = ps ? (Object.values(ps)[0] ?? 0) : 0;
    return pcv * psv;
  } catch {
    return 0;
  }
}

function del(db: Database, sql: string, vaultId: string): number {
  return db.prepare(sql).run(vaultId).changes;
}

const ResetInput = z
  .object({
    vault: VaultId,
    include: z
      .object({
        chunks: z.boolean().default(true),
        embeddings: z.boolean().default(true),
        idempotency_keys: z.boolean().default(true),
        event_log: z.boolean().default(false),
      })
      .default({}),
    elicit_token: ElicitToken.optional(),
  })
  .strict();

export function buildRegistryTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_vaults",
      description: "List configured vaults and their cache state.",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["read:vault"],
      handler: (_input, ctx) => ({
        vaults: deps.vaultRegistry.list().map((v) => ({
          id: v.id,
          name: v.name,
          path: v.root,
          read_only: ctx.acl?.readOnly ?? false,
          embeddings_provider: deps.embeddings.provider,
          chunk_count: countRows(ctx.db, "chunks", v.id),
          last_synced_at: null,
        })),
      }),
    }),
    defineTool({
      name: "get_vault",
      description: "Inspect a single vault's configuration and cache state.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:vault"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        return {
          id: v.id,
          name: v.name,
          path: v.root,
          read_only: ctx.acl?.readOnly ?? false,
          acl: {
            read_paths: ctx.acl?.readPaths ?? null,
            write_paths: ctx.acl?.writePaths ?? null,
            delete_paths: ctx.acl?.deletePaths ?? null,
          },
          embeddings: { provider: deps.embeddings.provider, model: deps.embeddings.model },
          cache: {
            chunk_count: countRows(ctx.db, "chunks", v.id),
            last_synced_at: null,
            db_size_bytes: dbSizeBytes(ctx.db),
          },
        };
      },
    }),
    defineTool({
      name: "reload_vault",
      description: "Re-read a vault's configuration from disk (does not touch the cache).",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["admin:vault"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // Re-read + validate the on-disk config when its path is known. M1
        // surfaces config errors here; hot-applying non-destructive deltas to the
        // running ACL/registry is deferred to the admin milestone — the server
        // keeps its startup config until restart (G2.2 section 5).
        if (deps.configPath) {
          const cfg = loadConfig(deps.configPath);
          if (!cfg.vaults.some((cv) => cv.id === v.id))
            throw err.vaultNotFound(`vault is no longer in config: ${v.id}`, { vault: v.id });
        }
        return { vault: v.id, reloaded_at: iso(nowMs(ctx)) };
      },
    }),
    defineTool({
      name: "reset_vault_cache",
      description:
        "Drop the SQLite cache for a vault (chunks, embeddings, idempotency keys; optionally the event log). Destructive — requires confirmation.",
      inputSchema: ResetInput,
      requiredScopes: ["admin:vault"],
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const inc = input.include;
        const rows_dropped = { chunks: 0, embeddings: 0, idempotency_keys: 0, event_log: 0 };
        if (inc.embeddings)
          rows_dropped.embeddings = del(
            ctx.db,
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE vault_id = ?)",
            v.id,
          );
        if (inc.chunks)
          rows_dropped.chunks = del(ctx.db, "DELETE FROM chunks WHERE vault_id = ?", v.id);
        if (inc.idempotency_keys)
          rows_dropped.idempotency_keys = del(
            ctx.db,
            "DELETE FROM idempotency_keys WHERE vault_id = ?",
            v.id,
          );
        if (inc.event_log)
          rows_dropped.event_log = del(ctx.db, "DELETE FROM event_log WHERE vault_id = ?", v.id);
        return { vault: v.id, reset_at: iso(nowMs(ctx)), rows_dropped };
      },
    }),
  ];
}
