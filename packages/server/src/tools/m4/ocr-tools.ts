// Domain 15 — OCR / Text Extractor (G2.1). Both tools are read-side (they extract
// text, never mutate the vault) and proxy to the Text Extractor plugin via the
// companion bridge using the longer OCR timeout. ocr_bulk resolves its candidate
// set server-side and ACL-filters it before the bridge call; it overrides its
// throttle scope class to `bulk` and ALWAYS requires human confirmation (a bulk HITL
// floor: OCR is expensive). Plugin id is "text-extractor".
import { ElicitToken, err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../acl";
import { fingerprintTargets } from "../../elicit-drift";
import { argsHash } from "../../hash";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { requireConfirmation } from "../../vault/hitl";
import { noteExists } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

const DEFAULT_EXTS = [".pdf", ".png", ".jpg", ".jpeg", ".tiff"];

// THE-417: both tools proxy the Text Extractor companion route's own JSON verbatim
// (`{ vault, ...result }` / `{ vault, requested, ...result }`) — arbitrary plugin JSON, so
// .passthrough() is the honest schema beyond the fields the handler itself guarantees.
const OcrAttachmentOutput = z.object({ vault: z.string(), path: z.string() }).passthrough();
const OcrBulkOutput = z.object({ vault: z.string(), requested: z.number().int() }).passthrough();

/** The ACL-filtered attachment paths an `ocr_bulk` call would OCR, from explicit `paths` or a walk. */
function ocrCandidates(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  input: { paths?: string[]; root?: string; extensions?: string[] },
): string[] {
  const sub = input.root ? normalizeVaultPath(input.root) : undefined;
  if (sub) enforcePathAcl(acl, "read", sub, root, grantedScopes);
  if (input.paths?.length) {
    const candidates = input.paths.map(normalizeVaultPath);
    for (const p of candidates) enforcePathAcl(acl, "read", p, root, grantedScopes);
    return candidates;
  }
  return walkVault(root, { sub, extensions: input.extensions ?? DEFAULT_EXTS })
    .map((e) => e.relPath)
    .filter((rel) => readableRel(acl, rel, grantedScopes));
}

export function buildOcrTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "ocr_attachment",
      domain: "attachments",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Run OCR on a single image or PDF attachment via the Text Extractor bridge. Returns extracted text (cached by the plugin per file+model). Domain: attachments.",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath, force: z.boolean().default(false) })
        .strict(),
      outputSchema: OcrAttachmentOutput,
      requiredScopes: ["read:ocr"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
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
      domain: "attachments",
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
          // THE-824: advertised so a caller can discover the HITL confirmation parameter via
          // describe_capability — stripped off rawArgs into ctx.elicitToken before this schema
          // ever validates it (mcp/server.ts), so declaring it here changes nothing about dispatch.
          // Deliberately NOT paired with conditionallyDestructive: this tool is genuinely
          // read-only (requiredScopes: ["read:ocr"], no vault mutation ever), and the MCP spec
          // says destructiveHint is meaningful only when readOnlyHint == false — flipping it here
          // would trade one false statement for another (a tool cannot both "not modify its
          // environment" and "perform destructive updates").
          elicit_token: ElicitToken.optional(),
        })
        .strict(),
      outputSchema: OcrBulkOutput,
      requiredScopes: ["read:ocr"],
      // Bulk OCR is expensive: throttle at the bulk tier and floor it behind human
      // confirmation like every other bulk tool, without making this read-side tool
      // mutating (a bulk:* scope would). read:ocr still governs the grant + read ACL.
      scopeClass: "bulk",
      // The attachments a run would read: a file replaced, or one added under `root`, moves it.
      confirmationTargets: (input, { ctx, root }) =>
        root
          ? (fingerprintTargets(root, ocrCandidates(root, ctx.acl, ctx.grantedScopes, input)) ??
            argsHash("state", []))
          : null,
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const candidates = ocrCandidates(v.root, ctx.acl, ctx.grantedScopes, input);

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
