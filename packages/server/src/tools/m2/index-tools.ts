// index_vault — chunk + embed the vault into the search store (retrieval
// substrate, not one of the six Domain-6 search tools). admin:vault scope; reads
// notes through the read ACL (per-source), writes only the index DB.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { indexVault } from "../../search/indexer";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M2Deps } from "./shared";

// THE-417 Phase 1: mirrors search/indexer.ts's IndexStats field for field — every field there is
// required (no optionals), so this is a plain object, not a union.
const IndexVaultOutput = z.object({
  vault: z.string(),
  notes_seen: z.number(),
  notes_indexed: z.number(),
  chunks_upserted: z.number(),
  chunks_deleted: z.number(),
  chunks_unchanged: z.number(),
  edges_inserted: z.number(),
  edges_deleted: z.number(),
  secrets_skipped: z.number(),
  vec_enabled: z.boolean(),
  fts_enabled: z.boolean(),
  notes_upserted: z.number(),
  notes_deleted: z.number(),
  notes_embed_failed: z.number(),
  chunks_dedup_reused: z.number(),
  chunks_dedup_unresolved: z.number(),
  embed_batch_rejections: z.number(),
  model: z.string(),
  dimensions: z.number(),
});

export function buildIndexTools(deps: M2Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "index_vault",
      domain: "vault",
      description:
        "Chunk and embed the vault (or a folder) into the search index. Incremental: chunks whose content hash is unchanged are skipped; removed chunks are pruned.",
      inputSchema: z.object({ vault: VaultId, folder: VaultPath.optional() }).strict(),
      outputSchema: IndexVaultOutput,
      requiredScopes: ["admin:vault"],
      // THE-583: a full vault index runs for seconds-to-minutes, which is exactly the shape the
      // Tasks extension exists for — the client asks with `params.task` and polls a handle instead
      // of holding a request open. Opt-in per tool: most vault reads return fast enough that a
      // handle is strictly worse than the answer.
      taskAugmentable: true,
      handler: async (input, ctx) => {
        // index_vault writes the index/cache DB. admin:vault is a non-mutating family,
        // so dispatch's read-only kill switch does not cover it; refuse explicitly when
        // the vault is read-only (D6/E3).
        if (ctx.acl?.readOnly)
          throw err.readOnly("vault is read-only; index_vault writes the search index");
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root);
        const stats = await indexVault({
          db: ctx.db,
          provider: deps.embeddingProvider,
          chunkContext: deps.chunkContext,
          representation: deps.representation,
          densify: deps.densify,
          vaultId: v.id,
          root: v.root,
          sub,
          isReadable: (rel) => readableRel(ctx.acl, rel),
          now: ctx.now,
          // THE-490/THE-591: indexing.streamingWalk. Off/absent -> byte-identical to before.
          walk: { streaming: deps.streamingWalk },
        });
        // THE-491: surfaced verbatim by get_index_status (last index_vault call this process).
        deps.onIndexVaultComplete?.(v.id, stats);
        return { vault: v.id, ...stats };
      },
    }),
  ];
}
