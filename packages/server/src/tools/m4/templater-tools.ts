// Domain 13 — Templater (G2.1). list_templates is a read-side bridge introspection
// (read:templater, no HITL). execute_template expands a template (which can run
// arbitrary user JS) and writes the result, so it carries write:templater — a
// hardcoded HITL floor (scopes.ts) — meaning dispatch ALWAYS requires a human
// elicit token before the handler runs. Template expansion is never silently
// executable. Uses the longer templater timeout (expansion can be slow).
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildTemplaterTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_templates",
      description:
        "List available Templater templates with parsed metadata (user functions, parameters), via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:templater"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "templater");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/templater/list",
          plugin: "templater",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "execute_template",
      description:
        "Run a Templater template and write the expanded output to a target path. Always requires human confirmation (write:templater is a HITL floor) because templates can execute arbitrary user JavaScript.",
      inputSchema: z
        .object({
          vault: VaultId,
          template: VaultPath,
          target: VaultPath,
          args: z.record(z.string(), z.unknown()).optional(),
          overwrite: z.boolean().default(false),
        })
        .strict(),
      requiredScopes: ["write:templater"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const template = normalizeVaultPath(input.template);
        const target = normalizeVaultPath(input.target);
        enforcePathAcl(ctx.acl, "read", template);
        enforcePathAcl(ctx.acl, "write", target);
        const { client } = openBridge(deps, v.id, "templater");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/templater/execute",
          body: {
            template,
            target,
            overwrite: input.overwrite,
            ...(input.args ? { args: input.args } : {}),
          },
          plugin: "templater",
          timeoutMs: bridgeTimeouts(deps, v.id).templaterTimeoutMs,
        });
        return { vault: v.id, template, target, ...result };
      },
    }),
  ];
}
