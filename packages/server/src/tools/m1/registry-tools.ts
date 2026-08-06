// Domain 1 — Multi-vault registry (G2.1 r2). list_vaults / get_vault (read:vault)
// and reload_vault / reset_vault_cache (admin:vault). reset_vault_cache is the
// first destructive tool: destructive:true engages the dispatch HITL gate.
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ElicitToken, err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { loadConfig } from "../../config/load";
import type { Database } from "../../db/types";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

const nowMs = (ctx: CallerContext): number => (ctx.now ?? Date.now)();
const iso = (ms: number): string => new Date(ms).toISOString();

// SQLite has no bind parameter for a table identifier, so `table` is interpolated. Every caller
// passes a hard-coded literal (only "chunks" today), but interpolating an identifier is a latent
// injection seam if a future caller ever forwards one — so gate it on a fixed allowlist of the
// vault-partitioned cache tables this helper is allowed to count (defense-in-depth, THE-268 class).
const COUNTABLE_TABLES = new Set(["chunks"]);

function countRows(db: Database, table: string, vaultId: string): number {
  if (!COUNTABLE_TABLES.has(table))
    throw err.invalidInput(`countRows: table not in allowlist: ${table}`, { table });
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

// ── output schemas (THE-417 Phase 1) ────────────────────────────────────────
// Written from each handler's RETURN statements, not from VaultRegistry's Vault type —
// these tools rename/derive fields (read_only, cache stats) that do not live on Vault.

const AddVaultOutput = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  indexed: z.boolean(),
  // null when deps.indexVault is absent (tests); otherwise the indexer's own summary.
  index: z.object({ notes_seen: z.number().int() }).nullable(),
});

const ListVaultsOutput = z.object({
  vaults: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      path: z.string(),
      read_only: z.boolean(),
      embeddings_provider: z.string(),
      chunk_count: z.number().int(),
      // Always the literal null today (no last-synced tracking wired yet) — encoded as
      // z.null() rather than a nullable type, since that is the only value ever returned.
      last_synced_at: z.null(),
    }),
  ),
});

const GetVaultOutput = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  read_only: z.boolean(),
  acl: z.object({
    read_paths: z.array(z.string()).nullable(),
    write_paths: z.array(z.string()).nullable(),
    delete_paths: z.array(z.string()).nullable(),
  }),
  embeddings: z.object({ provider: z.string(), model: z.string() }),
  cache: z.object({
    chunk_count: z.number().int(),
    last_synced_at: z.null(),
    db_size_bytes: z.number().int(),
  }),
});

const ReloadVaultOutput = z.object({ vault: z.string(), reloaded_at: z.string() });

const ResetVaultCacheOutput = z.object({
  vault: z.string(),
  reset_at: z.string(),
  rows_dropped: z.object({
    chunks: z.number().int(),
    vec_chunks: z.number().int(),
    chunk_fts: z.number().int(),
    embeddings: z.number().int(),
    idempotency_keys: z.number().int(),
    event_log: z.number().int(),
  }),
});

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
      .prefault({}),
    elicit_token: ElicitToken.optional(),
  })
  .strict();

export function buildRegistryTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "add_vault",
      domain: "vault",
      description:
        "Register a new vault at runtime (no restart). Validates the path is an existing directory, adds it to the registry, and indexes it for search. Runtime-only — add it to the config file to persist across restarts.",
      inputSchema: z
        .object({
          vault_id: VaultId,
          path: z.string().min(1),
          name: z.string().min(1).optional(),
          // P1.5: a runtime-added vault is `private` unless stated; pass `docs` to provision an
          // external-docs corpus reachable only by the read:docs tools.
          kind: z.enum(["private", "docs", "system"]).default("private"),
        })
        .strict(),
      outputSchema: AddVaultOutput,
      requiredScopes: ["admin:vault"],
      handler: async (input) => {
        if (deps.vaultRegistry.has(input.vault_id))
          throw err.invalidInput(`vault already registered: ${input.vault_id}`, {
            vault: input.vault_id,
          });
        let root: string;
        try {
          root = realpathSync(resolve(input.path));
        } catch {
          throw err.invalidInput("path does not exist", { path: input.path });
        }
        if (!statSync(root).isDirectory())
          throw err.invalidInput("path is not a directory", { path: input.path });
        const v = deps.vaultRegistry.register({
          id: input.vault_id,
          path: root,
          name: input.name,
          kind: input.kind,
        });
        const index = deps.indexVault ? await deps.indexVault(v.id) : null;
        return { id: v.id, name: v.name, path: v.root, indexed: index !== null, index };
      },
    }),
    defineTool({
      name: "list_vaults",
      domain: "vault",
      description: "List configured vaults and their cache state.",
      inputSchema: z.object({}).strict(),
      outputSchema: ListVaultsOutput,
      requiredScopes: ["read:vault"],
      handler: (_input, ctx) => ({
        vaults: deps.vaultRegistry.list().map((v) => ({
          id: v.id,
          name: v.name,
          kind: v.kind,
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
      domain: "vault",
      description: "Inspect a single vault's configuration and cache state.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: GetVaultOutput,
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
      domain: "vault",
      description: "Re-read a vault's configuration from disk (does not touch the cache).",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: ReloadVaultOutput,
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
      domain: "vault",
      vaultArg: "vault",
      description:
        "Drop the SQLite cache for a vault (chunks, embeddings, idempotency keys; optionally the event log). Destructive — requires confirmation.",
      inputSchema: ResetInput,
      outputSchema: ResetVaultCacheOutput,
      requiredScopes: ["admin:vault"],
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const inc = input.include;
        const rows_dropped = {
          chunks: 0,
          vec_chunks: 0,
          chunk_fts: 0,
          embeddings: 0,
          idempotency_keys: 0,
          event_log: 0,
        };
        if (inc.embeddings)
          rows_dropped.embeddings = del(
            ctx.db,
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE vault_id = ?)",
            v.id,
          );
        if (inc.chunks) {
          // Drop orphaned sqlite-vec vectors before their chunks (the subquery needs
          // chunks to still exist); skip silently when the vec0 table/extension is absent.
          try {
            rows_dropped.vec_chunks = del(
              ctx.db,
              "DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE vault_id = ?)",
              v.id,
            );
          } catch {
            /* vec_chunks absent (node:sqlite or extension not loaded) */
          }
          // THE-711 follow-up: drop the vault's FTS entries BEFORE its chunks. chunk_fts is
          // contentless, so its only key is the chunks rowid — after the delete below that
          // mapping is gone and the rows are unreachable.
          //
          // Not strictly a correctness fix: chunk_fts was never cleaned up here, and
          // ensureChunkFts rebuilds on any count divergence, so orphans already self-healed. What
          // it avoids is the SHAPE of that healing — a full reindex of every chunk in the database
          // on the next open, triggered by resetting one vault.
          try {
            rows_dropped.chunk_fts = del(
              ctx.db,
              "DELETE FROM chunk_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE vault_id = ?)",
              v.id,
            );
          } catch {
            /* chunk_fts absent (OBSIDIAN_TC_DISABLE_FTS, or a cache.db predating it) */
          }
          rows_dropped.chunks = del(ctx.db, "DELETE FROM chunks WHERE vault_id = ?", v.id);
        }
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
