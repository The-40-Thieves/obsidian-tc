// Domain 10 — Dataview standalone (G2.1). Two read-side introspection tools that
// don't fit the "search" domain: validate_dql (parse-only) and eval_dataview_field
// (evaluate a field expression against one note). Both proxy to the companion's
// /dataview/* routes and degrade via the capability gate. Read scope only
// (read:dataview, no HITL floor) — neither mutates the vault. The DQL *query*
// executor lives in Domain 6 as search_dql, sharing the same bridge.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildDataviewTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "validate_dql",
      description:
        "Parse a Dataview DQL query without executing it. Returns the AST or a parse-error location.",
      inputSchema: z.object({ vault: VaultId, dql: z.string().min(1) }).strict(),
      requiredScopes: ["read:dataview"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "dataview");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/dataview/validate",
          body: { dql: input.dql },
          plugin: "dataview",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "eval_dataview_field",
      description:
        "Evaluate a Dataview field expression against a single note (useful for property derivation).",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath, expression: z.string().min(1) })
        .strict(),
      requiredScopes: ["read:dataview"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel);
        const { client } = openBridge(deps, v.id, "dataview");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/dataview/eval",
          body: { path: rel, expression: input.expression },
          plugin: "dataview",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, expression: input.expression, ...result };
      },
    }),
  ];
}
