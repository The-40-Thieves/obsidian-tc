// Domain 30 — Obsidian Git bridge (THE-378). Agent-driven git flows through the same
// ACL/HITL pipeline as every other write instead of shelling out to `git` (which would bypass
// ACL scoping entirely). Read side (status/diff/log) carries read:git; stage carries write:git;
// commit carries execute:git — the execute family is a hardcoded HITL floor (scopes.ts), so a
// commit ALWAYS requires a human elicit token: it is irreversible-in-effect from the agent's
// perspective. Repo-wide surfaces (status/log) reveal paths a read whitelist may hide, so they
// fail closed under one (THE-270 contract, matching list_templates/search_dql).
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readEnumerationUnrestricted } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildGitTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "git_status",
      description:
        "Working-tree status of the vault's git repo (changed/staged/conflicted), via the Obsidian Git companion bridge. Unavailable under a read whitelist (repo status enumerates every path).",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (!readEnumerationUnrestricted(ctx.acl))
          throw err.aclDenied("git_status is unavailable under a read whitelist", {
            tool: "git_status",
          });
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/status",
          plugin: "git",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "git_diff",
      description:
        "Unified diff for one vault file (working tree, or the staged copy with staged: true), via the Obsidian Git companion bridge.",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath, staged: z.boolean().default(false) })
        .strict(),
      requiredScopes: ["read:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/diff",
          body: { path: rel, staged: input.staged },
          plugin: "git",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, staged: input.staged, ...result };
      },
    }),

    defineTool({
      name: "git_log",
      description:
        "Recent commits of the vault's git repo (hash/message/author/date), via the Obsidian Git companion bridge. Unavailable under a read whitelist (log messages enumerate paths).",
      inputSchema: z
        .object({ vault: VaultId, limit: z.number().int().positive().max(100).default(20) })
        .strict(),
      requiredScopes: ["read:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (!readEnumerationUnrestricted(ctx.acl))
          throw err.aclDenied("git_log is unavailable under a read whitelist", {
            tool: "git_log",
          });
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/log",
          body: { limit: input.limit },
          plugin: "git",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "git_stage",
      description:
        "Stage vault files for the next commit, via the Obsidian Git companion bridge. Write-family: the readOnly kill switch applies.",
      inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(200) }).strict(),
      requiredScopes: ["write:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rels = input.paths.map((p) => normalizeVaultPath(p));
        for (const rel of rels) enforcePathAcl(ctx.acl, "write", rel, v.root);
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/stage",
          body: { paths: rels },
          plugin: "git",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "git_commit",
      description:
        "Commit the staged changes of the vault's git repo. Always requires human confirmation (execute:git is a HITL-floor family) — a commit is irreversible-in-effect from the agent's side.",
      inputSchema: z.object({ vault: VaultId, message: z.string().min(3).max(2000) }).strict(),
      requiredScopes: ["execute:git"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/commit",
          body: { message: input.message },
          plugin: "git",
          // commits can be slow on large repos — reuse the long bridge budget.
          timeoutMs: bridgeTimeouts(deps, v.id).templaterTimeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),
  ];
}
