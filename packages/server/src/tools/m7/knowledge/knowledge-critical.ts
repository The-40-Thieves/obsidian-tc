// WP2.3: the `knowledge_get_critical` tool factory, extracted verbatim out of
// buildKnowledgeTools. A metadata pre-filter over frontmatter, not a search — it never touches
// the shared retrieval runtime, so this factory takes only `deps`.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { readableRel } from "../../../vault/acl-read-filter";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import { KnowledgeCriticalOutput } from "./schemas";

export function createKnowledgeCriticalTool(deps: M7Deps): ToolDefinition {
  return defineTool({
    name: "knowledge_get_critical",
    domain: "docs",
    description:
      "List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault.",
    inputSchema: z
      .object({
        vault: VaultId,
        source: z.string().min(1).optional(),
        limit: z.number().int().positive().max(200).default(100),
      })
      .strict(),
    outputSchema: KnowledgeCriticalOutput,
    requiredScopes: ["read:docs"],
    tags: ["docs", "knowledge"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      // P1.5: same docs-kind binding as knowledge_search — this reader is never allowed to
      // resolve a private/system vault.
      if (v.kind !== "docs")
        throw err.forbidden("knowledge_get_critical operates only on a docs-kind vault", {
          vault: v.id,
          kind: v.kind,
        });
      const rows = ctx.db
        .prepare(
          "SELECT path, title, frontmatter FROM notes WHERE vault_id = ? AND json_extract(frontmatter, '$.severity') = 'critical' ORDER BY path",
        )
        .all(v.id) as Array<{ path: string; title: string; frontmatter: string | null }>;
      const items = rows
        .filter((r) => readableRel(ctx.acl, r.path))
        .map((r) => {
          let fm: Record<string, unknown> = {};
          if (r.frontmatter) {
            try {
              fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
            } catch {
              fm = {};
            }
          }
          return {
            path: r.path,
            title: r.title,
            category: typeof fm.category === "string" ? fm.category : null,
            source: typeof fm.source === "string" ? fm.source : null,
            severity: "critical" as const,
          };
        })
        .filter((it) => input.source === undefined || it.source === input.source)
        .sort(
          (a, b) =>
            (a.source ?? "").localeCompare(b.source ?? "") ||
            (a.category ?? "").localeCompare(b.category ?? "") ||
            a.path.localeCompare(b.path),
        )
        .slice(0, input.limit);
      return { vault: v.id, count: items.length, items };
    },
  });
}
