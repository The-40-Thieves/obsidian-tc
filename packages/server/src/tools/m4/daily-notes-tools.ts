// Domain 26 (companion-core) — Daily Notes bridge. Resolves the daily note for a date via the
// core Daily Notes plugin's configured folder + format, through the companion
// /daily-notes/resolve route. Companion-core capability (openCompanionBridge): degrades to
// plugin_unreachable when the companion is absent or core Daily Notes is disabled. Read-only.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { assertBridgePathReadable } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openCompanionBridge, parseBridgePayload } from "./shared";

const DailyNoteBridge = z.object({
  date: z.string().optional(),
  folder: z.string().optional(),
  format: z.string().optional(),
  path: z.string(),
  exists: z.boolean(),
});
const DailyNoteOutput = DailyNoteBridge.extend({ vault: z.string() }).strict();

export function buildDailyNotesTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "resolve_daily_note",
      domain: "workspace",
      description:
        "Resolve the daily note for a date (default today) via the core Daily Notes plugin's configured folder + format. Returns whether it exists and its path — no path guessing. Read-only; does not create.",
      inputSchema: z.object({ vault: VaultId, date: z.string().optional() }).strict(),
      outputSchema: DailyNoteOutput,
      requiredScopes: ["read:daily-notes"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openCompanionBridge(deps, v.id);
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/daily-notes/resolve",
          body: { ...(input.date ? { date: input.date } : {}) },
          plugin: "obsidian-tc-companion",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        const payload = parseBridgePayload(DailyNoteBridge, result, "obsidian-tc-companion");
        const path = normalizeVaultPath(payload.path);
        // The resolved path (and whether it exists) is what read_note would refuse for a path the
        // caller cannot read: an existence oracle for a rule-scoped daily-notes folder.
        assertBridgePathReadable(
          ctx.acl,
          v.root,
          ctx.grantedScopes,
          { path },
          {
            tool: "resolve_daily_note",
          },
        );
        const slash = path.lastIndexOf("/");
        const folder = slash < 0 ? "" : path.slice(0, slash);
        return { vault: v.id, ...payload, folder, path };
      },
    }),
  ];
}
