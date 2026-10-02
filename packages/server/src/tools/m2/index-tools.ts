// index_vault — chunk + embed the vault into the search store (retrieval
// substrate, not one of the six Domain-6 search tools). admin:vault scope; reads
// notes through the read ACL (per-source), writes only the index DB.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { vaultExclusionFor } from "../../search/index-exclusion";
import { indexVault } from "../../search/indexer";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableByFolder, readableRel } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { ResponseFormatInput, resolveResponseFormat } from "../response-format";
import type { M2Deps } from "./shared";

// THE-417 Phase 1: mirrors search/indexer.ts's IndexStats field for field. GH #1027:
// response_format=concise drops the bookkeeping counters (unchanged chunks, edge and upsert/delete
// totals, reused dedup chunks, model, dimensions), so those are optional; every failure and
// degradation signal stays required.
const IndexVaultOutput = z.object({
  vault: z.string(),
  notes_seen: z.number(),
  notes_indexed: z.number(),
  chunks_upserted: z.number(),
  chunks_deleted: z.number(),
  chunks_unchanged: z.number().optional(),
  edges_inserted: z.number().optional(),
  edges_deleted: z.number().optional(),
  secrets_skipped: z.number(),
  vec_enabled: z.boolean(),
  fts_enabled: z.boolean(),
  notes_upserted: z.number().optional(),
  notes_deleted: z.number().optional(),
  notes_embed_failed: z.number(),
  chunks_dedup_reused: z.number().optional(),
  chunks_dedup_unresolved: z.number(),
  embed_batch_rejections: z.number(),
  notes_stale_skipped: z.number(),
  // IndexStats carries it (THE-925 follow-up) but the contract never declared it, so an ajv client
  // rejected every detailed result; found by the part 4b ajv test.
  notes_epoch_stale_skipped: z.number(),
  notes_frontmatter_failed: z.number(),
  frontmatter_failures: z.array(z.object({ path: z.string(), error: z.string() })),
  model: z.string().optional(),
  dimensions: z.number().optional(),
});

export function buildIndexTools(deps: M2Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "index_vault",
      domain: "vault",
      description:
        "Chunk and embed the vault (or a folder) into the search index. Incremental: chunks whose content hash is unchanged are skipped; removed chunks are pruned. response_format=concise drops the bookkeeping counters and keeps the failure, skip and degradation signals.",
      inputSchema: z
        .object({ vault: VaultId, folder: VaultPath.optional(), ...ResponseFormatInput })
        .strict(),
      outputSchema: IndexVaultOutput,
      requiredScopes: ["admin:vault"],
      tags: ["external-network"],
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
        if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root, ctx.grantedScopes);
        // THE-645: a try/catch around the call so a rejection still clears any in-flight state a
        // caller is tracking (deps.onIndexVaultError) before the error propagates to the
        // dispatcher — previously a bare `await` here, so a failed run left a stale "still
        // running" entry forever visible to the next get_index_status caller.
        try {
          const stats = await indexVault({
            db: ctx.db,
            provider: deps.embeddingProvider,
            chunkContext: deps.chunkContext,
            representation: deps.representation,
            densify: deps.densify,
            vaultId: v.id,
            root: v.root,
            sub,
            // Folder-only: the index is shared across callers (see readableByFolder).
            isReadable: (rel) => readableByFolder(ctx.acl, rel),
            // Obsidian's Excluded files + index.excludePaths: never indexed, still link targets.
            isIndexExcluded: vaultExclusionFor(deps.vaultRegistry, v.id).isExcluded,
            now: ctx.now,
            // THE-490/THE-591: indexing.streamingWalk. Off/absent -> byte-identical to before.
            walk: { streaming: deps.streamingWalk },
            // THE-645: in-flight progress, fired once per completed flush() batch.
            onProgress: (p) => deps.onProgress?.(v.id, p),
          });
          // THE-491: surfaced verbatim by get_index_status (last index_vault call this process).
          deps.onIndexVaultComplete?.(v.id, stats);
          // The run itself is caller-independent (shared index), but its RESPONSE is this caller's:
          // a failure entry names a note by path (and its error text embeds the path), so a note
          // the caller cannot read is dropped and the failure count follows the filtered list.
          const frontmatterFailures = stats.frontmatter_failures.filter((f) =>
            readableRel(ctx.acl, f.path, ctx.grantedScopes),
          );
          const failures = {
            notes_frontmatter_failed: frontmatterFailures.length,
            frontmatter_failures: frontmatterFailures,
          };
          if (resolveResponseFormat(input, deps.responseFormat) === "concise")
            return {
              vault: v.id,
              notes_seen: stats.notes_seen,
              notes_indexed: stats.notes_indexed,
              chunks_upserted: stats.chunks_upserted,
              chunks_deleted: stats.chunks_deleted,
              secrets_skipped: stats.secrets_skipped,
              vec_enabled: stats.vec_enabled,
              fts_enabled: stats.fts_enabled,
              notes_embed_failed: stats.notes_embed_failed,
              chunks_dedup_unresolved: stats.chunks_dedup_unresolved,
              embed_batch_rejections: stats.embed_batch_rejections,
              notes_stale_skipped: stats.notes_stale_skipped,
              notes_epoch_stale_skipped: stats.notes_epoch_stale_skipped,
              ...failures,
            };
          return { vault: v.id, ...stats, ...failures };
        } catch (e) {
          deps.onIndexVaultError?.(v.id);
          throw e;
        }
      },
    }),
  ];
}
