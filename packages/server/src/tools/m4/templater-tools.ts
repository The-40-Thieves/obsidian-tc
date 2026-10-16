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
import {
  assertBridgePathReadable,
  filterBridgeResultItems,
  readEnumerationUnrestricted,
} from "../../vault/acl-read-filter";
import { noteExists, readNote } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { applyWriteBatch } from "../../vault/write-batch";
import { defineTool } from "../m1/define";
import {
  bridgeTimeouts,
  effectCommittedIncompatible,
  type M4Deps,
  openBridge,
  parseBridgePayload,
} from "./shared";

const TemplateRow = z.object({ path: z.string(), name: z.string() });
const ExecuteTemplateBridge = z.object({ target: z.string().min(1), created_at: z.string() });

const ListTemplatesOutput = z
  .object({ vault: z.string(), items: z.array(TemplateRow), total: z.number().int() })
  .strict();
const ExecuteTemplateOutput = z
  .object({
    vault: z.string(),
    template: z.string(),
    target: z.string(),
    created_at: z.string(),
    content_hash: z.string().optional(),
    provenance_stamp: z
      .object({ applied: z.literal(false), reason: z.literal("concurrent_modification") })
      .optional(),
  })
  .strict();

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
        const filtered = filterBridgeResultItems(ctx.acl, v.root, ctx.grantedScopes, result, {
          tool: "list_templates",
        });
        const items = (filtered.items as unknown[]).map((row) =>
          parseBridgePayload(TemplateRow, row, "templater"),
        );
        return {
          vault: v.id,
          items,
          total: items.length,
        };
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
        "Run a Templater template and write the expanded output to a target path. Returns the vault-relative path Templater actually created. Always requires human confirmation (write:templater is a HITL floor) because templates can execute arbitrary user JavaScript. Domain: automation.",
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
        ctx.markEffectCommitted?.();
        // The effect has happened whatever the acknowledgement says, so stamp before reading it.
        // Only the REQUESTED path is stamped: it is the one this call write-checked and saw absent,
        // so it is the only one known to be a note this call created. The companion-reported path
        // is untrusted: it can name a note the caller cannot write, or one that already existed.
        // `overwrite` over an existing target is never stamped.
        const stampResult = existed
          ? undefined
          : stampCreatedNote(deps, ctx, v.id, v.root, targetFile);
        const payload = parseBridgePayload(ExecuteTemplateBridge, result, "templater", {
          effectCommitted: true,
        });
        const unusableAck = (message: string) => effectCommittedIncompatible(message, "templater");
        let reported: string;
        try {
          reported = normalizeVaultPath(payload.target);
        } catch {
          throw unusableAck("companion reported an invalid created path");
        }
        if (reported === "") throw unusableAck("companion reported an empty created path");
        // Older companions echo the requested target back without the `.md` Templater appended.
        const createdTarget = reported === target ? targetFile : reported;
        // The requested target was write-checked before the call; a caller may write a folder it
        // cannot read, and must not see a successful run reported as a denial.
        if (createdTarget !== targetFile)
          try {
            assertBridgePathReadable(
              ctx.acl,
              v.root,
              ctx.grantedScopes,
              { path: createdTarget },
              { tool: "execute_template" },
            );
          } catch (e) {
            if (e instanceof ObsidianTcError)
              throw new ObsidianTcError(e.code, e.message, {
                ...e.details,
                effect_committed: true,
              });
            throw e;
          }
        // The stamp's hash and skip reason describe the requested path; report them only for it.
        const reportedStamp = createdTarget === targetFile ? stampResult : undefined;
        return {
          vault: v.id,
          template,
          target: createdTarget,
          created_at: payload.created_at,
          ...(reportedStamp?.contentHash === undefined
            ? {}
            : { content_hash: reportedStamp.contentHash }),
          ...(reportedStamp?.skipped
            ? { provenance_stamp: { applied: false, reason: reportedStamp.skipped } }
            : {}),
        };
      },
    }),
  ];
}
