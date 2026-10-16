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
import { applyTrailers } from "../../provenance/stamp";
import { enforcePathAcl } from "../../vault/acl-path";
import { filterBridgeItemsByAcl, readEnumerationUnrestricted } from "../../vault/acl-read-filter";
import { gitCommitState } from "../../vault/git-state";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge, parseBridgePayload } from "./shared";

// Project only the fields produced by this repository's companion routes. A companion is a trust
// boundary: newly added or compromised response fields must not become public tool output by default.
const GitChangedRow = z.object({
  path: z.string().optional(),
  working_dir: z.string().optional(),
  index: z.string().optional(),
});
const GitStagedRow = z.object({ path: z.string().optional(), index: z.string().optional() });
const GitStatusBridge = z.object({
  paths_relative_to_vault: z.literal(true),
  changed: z.array(z.unknown()).default([]),
  staged: z.array(z.unknown()).default([]),
  conflicted: z.array(z.unknown()).default([]),
});
type GitStatusBridgePayload = z.infer<typeof GitStatusBridge>;
const GitDiffBridge = z.object({ diff: z.string() });
const GitLogRow = z.object({
  hash: z.string(),
  message: z.string(),
  date: z.string(),
  author: z.string(),
});
const GitLogBridge = z.object({ entries: z.array(GitLogRow) });
const GitStageBridge = z.object({ staged: z.number().int().nonnegative() });
const GitCommitBridge = z.object({
  committed: z.number().nullable(),
  fired_at: z.string(),
});

const GitStatusOutput = z
  .object({
    vault: z.string(),
    changed: z.array(GitChangedRow),
    staged: z.array(GitStagedRow),
    conflicted: z.array(z.string()),
  })
  .strict();
const GitDiffOutput = z
  .object({ vault: z.string(), path: z.string(), staged: z.boolean(), diff: z.string() })
  .strict();
const GitLogOutput = z.object({ vault: z.string(), entries: z.array(GitLogRow) }).strict();
const GitStageOutput = z
  .object({ vault: z.string(), staged: z.number().int().nonnegative() })
  .strict();
const GitCommitOutput = z
  .object({
    vault: z.string(),
    committed: z.number().nullable(),
    fired_at: z.string(),
    stamped_trailers: z.array(z.string()).optional(),
  })
  .strict();

function parseGitStatus(value: unknown): GitStatusBridgePayload {
  if (typeof value !== "object" || value === null || !("paths_relative_to_vault" in value))
    throw err.pluginIncompatible(
      "companion plugin predates vault-relative git paths; update the companion plugin inside Obsidian",
      { plugin: "git" },
    );
  return parseBridgePayload(GitStatusBridge, value, "git");
}

/** Paths the bridge reports as staged, for matching a commit to recorded writes. Best effort: a
 *  status that fails or has an unexpected shape means no trailers, never a failed commit. */
