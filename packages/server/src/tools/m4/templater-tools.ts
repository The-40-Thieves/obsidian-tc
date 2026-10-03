// Domain 13 — Templater (G2.1). list_templates is a read-side bridge introspection
// (read:templater, no HITL). execute_template expands a template (which can run
// arbitrary user JS) and writes the result, so it carries write:templater — a
// hardcoded HITL floor (scopes.ts) — meaning dispatch ALWAYS requires a human
// elicit token before the handler runs. Template expansion is never silently
// executable. Uses the longer templater timeout (expansion can be slow).
import { err, ObsidianTcError, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readEnumerationUnrestricted } from "../../vault/acl-read-filter";
import { noteExists, readNote } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { applyWriteBatch } from "../../vault/write-batch";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

// THE-417: both tools proxy the Templater companion route's own JSON verbatim
// (`{ vault, ...result }` / `{ vault, template, target, ...result }`) — arbitrary plugin JSON
// (e.g. execute_template's created_at/content_hash/expanded_size are the plugin's own fields), so
// .passthrough() is the honest schema beyond what the handler itself guarantees.
const ListTemplatesOutput = z.object({ vault: z.string() }).passthrough();
const ExecuteTemplateOutput = z
  .object({ vault: z.string(), template: z.string(), target: z.string() })
  .passthrough();

/** Provenance frontmatter stamp for a note Templater just CREATED (never one it replaced), added
 *  after the plugin wrote it. Fail-open: a note that cannot be re-read or re-written keeps what
 *  Templater produced. Returns the new content hash, or undefined when nothing changed. */
function stampCreatedNote(
  deps: M4Deps,
  ctx: CallerContext,
  vaultId: string,
  root: string,
  rel: string,
): { contentHash?: string; skipped?: "concurrent_modification" } | undefined {
  const stamp = deps.provenanceStamp;
  if (!stamp?.frontmatter) return undefined;
  try {
    const abs = resolveVaultPath(root, rel);
    const { raw } = readNote(abs);
    const stamped = stamp.stampNewNote(raw, vaultId, ctx);
    if (stamped === raw) return undefined;
    applyWriteBatch([{ abs, rel, content: stamped, prevRaw: raw, createDirs: false }]);
    deps.reindex?.(vaultId, rel, stamped);
    return { contentHash: contentHash(stamped) };
  } catch (e) {
    if (e instanceof ObsidianTcError && e.code === "concurrent_modification")
      return { skipped: "concurrent_modification" };
    return undefined;
  }
}

export function buildTemplaterTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_templates",
      domain: "automation",
      description:
        "List available Templater templates with parsed metadata (user functions, parameters), via the companion bridge. Domain: automation.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: ListTemplatesOutput,
      requiredScopes: ["read:templater"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // Template paths + parsed user-function bodies are vault content the read ACL governs, but
        // the plugin-defined result shape is not reliably path-attributable — so under a read
        // whitelist, refuse wholesale (THE-270), matching search_dql's fail-closed contract.
        if (!readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes))
          throw err.aclDenied("list_templates is unavailable under a read whitelist", {
            tool: "list_templates",
          });
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
      domain: "automation",
      vaultArg: "vault",
      pathAcl: (input) => [
        { op: "read", path: input.template },
        { op: "write", path: input.target },
      ],
      description:
        "Run a Templater template and write the expanded output to a target path. Always requires human confirmation (write:templater is a HITL floor) because templates can execute arbitrary user JavaScript. Domain: automation.",
      inputSchema: z
        .object({
          vault: VaultId,
          template: VaultPath,
          target: VaultPath,
          args: z.record(z.string(), z.unknown()).optional(),
          overwrite: z.boolean().default(false),
        })
        .strict(),
      outputSchema: ExecuteTemplateOutput,
      requiredScopes: ["write:templater"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const template = normalizeVaultPath(input.template);
        const target = normalizeVaultPath(input.target);
        enforcePathAcl(ctx.acl, "read", template, v.root, ctx.grantedScopes);
        enforcePathAcl(ctx.acl, "write", target, v.root, ctx.grantedScopes);
        // THE-289: Templater writes <target>.md and its create API silently clobbers/dups an
        // existing file, so honor overwrite server-side (authoritative, independent of the
        // companion version): refuse when the resolved target already exists and overwrite is off.
        const targetFile = target.endsWith(".md") ? target : `${target}.md`;
        const existed = noteExists(resolveVaultPath(v.root, targetFile)).exists;
        if (!input.overwrite && existed)
          throw err.noteExists("target already exists; set overwrite to replace it", {
            path: targetFile,
          });
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
        // Only a note this call created is stamped: `overwrite` over an existing target is not.
        const stampResult = existed
          ? undefined
          : stampCreatedNote(deps, ctx, v.id, v.root, targetFile);
        return {
          vault: v.id,
          template,
          target,
          ...result,
          // A companion that reports the hash of what it wrote must not contradict the stamp.
          ...(stampResult?.contentHash !== undefined && typeof result.content_hash === "string"
            ? { content_hash: stampResult.contentHash }
            : {}),
          ...(stampResult?.skipped
            ? { provenance_stamp: { applied: false, reason: stampResult.skipped } }
            : {}),
        };
      },
    }),
  ];
}
