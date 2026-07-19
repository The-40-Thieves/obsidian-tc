// Domain (metadata) — Metadata Menu bridge. Reads a note's typed fields via the plugin's
// IMetadataMenuApi.namedFileFields, proxied through the companion /metadata-menu/fields
// route. Read scope only (read:metadata-menu), path ACL-enforced; degrades via the
// capability gate when Metadata Menu or the companion is absent.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildMetadataMenuTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_metadata_fields",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Read a note's typed metadata fields via the Metadata Menu plugin: returns each configured field's name, value, type, validity, and source (frontmatter vs inline). Read-only field introspection.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      requiredScopes: ["read:metadata-menu"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const { client } = openBridge(deps, v.id, "metadata-menu");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/metadata-menu/fields",
          body: { path: rel },
          plugin: "metadata-menu",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),
  ];
}