async function stagedPaths(deps: M4Deps, vaultId: string): Promise<string[]> {
  try {
    const { client } = openBridge(deps, vaultId, "git");
    const result = await client.request<Record<string, unknown>>({
      method: "POST",
      path: "/git/status",
      plugin: "git",
      timeoutMs: bridgeTimeouts(deps, vaultId).timeoutMs,
    });
    if (!("paths_relative_to_vault" in result)) {
      process.stderr.write(
        "[obsidian-tc] cannot stamp git provenance trailers: companion plugin predates vault-relative git paths; update the companion plugin inside Obsidian\n",
      );
      return [];
    }
    const status = parseGitStatus(result);
    return (Array.isArray(status.staged) ? status.staged : [])
      .flatMap((row) => {
        const parsed = GitStagedRow.safeParse(row);
        return parsed.success && parsed.data.path ? [parsed.data.path] : [];
      })
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

export function buildGitTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "git_status",
      domain: "git",
      description:
        "Working-tree status of the vault's git repo (changed/staged/conflicted), via the Obsidian Git companion bridge. Unavailable under a read whitelist (repo status enumerates every path).",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: GitStatusOutput,
      requiredScopes: ["read:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (!readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes))
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
        const status = parseGitStatus(result);
        const changed = filterBridgeItemsByAcl(ctx.acl, v.root, ctx.grantedScopes, status.changed, {
          tool: "git_status",
        }).map((row) => parseBridgePayload(GitChangedRow, row, "git"));
        const staged = filterBridgeItemsByAcl(ctx.acl, v.root, ctx.grantedScopes, status.staged, {
          tool: "git_status",
        }).map((row) => parseBridgePayload(GitStagedRow, row, "git"));
        const conflicted = filterBridgeItemsByAcl(
          ctx.acl,
          v.root,
          ctx.grantedScopes,
          status.conflicted,
          { tool: "git_status", barePath: true },
        ).map((row) => parseBridgePayload(z.string(), row, "git"));
        return {
          vault: v.id,
          changed,
          staged,
          conflicted,
        };
      },
    }),

    defineTool({
      name: "git_diff",
      domain: "git",
      pathAcl: (input) => (input.path ? [{ op: "read", path: input.path }] : []),
      description:
        "Unified diff for one vault file (working tree, or the staged copy with staged: true), via the Obsidian Git companion bridge.",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath, staged: z.boolean().default(false) })
        .strict(),
      outputSchema: GitDiffOutput,
      requiredScopes: ["read:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/diff",
          body: { path: rel, staged: input.staged },
          plugin: "git",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        const payload = parseBridgePayload(GitDiffBridge, result, "git");
        return {
          vault: v.id,
          path: rel,
          staged: input.staged,
          diff: payload.diff,
        };
      },
    }),

    defineTool({
      name: "git_log",
      domain: "git",
      description:
        "Recent commits of the vault's git repo (hash/message/author/date), via the Obsidian Git companion bridge. Unavailable under a read whitelist (log messages enumerate paths).",
      inputSchema: z
        .object({ vault: VaultId, limit: z.number().int().positive().max(100).default(20) })
        .strict(),
      outputSchema: GitLogOutput,
      requiredScopes: ["read:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (!readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes))
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
        const payload = parseBridgePayload(GitLogBridge, result, "git");
        return {
          vault: v.id,
          entries: payload.entries,
        };
      },
    }),

    defineTool({
      name: "git_stage",
      domain: "git",
      vaultArg: "vault",
      pathAcl: (input) => input.paths.map((p) => ({ op: "write" as const, path: p })),
      description:
        "Stage vault files for the next commit, via the Obsidian Git companion bridge. Write-family: the readOnly kill switch applies.",
      inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(200) }).strict(),
      outputSchema: GitStageOutput,
      requiredScopes: ["write:git"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rels = input.paths.map((p) => normalizeVaultPath(p));
        for (const rel of rels) enforcePathAcl(ctx.acl, "write", rel, v.root, ctx.grantedScopes);
        const { client } = openBridge(deps, v.id, "git");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/stage",
          body: { paths: rels },
          plugin: "git",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        ctx.markEffectCommitted?.();
        const payload = parseBridgePayload(GitStageBridge, result, "git", {
          effectCommitted: true,
        });
        return {
          vault: v.id,
          staged: payload.staged,
        };
      },
    }),

    defineTool({
      name: "git_commit",
      domain: "git",
      vaultArg: "vault",
      description:
        "Commit the staged changes of the vault's git repo. Always requires human confirmation (execute:git is a HITL-floor family) — a commit is irreversible-in-effect from the agent's side.",
      inputSchema: z.object({ vault: VaultId, message: z.string().min(3).max(2000) }).strict(),
      outputSchema: GitCommitOutput,
      requiredScopes: ["execute:git"],
      // HEAD and the staged index of the vault's own repo (vault/git-state.ts).
      confirmationTargets: (_input, { root }) => (root ? gitCommitState(root) : null),
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "git");
        // provenance.stamp.gitTrailers (off by default): trailers for the recorded writes whose
        // current bytes are staged. The caller's own message is kept, minus any Obsidian-TC-*
        // trailer it wrote, so a trailer under that prefix is always the server's.
        const stamp = deps.provenanceStamp;
        const trailers = stamp?.gitTrailers
          ? await stamp.commitTrailers(v.id, v.root, await stagedPaths(deps, v.id))
          : [];
        const message = stamp?.gitTrailers ? applyTrailers(input.message, trailers) : input.message;
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/git/commit",
          body: { message },
          plugin: "git",
          // commits can be slow on large repos — reuse the long bridge budget.
          timeoutMs: bridgeTimeouts(deps, v.id).templaterTimeoutMs,
        });
        ctx.markEffectCommitted?.();
        const payload = parseBridgePayload(GitCommitBridge, result, "git", {
          effectCommitted: true,
        });
        return {
          vault: v.id,
          committed: payload.committed,
          fired_at: payload.fired_at,
          ...(trailers.length > 0 ? { stamped_trailers: trailers } : {}),
        };
      },
    }),
  ];
}
