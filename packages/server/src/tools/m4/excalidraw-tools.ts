// Domain 9 — Excalidraw (G2.1). Three tools proxied to the companion plugin's
// /excalidraw/* routes (the Excalidraw drawing model — compressed-JSON scenes and
// text elements — lives in the live plugin, so these route through the bridge and
// degrade to plugin_missing/plugin_unreachable when Excalidraw or the companion is
// absent). Reads take read:excalidraw; create/update take write:excalidraw (write
// family, conditional HITL on overwrite — not the always-elicit execute floor).
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

const ElementArray = z.array(z.record(z.string(), z.unknown()));

export function buildExcalidrawTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_excalidraw",
      description:
        "Read an Excalidraw drawing's raw elements and/or extracted text via the companion plugin.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          format: z.enum(["elements", "text", "both"]).default("both"),
        })
        .strict(),
      requiredScopes: ["read:excalidraw"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel);
        const { client } = openBridge(deps, v.id, "excalidraw");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/excalidraw/read",
          body: { path: rel, format: input.format },
          plugin: "excalidraw",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, ...result };
      },
    }),

    defineTool({
      name: "create_excalidraw",
      description:
        "Create a new Excalidraw note via the companion plugin. Overwriting an existing drawing requires confirmation.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          template: z.enum(["blank", "compressed-json", "custom"]).optional(),
          elements: ElementArray.optional(),
          overwrite: z.boolean().default(false),
        })
        .strict(),
      requiredScopes: ["write:excalidraw"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "write", rel);
        requireConfirmation(ctx, "create_excalidraw", input, input.overwrite === true, {
          path: rel,
        });
        const { client } = openBridge(deps, v.id, "excalidraw");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/excalidraw/write",
          body: {
            path: rel,
            mode: "create",
            overwrite: input.overwrite,
            ...(input.template ? { template: input.template } : {}),
            ...(input.elements ? { elements: input.elements } : {}),
          },
          plugin: "excalidraw",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, ...result };
      },
    }),

    defineTool({
      name: "update_excalidraw",
      description:
        "Add, remove, or update elements in an existing Excalidraw note via the companion plugin.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          add_elements: ElementArray.optional(),
          remove_element_ids: z.array(z.string()).optional(),
          update_elements: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
          update_app_state: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
      requiredScopes: ["write:excalidraw"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "write", rel);
        const { client } = openBridge(deps, v.id, "excalidraw");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/excalidraw/write",
          body: {
            path: rel,
            mode: "update",
            ...(input.add_elements ? { add_elements: input.add_elements } : {}),
            ...(input.remove_element_ids ? { remove_element_ids: input.remove_element_ids } : {}),
            ...(input.update_elements ? { update_elements: input.update_elements } : {}),
            ...(input.update_app_state ? { update_app_state: input.update_app_state } : {}),
          },
          plugin: "excalidraw",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, ...result };
      },
    }),
  ];
}
