// Domain 5 — Links / backlinks / graph (G2.1 r2). Six tools: get_outgoing_links,
// get_backlinks, find_orphans, find_unresolved_links, rewrite_link, prune_hub_links.
// Resolution follows Obsidian (exact path, then basename shortest-path-wins) over
// the read-ACL-visible note set, so notes outside the caller's read scope are
// invisible to the graph. rewrite_link and prune_hub_links default to dry_run
// (preview, no write, no confirmation); a real run (dry_run:false) enforces write
// ACL and gates on requireConfirmation.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../acl";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { parseNote } from "../../vault/frontmatter";
import { requireConfirmation } from "../../vault/hitl";
import { buildVaultIndex, extractLinks, resolveTarget } from "../../vault/links";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { pruneHubLinks } from "../../vault/prune";
import { rewriteLinks } from "../../vault/rewrite";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Read-ACL-visible `.md` note paths (optionally under a folder). */
function readableNotes(root: string, acl: FolderAcl | undefined, sub?: string): string[] {
  return walkVault(root, { sub, extensions: [".md"] })
    .map((e) => e.relPath)
    .filter((rel) => readableRel(acl, rel));
}

function bodyOf(root: string, rel: string): string {
  return parseNote(readNote(resolveVaultPath(root, rel)).raw).body;
}

function normTarget(t: string): string {
  return t.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").trim().toLowerCase();
}

function isExternal(kind: string, target: string): boolean {
  return kind === "markdown" && /^[a-z]+:\/\//i.test(target);
}

// ── schemas ──────────────────────────────────────────────────────────────────

const ScanInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    limit: z.number().int().positive().max(5000).default(500),
  })
  .strict();

const RewriteInput = z
  .object({
    vault: VaultId,
    from_target: z.string().min(1),
    to_target: z.string().min(1),
    folder: VaultPath.optional(),
    include_embeds: z.boolean().default(true),
    dry_run: z.boolean().default(true),
  })
  .strict();

const PruneInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    remove_unresolved: z.boolean().default(true),
    remove_duplicates: z.boolean().default(true),
    dry_run: z.boolean().default(true),
    prev_hash: z.string().optional(),
  })
  .strict();

// ── tools ────────────────────────────────────────────────────────────────────

