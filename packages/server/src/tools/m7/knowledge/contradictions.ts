// WP2.3: the `list_contradictions` tool factory, extracted verbatim out of buildKnowledgeTools.
// A table read over the `contradictions` plane table — no query embedding, no graph search — so
// this factory never touches the shared retrieval runtime and takes only `deps`.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { tableExists } from "../../../db/introspect";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import { openContradictionsForPaths } from "./retrieval-runtime";
import { ListContradictionsOutput } from "./schemas";

// THE-491: contradiction detection is fully wired and writes the `contradictions` table, but
// results only ever surfaced indirectly — folded inside vault_context / reflect /
// knowledge_challenge via openContradictionsForPaths above. This is the direct reader: same
// plumbing, no composition, so an agent (or a human) can inspect flagged conflicts on a note
// set standalone rather than paying for a full context/challenge call to see them.
export function createContradictionsTool(deps: M7Deps): ToolDefinition {
  return defineTool({
    name: "list_contradictions",
    domain: "knowledge",
    description:
      "List open contradictions (judge_verdict: 'contradiction' | 'tension') touching any of the given notes — the same detector output vault_context/reflect/knowledge_challenge surface indirectly, exposed directly for standalone inspection. Read-only.",
    inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(200) }).strict(),
    outputSchema: ListContradictionsOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge"],
    pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const paths = input.paths.map((p) => normalizeVaultPath(p));
      for (const p of paths) enforcePathAcl(ctx.acl, "read", p, v.root);
      if (!tableExists(ctx.db, "contradictions")) {
        return {
          vault: v.id,
          available: false,
          message: "contradictions table not present (pre-migration cache.db)",
          total: 0,
          contradictions: [],
        };
      }
      const contradictions = openContradictionsForPaths(ctx.db, v.id, paths, (rel) =>
        readableRel(ctx.acl, rel),
      );
      return {
        vault: v.id,
        available: true,
        total: contradictions.length,
        contradictions,
      };
    },
  });
}
