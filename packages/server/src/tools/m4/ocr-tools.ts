// Domain 15 — OCR / Text Extractor (G2.1). Both tools are read-side (they extract
// text, never mutate the vault) and proxy to the Text Extractor plugin via the
// companion bridge using the longer OCR timeout. ocr_bulk resolves its candidate
// set server-side and ACL-filters it before the bridge call; it overrides its
// throttle scope class to `bulk` and ALWAYS requires human confirmation (a bulk HITL
// floor: OCR is expensive). Plugin id is "text-extractor".
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { requireConfirmation } from "../../vault/hitl";
import { noteExists } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

const DEFAULT_EXTS = [".pdf", ".png", ".jpg", ".jpeg", ".tiff"];

export function buildOcrTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "ocr_attachment",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Run OCR on a single image or PDF attachment via the Text Extractor bridge. Returns extracted text (cached by the plugin per file+model).",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath, force: z.boolean().default(false) })
        .strict(),
      requiredScopes: ["read:ocr"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        if (!noteExists(resolveVaultPath(v.root, rel)).exists)
          throw err.noteNotFound("attachment not found", { path: rel });
        const { client } = openBridge(deps, v.id, "text-extractor");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/ocr/attachment",
          body: { path: rel, force: input.force },
          plugin: "text-extractor",
          timeoutMs: bridgeTimeouts(deps, v.id).ocrTimeoutMs,
        });
        return { vault: v.id, path: rel, ...result };
      },
    }),

    defineTool({
      name: "ocr_bulk",
      description:
        "OCR a batch of attachments via the Text Extractor bridge. Resolves and ACL-filters the candidate set server-side; requires confirmation past 20 files.",
      inputSchema: z
        .object({
          vault: VaultId,
          paths: z.array(VaultPath).optional(),
          root: VaultPath.optional(),
          extensions: z.array(z.string()).optional(),
          force: z.boolean().optional(),
          max_concurrent: z.number().int().min(1).max(4).optional(),
        })
        .strict(),
      requiredScopes: ["read:ocr"],
      // Bulk OCR is expensive: throttle at the bulk tier and floor it behind human
      // confirmation like every other bulk tool, without making this read-side tool
      // mutating (a bulk:* scope would). read:ocr still governs the grant + read ACL.
      scopeClass: "bulk",
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.root ? normalizeVaultPath(input.root) : undefined;
        if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root);
        const exts = input.extensions ?? DEFAULT_EXTS;

        let candidates: string[];
        if (input.paths?.length) {
          candidates = input.paths.map(normalizeVaultPath);
          for (const p of candidates) enforcePathAcl(ctx.acl, "read", p, v.root);
        } else {
          candidates = walkVault(v.root, { sub, extensions: exts })
            .map((e) => e.relPath)
            .filter((rel) => readableRel(ctx.acl, rel));
        }

        requireConfirmation(ctx, "ocr_bulk", input, true, {
          count: candidates.length,
        });

        const { client } = openBridge(deps, v.id, "text-extractor");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/ocr/bulk",
          body: {
            paths: candidates,
            force: input.force ?? false,
            max_concurrent: input.max_concurrent ?? 2,
          },
          plugin: "text-extractor",
          timeoutMs: bridgeTimeouts(deps, v.id).ocrTimeoutMs,
        });
        return { vault: v.id, requested: candidates.length, ...result };
      },
    }),
  ];
}