export function buildLinksTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_outgoing_links",
      description:
        "List a note's outgoing links (code-block links excluded), each resolved to a target path.",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath, include_embeds: z.boolean().default(true) })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });

        const index = buildVaultIndex(readableNotes(v.root, ctx.acl));
        const links = extractLinks(parseNote(readNote(abs).raw).body)
          .filter((l) => !l.inCodeblock)
          .filter((l) => input.include_embeds || l.kind !== "embed")
          .map((l) => {
            const r = resolveTarget(index, l.target);
            return {
              raw: l.raw,
              kind: l.kind,
              target: l.target,
              display: l.display,
              heading: l.heading,
              line: l.line,
              col: l.col,
              resolved: r.resolved,
              target_path: r.target_path ?? null,
              candidates: r.candidates ?? null,
            };
          });
        return {
          vault: v.id,
          path: rel,
          counts: {
            total: links.length,
            resolved: links.filter((l) => l.resolved).length,
            unresolved: links.filter((l) => !l.resolved && !isExternal(l.kind, l.target)).length,
          },
          links,
        };
      },
    }),

    defineTool({
      name: "get_backlinks",
      description: "Find every note that links to the given note, with source line/column.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(5000).default(500),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });

        const paths = readableNotes(v.root, ctx.acl);
        const index = buildVaultIndex(paths);
        const backlinks: Array<Record<string, unknown>> = [];
        let truncated = false;
        for (const p of paths) {
          for (const l of extractLinks(bodyOf(v.root, p))) {
            if (l.inCodeblock) continue;
            const r = resolveTarget(index, l.target);
            if (!r.resolved || r.target_path !== rel) continue;
            if (backlinks.length >= input.limit) {
              truncated = true;
              break;
            }
            backlinks.push({
              source_path: p,
              line: l.line,
              col: l.col,
              raw: l.raw,
              kind: l.kind,
              display: l.display,
            });
          }
          if (truncated) break;
        }
        return { vault: v.id, path: rel, total: backlinks.length, truncated, backlinks };
      },
    }),

    defineTool({
      name: "find_orphans",
      description:
        "Find notes that nothing else links to (optionally also requiring no outgoing links).",
      inputSchema: z
        .object({
          vault: VaultId,
          folder: VaultPath.optional(),
          limit: z.number().int().positive().max(5000).default(500),
          require_no_outgoing: z.boolean().default(false),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const candidates = readableNotes(v.root, ctx.acl, sub);
        const all = readableNotes(v.root, ctx.acl);
        const index = buildVaultIndex(all);
        const linkedTo = new Set<string>();
        const hasOutgoing = new Set<string>();
        for (const p of all) {
          for (const l of extractLinks(bodyOf(v.root, p))) {
            if (l.inCodeblock) continue;
            const r = resolveTarget(index, l.target);
            if (r.resolved && r.target_path && r.target_path !== p) {
              linkedTo.add(r.target_path);
              hasOutgoing.add(p);
            }
          }
        }
        const orphans = candidates.filter(
          (p) => !linkedTo.has(p) && (!input.require_no_outgoing || !hasOutgoing.has(p)),
        );
        return {
          vault: v.id,
          total: orphans.length,
          truncated: orphans.length > input.limit,
          orphans: orphans.slice(0, input.limit),
        };
      },
    }),

    defineTool({
      name: "find_unresolved_links",
      description: "Find internal links that do not resolve to any note (dangling links).",
      inputSchema: ScanInput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const scan = readableNotes(v.root, ctx.acl, sub);
        const index = buildVaultIndex(readableNotes(v.root, ctx.acl));
        const unresolved: Array<Record<string, unknown>> = [];
        let truncated = false;
        for (const p of scan) {
          for (const l of extractLinks(bodyOf(v.root, p))) {
            if (l.inCodeblock) continue;
            if (isExternal(l.kind, l.target)) continue;
            if (l.target === "" || l.target.startsWith("#")) continue;
            if (resolveTarget(index, l.target).resolved) continue;
            if (unresolved.length >= input.limit) {
              truncated = true;
              break;
            }
            unresolved.push({
              source_path: p,
              target: l.target,
              line: l.line,
              col: l.col,
              kind: l.kind,
            });
          }
          if (truncated) break;
        }
        return { vault: v.id, total: unresolved.length, truncated, unresolved };
      },
    }),

    defineTool({
      name: "rewrite_link",
      description:
        "Repoint every link to `from_target` at `to_target` across the vault. Defaults to dry_run; a real run requires confirmation.",
      inputSchema: RewriteInput,
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const paths = readableNotes(v.root, ctx.acl, sub);
        const index = buildVaultIndex(readableNotes(v.root, ctx.acl));
        const fromRes = resolveTarget(index, input.from_target);
        const fromPath = fromRes.resolved ? fromRes.target_path : null;
        const fromLiteral = normTarget(input.from_target);

        const edits: Array<{ rel: string; text: string; count: number }> = [];
        let totalLinks = 0;
        for (const p of paths) {
          const raw = readNote(resolveVaultPath(v.root, p)).raw;
          const { text, count } = rewriteLinks(raw, (target, kind) => {
            if (!input.include_embeds && kind === "embed") return null;
            const match = fromPath
              ? resolveTarget(index, target).target_path === fromPath
              : normTarget(target) === fromLiteral;
            return match ? input.to_target : null;
          });
          if (count > 0) {
            edits.push({ rel: p, text, count });
            totalLinks += count;
          }
        }

        if (!input.dry_run) {
          for (const e of edits) enforcePathAcl(ctx.acl, "write", e.rel, v.root);
          requireConfirmation(ctx, "rewrite_link", input, true, {
            from_target: input.from_target,
            to_target: input.to_target,
            notes: edits.length,
            links: totalLinks,
          });
          for (const e of edits) {
            writeNoteAtomic(resolveVaultPath(v.root, e.rel), e.text, false);
            deps.reindex?.(v.id, e.rel, e.text);
          }
        }
        return {
          vault: v.id,
          dry_run: input.dry_run,
          from_target: input.from_target,
          to_target: input.to_target,
          notes_changed: edits.length,
          links_rewritten: totalLinks,
          changes: edits.map((e) => ({ path: e.rel, count: e.count })),
        };
      },
    }),

    defineTool({
      name: "prune_hub_links",
      description:
        "Prune unresolved and/or duplicate links from a hub note. Defaults to dry_run; a real run requires confirmation.",
      inputSchema: PruneInput,
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });

        const { raw, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });

        const index = buildVaultIndex(readableNotes(v.root, ctx.acl));
        const { text, removed } = pruneHubLinks(raw, index, {
          removeUnresolved: input.remove_unresolved,
          removeDuplicates: input.remove_duplicates,
        });

        if (!input.dry_run && removed.length > 0) {
          enforcePathAcl(ctx.acl, "write", rel, v.root);
          requireConfirmation(ctx, "prune_hub_links", input, true, {
            path: rel,
            removed: removed.length,
          });
          writeNoteAtomic(abs, text, false);
          deps.reindex?.(v.id, rel, text);
        }
        return {
          vault: v.id,
          path: rel,
          dry_run: input.dry_run,
          removed_count: removed.length,
          removed,
          prev_hash: hash,
          content_hash: contentHash(text),
        };
      },
    }),
  ];
}
