// Domain 16 — Smart Context bundling (G2.1). Both tools are filesystem-only and
// pure (read:context, no plugin, no HITL): they aggregate notes into a single
// markdown or XML bundle for handing a folder/selection to an LLM as one blob.
// ACL-filtered to the read-visible set; byte- and file-count-budgeted with an
// explicit `truncated` flag (no silent drops).
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { parseNote } from "../../vault/frontmatter";
import { readNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M4Deps } from "./shared";

type Format = "markdown" | "xml";

function readable(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl || acl.readPaths === undefined) return true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function block(rel: string, body: string, format: Format): string {
  return format === "xml"
    ? `<document path="${escapeXmlAttr(rel)}">\n${body}\n</document>\n`
    : `## ${rel}\n\n${body}\n\n`;
}

interface BundleResult {
  bundle: string;
  file_count: number;
  total_bytes: number;
  truncated: boolean;
  files: { path: string; bytes: number }[];
}

// Concatenate (rel, content) entries under a byte budget. `preTruncated` carries a
// file-count cap that already dropped entries upstream.
function buildBundle(
  entries: { rel: string; content: string }[],
  opts: { maxBytes: number; includeFrontmatter: boolean; format: Format; preTruncated: boolean },
): BundleResult {
  const parts: string[] = [];
  const files: { path: string; bytes: number }[] = [];
  let total = 0;
  let truncated = opts.preTruncated;
  for (const e of entries) {
    const body = opts.includeFrontmatter ? e.content : parseNote(e.content).body;
    const text = block(e.rel, body, opts.format);
    const bytes = Buffer.byteLength(text, "utf8");
    if (total + bytes > opts.maxBytes) {
      truncated = true;
      break;
    }
    total += bytes;
    parts.push(text);
    files.push({ path: e.rel, bytes: Buffer.byteLength(e.content, "utf8") });
  }
  return { bundle: parts.join(""), file_count: files.length, total_bytes: total, truncated, files };
}

export function buildBundleTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "bundle_folder",
      description:
        "Aggregate all notes under a folder into a single markdown/XML bundle (Smart Context). ACL-filtered; file-count and byte budgeted with an explicit truncated flag.",
      inputSchema: z
        .object({
          vault: VaultId,
          root: VaultPath,
          max_files: z.number().int().positive().max(500).default(100),
          max_bytes: z.number().int().positive().default(500_000),
          extensions: z.array(z.string()).default([".md"]),
          include_frontmatter: z.boolean().default(true),
          format: z.enum(["markdown", "xml"]).default("markdown"),
        })
        .strict(),
      requiredScopes: ["read:context"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = normalizeVaultPath(input.root);
        enforcePathAcl(ctx.acl, "read", sub, v.root);
        const all = walkVault(v.root, { sub, extensions: input.extensions })
          .map((e) => e.relPath)
          .filter((rel) => readable(ctx.acl, rel));
        const capped = all.slice(0, input.max_files);
        const entries = capped.map((rel) => ({
          rel,
          content: readNote(resolveVaultPath(v.root, rel)).raw,
        }));
        const result = buildBundle(entries, {
          maxBytes: input.max_bytes,
          includeFrontmatter: input.include_frontmatter,
          format: input.format,
          preTruncated: all.length > input.max_files,
        });
        return { vault: v.id, root: sub, ...result };
      },
    }),

    defineTool({
      name: "bundle_files",
      description:
        "Aggregate an explicit list of notes into a single markdown/XML bundle. ACL-filtered; byte budgeted; reports missing_paths for files that do not exist.",
      inputSchema: z
        .object({
          vault: VaultId,
          paths: z.array(VaultPath).min(1).max(200),
          max_bytes: z.number().int().positive().default(500_000),
          include_frontmatter: z.boolean().default(true),
          format: z.enum(["markdown", "xml"]).default("markdown"),
        })
        .strict(),
      requiredScopes: ["read:context"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const entries: { rel: string; content: string }[] = [];
        const missing: string[] = [];
        for (const p of input.paths) {
          const rel = normalizeVaultPath(p);
          enforcePathAcl(ctx.acl, "read", rel, v.root);
          try {
            entries.push({ rel, content: readNote(resolveVaultPath(v.root, rel)).raw });
          } catch {
            missing.push(rel);
          }
        }
        const result = buildBundle(entries, {
          maxBytes: input.max_bytes,
          includeFrontmatter: input.include_frontmatter,
          format: input.format,
          preTruncated: false,
        });
        return { vault: v.id, ...result, ...(missing.length ? { missing_paths: missing } : {}) };
      },
    }),
  ];
}
