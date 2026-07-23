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
import type { M2Deps } from "./index";

export function buildIndexTools(deps: M2Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "index_vault",
      description:
        "Chunk and embed the vault (or a folder) into the search index. Incremental: chunks whose content hash is unchanged are skipped; removed chunks are pruned.",
      inputSchema: z.object({ vault: VaultId, folder: VaultPath.optional() }).strict(),
      requiredScopes: ["admin:vault"],
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
          densify: deps.densify,
          vaultId: v.id,
          root: v.root,
          sub,
          isReadable: (rel) => readableRel(ctx.acl, rel),
          now: ctx.now,
        });
        // THE-491: surfaced verbatim by get_index_status (last index_vault call this process).
        deps.onIndexVaultComplete?.(v.id, stats);
        return { vault: v.id, ...stats };
      },
    }),
  ];
}
