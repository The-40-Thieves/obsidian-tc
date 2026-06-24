// Domain 11 — Workspaces. Three tools: list_workspaces, open_workspace,
// save_workspace. Backed by Obsidian's core Workspaces plugin file,
// .obsidian/workspaces.json — { workspaces: { <name>: <layout> }, active: <name> }.
// A headless server cannot repaint Obsidian's UI, so "open" is honest about its
// effect: it records the active workspace (which a connected Obsidian honors) and
// returns the stored layout. Edits round-trip through json-config (parse raw, mutate
// only the modeled keys, re-serialize with the file's indentation), so other
// workspaces and unknown top-level keys survive. Overwriting a saved workspace
// requires HITL confirmation; listing/opening never do.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../../formats/json-config";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

const WORKSPACES_PATH = ".obsidian/workspaces.json";

interface WorkspacesDoc {
  workspaces?: Record<string, unknown>;
  active?: unknown;
  [k: string]: unknown;
}

function workspacesOf(data: WorkspacesDoc): Record<string, unknown> {
  const w = data.workspaces;
  return w && typeof w === "object" && !Array.isArray(w) ? (w as Record<string, unknown>) : {};
}

export function buildWorkspaceTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_workspaces",
      description:
        "List saved workspace names and the active workspace (.obsidian/workspaces.json).",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:workspaces"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        enforcePathAcl(ctx.acl, "read", WORKSPACES_PATH);
        const abs = resolveVaultPath(v.root, WORKSPACES_PATH);
        const file = readJsonFile<WorkspacesDoc>(abs, { workspaces: {} });
        const names = Object.keys(workspacesOf(file.data));
        return {
          vault: v.id,
          exists: file.exists,
          workspaces: names,
          active: typeof file.data.active === "string" ? file.data.active : null,
          count: names.length,
          content_hash: file.hash,
        };
      },
    }),

    defineTool({
      name: "open_workspace",
      description:
        "Mark a saved workspace active and return its stored layout. Fails if the workspace does not exist.",
      inputSchema: z.object({ vault: VaultId, name: z.string().min(1) }).strict(),
      requiredScopes: ["write:workspaces"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        enforcePathAcl(ctx.acl, "write", WORKSPACES_PATH);
        const abs = resolveVaultPath(v.root, WORKSPACES_PATH);
        const file = readJsonFile<WorkspacesDoc>(abs, { workspaces: {} });
        const ws = workspacesOf(file.data);
        if (!(input.name in ws))
          throw err.noteNotFound("workspace not found", { name: input.name });
        file.data.active = input.name;
        const { hash } = writeJsonFile(abs, file.data, file.indent, file.trailingNewline);
        return {
          vault: v.id,
          active: input.name,
          layout: ws[input.name],
          content_hash: hash,
        };
      },
    }),

    defineTool({
      name: "save_workspace",
      description:
        "Save a workspace layout under a name (optionally making it active). Overwriting an existing workspace requires confirmation.",
      inputSchema: z
        .object({
          vault: VaultId,
          name: z.string().min(1),
          layout: z.record(z.string(), z.unknown()),
          set_active: z.boolean().default(false),
          overwrite: z.boolean().default(false),
        })
        .strict(),
      requiredScopes: ["write:workspaces"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        enforcePathAcl(ctx.acl, "write", WORKSPACES_PATH);
        const abs = resolveVaultPath(v.root, WORKSPACES_PATH);
        const file = readJsonFile<WorkspacesDoc>(abs, { workspaces: {} });
        const data = file.data;
        if (
          !data.workspaces ||
          typeof data.workspaces !== "object" ||
          Array.isArray(data.workspaces)
        )
          data.workspaces = {};
        const ws = data.workspaces as Record<string, unknown>;

        const exists = input.name in ws;
        if (exists && !input.overwrite)
          throw err.noteExists("workspace already exists; set overwrite", { name: input.name });
        requireConfirmation(ctx, "save_workspace", input, exists && input.overwrite, {
          name: input.name,
        });

        ws[input.name] = input.layout;
        if (input.set_active) data.active = input.name;
        const { hash } = writeJsonFile(abs, data, file.indent, file.trailingNewline);
        return {
          vault: v.id,
          name: input.name,
          created: !exists,
          active: typeof data.active === "string" ? data.active : null,
          count: Object.keys(ws).length,
          content_hash: hash,
        };
      },
    }),
  ];
}
