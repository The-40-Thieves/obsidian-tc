// Domain 5 — Links / backlinks / graph (G2.1 r2). Six tools: get_outgoing_links,
// get_backlinks, find_orphans, find_unresolved_links, rewrite_link, prune_hub_links.
// Resolution follows Obsidian (exact path, then basename shortest-path-wins) over
// the read-ACL-visible note set, so notes outside the caller's read scope are
// invisible to the graph. rewrite_link and prune_hub_links default to dry_run
// (preview, no write, no confirmation); a real run (dry_run:false) enforces write
// ACL and gates on requireConfirmation.
import { ElicitToken, err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../acl";
import { fingerprintTargets } from "../../elicit-drift";
import {
  enforceMemoryDefenseOnNoteWrite,
  MEMORY_DEFENSE_OFF,
  redactedEcho,
} from "../../experiential/memory-defense";
import { argsHash } from "../../hash";
import type { ToolDefinition } from "../../mcp/registry";
import { DEFAULT_SCAN_LIMIT, nextOffsetCursor, offsetOf } from "../../util/paginate";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { buildVaultIndex, resolveTarget } from "../../vault/links";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { pruneHubLinks } from "../../vault/prune";
import { rewriteLinks } from "../../vault/rewrite";
import { ResponseFormatInput, resolveResponseFormat } from "../response-format";
import {
  type RewriteWarning,
  rewriteWarningsOut,
  rewriteWarningsShape,
  ScanWarnings,
  scanWarningsShape,
} from "../scan-warnings";
import {
  isExternal,
  linksOf,
  originOf,
  readableNotes,
  scanOrphans,
  scanUnresolved,
} from "../wiki-scan";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

// ── helpers ──────────────────────────────────────────────────────────────────

function normTarget(t: string): string {
  return t.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").trim().toLowerCase();
}

// ── output schemas (THE-417 Phase 1) ────────────────────────────────────────
// Written from each handler's RETURN statements, not from ExtractedLink/Resolution/
// PruneResult — those types feed the response but several fields (counts, truncated,
// content_hash) are computed on the way out and do not exist on the source types.

/** Mirrors vault/links.ts's LinkKind. */
const LinkKindSchema = z.enum(["wikilink", "markdown", "embed"]);

/** Mirrors vault/links.ts's LinkSource. Present only on a link written in a note's properties
 *  (Obsidian's frontmatterLinks): `source: "property"` and `property`, the top-level frontmatter
 *  key it sits under. A body link has neither. */
const originShape = {
  source: z.literal("property").optional(),
  property: z.string().optional(),
};

// GH #1027: response_format=concise drops raw/kind/display/col and omits null heading/target_path/
// candidates, so those are optional here; a detailed response always carries all of them.
const GetOutgoingLinksOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  path: z.string(),
  counts: z.object({
    total: z.number().int(),
    resolved: z.number().int(),
    unresolved: z.number().int(),
  }),
  links: z.array(
    z.object({
      raw: z.string().optional(),
      kind: LinkKindSchema.optional(),
      target: z.string(),
      display: z.string().nullable().optional(),
      heading: z.string().nullable().optional(),
      line: z.number().int(),
      col: z.number().int().optional(),
      ...originShape,
      resolved: z.boolean(),
      target_path: z.string().nullable().optional(),
      candidates: z.array(z.string()).nullable().optional(),
    }),
  ),
});

// GH #1027: response_format=concise keeps {source_path, line} per backlink.
const GetBacklinksOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  path: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  backlinks: z.array(
    z.object({
      source_path: z.string(),
      line: z.number().int(),
      col: z.number().int().optional(),
      raw: z.string().optional(),
      kind: LinkKindSchema.optional(),
      display: z.string().nullable().optional(),
      ...originShape,
    }),
  ),
});

const FindOrphansOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  orphans: z.array(z.string()),
});

const FindUnresolvedLinksOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  unresolved: z.array(
    z.object({
      source_path: z.string(),
      target: z.string(),
      line: z.number().int(),
      // GH #1027: response_format=concise keeps {source_path, target, line} and drops these two.
      col: z.number().int().optional(),
      kind: LinkKindSchema.optional(),
      ...originShape,
    }),
  ),
});

// GH #1027: response_format=concise drops the from_target echo, the to_target echo unless the
// memoryDefense scan redacted it, and (on a real run) the per-note change list, whose totals
// notes_changed / links_rewritten stay. A dry run keeps `changes`: it is the preview.
const RewriteLinkOutput = z.object({
  vault: z.string(),
  dry_run: z.boolean(),
  from_target: z.string().optional(),
  to_target: z.string().optional(),
  notes_changed: z.number().int(),
  links_rewritten: z.number().int(),
  changes: z.array(z.object({ path: z.string(), count: z.number().int() })).optional(),
  ...rewriteWarningsShape,
});

// GH #1027: response_format=concise on a real run drops the removed[] list (removed_count stays) and
// prev_hash; a dry run keeps both, since they are what the confirming call needs.
const PruneHubLinksOutput = z.object({
  vault: z.string(),
  path: z.string(),
  dry_run: z.boolean(),
  removed_count: z.number().int(),
  removed: z
    .array(
      z.object({
        target: z.string(),
        line: z.number().int(),
        reason: z.enum(["unresolved", "duplicate"]),
      }),
    )
    .optional(),
  prev_hash: z.string().optional(),
  content_hash: z.string(),
});

// ── schemas ──────────────────────────────────────────────────────────────────

const ScanInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    limit: z.number().int().positive().max(5000).default(DEFAULT_SCAN_LIMIT),
    cursor: z.string().optional(),
    ...ResponseFormatInput,
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
    // THE-824: advertised so a caller can discover the HITL confirmation parameter via
    // describe_capability — stripped off rawArgs into ctx.elicitToken before this schema ever
    // validates it (mcp/server.ts), so declaring it here changes nothing about dispatch.
    elicit_token: ElicitToken.optional(),
    ...ResponseFormatInput,
  })
  .strict();

/** The edits a `rewrite_link` call would make, computed the same way for the dry run, the real run
 *  and the confirmation's target fingerprint. */
function planLinkRewrite(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
  input: z.infer<typeof RewriteInput>,
): {
  edits: Array<{ rel: string; text: string; count: number }>;
  totalLinks: number;
  warnings: RewriteWarning[];
} {
  const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
  const paths = readableNotes(root, acl, grantedScopes, sub);
  const index = buildVaultIndex(readableNotes(root, acl, grantedScopes));
  const fromRes = resolveTarget(index, input.from_target);
  const fromPath = fromRes.resolved ? fromRes.target_path : null;
  const fromLiteral = normTarget(input.from_target);
  const edits: Array<{ rel: string; text: string; count: number }> = [];
  const warnings: RewriteWarning[] = [];
  let totalLinks = 0;
  for (const p of paths) {
    const raw = readNote(resolveVaultPath(root, p)).raw;
    const rw = rewriteLinks(raw, (target, kind) => {
      if (!input.include_embeds && kind === "embed") return null;
      const match = fromPath
        ? resolveTarget(index, target).target_path === fromPath
        : normTarget(target) === fromLiteral;
      return match ? input.to_target : null;
    });
    for (const w of rw.warnings) warnings.push({ path: p, ...w });
    if (rw.count > 0) {
      edits.push({ rel: p, text: rw.text, count: rw.count });
      totalLinks += rw.count;
    }
  }
  return { edits, totalLinks, warnings };
}

const PruneInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    remove_unresolved: z.boolean().default(true),
    remove_duplicates: z.boolean().default(true),
    dry_run: z.boolean().default(true),
    prev_hash: z.string().optional(),
    // THE-824: see RewriteInput's elicit_token above.
    elicit_token: ElicitToken.optional(),
    ...ResponseFormatInput,
  })
  .strict();

// ── tools ────────────────────────────────────────────────────────────────────

export function buildLinksTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_outgoing_links",
      domain: "links",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "List a note's outgoing links (code-block links excluded), each resolved to a target path. Quoted wikilinks in its properties count too, tagged source=property with the property name. response_format=concise returns {target, line, resolved} per link, plus heading, target_path and candidates when present, without raw, kind, display and col.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          include_embeds: z.boolean().default(true),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: GetOutgoingLinksOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });

        const index = buildVaultIndex(readableNotes(v.root, ctx.acl, ctx.grantedScopes));
        const warnings = new ScanWarnings();
        const links = warnings
          .links(readNote(abs).raw, rel)
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
              ...originOf(l),
              resolved: r.resolved,
              target_path: r.target_path ?? null,
              candidates: r.candidates ?? null,
            };
          });
        const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
        return {
          ...warnings.out(),
          vault: v.id,
          path: rel,
          counts: {
            total: links.length,
            resolved: links.filter((l) => l.resolved).length,
            unresolved: links.filter((l) => !l.resolved && !isExternal(l.kind, l.target)).length,
          },
          links: concise
            ? links.map((l) => ({
                target: l.target,
                line: l.line,
                ...originOf(l),
                resolved: l.resolved,
                ...(l.heading !== null ? { heading: l.heading } : {}),
                ...(l.target_path !== null ? { target_path: l.target_path } : {}),
                ...(l.candidates !== null ? { candidates: l.candidates } : {}),
              }))
            : links,
        };
      },
    }),

    defineTool({
      name: "get_backlinks",
      domain: "links",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Find every note that links to the given note, with source line/column. A quoted wikilink in a property counts, tagged source=property with the property name. A note whose frontmatter is not valid YAML does not fail the scan: its body is still read and it is named in `warnings`. response_format=concise returns {source_path, line} per backlink, without col, raw, kind and display.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(5000).default(DEFAULT_SCAN_LIMIT),
          cursor: z.string().optional(),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: GetBacklinksOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });

        const paths = readableNotes(v.root, ctx.acl, ctx.grantedScopes);
        const index = buildVaultIndex(paths);
        const backlinks: Array<Record<string, unknown>> = [];
        const warnings = new ScanWarnings();
        let truncated = false;
        const skip = offsetOf(input.cursor);
        let seen = 0;
        for (const p of paths) {
          for (const l of linksOf(v.root, p, warnings)) {
            if (l.inCodeblock) continue;
            const r = resolveTarget(index, l.target);
            if (!r.resolved || r.target_path !== rel) continue;
            if (seen++ < skip) continue;
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
              ...originOf(l),
            });
          }
          if (truncated) break;
        }
        const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
        return {
          ...warnings.out(),
          vault: v.id,
          path: rel,
          total: backlinks.length,
          truncated,
          next_cursor: nextOffsetCursor(skip, backlinks.length, truncated),
          backlinks: concise
            ? backlinks.map((b) => ({
                source_path: b.source_path,
                line: b.line,
                ...(b.source === "property" ? { source: b.source, property: b.property } : {}),
              }))
            : backlinks,
        };
      },
    }),

    defineTool({
      name: "find_orphans",
      domain: "links",
      description:
        "Find notes that nothing else links to (optionally also requiring no outgoing links); a link in a property counts. A note whose frontmatter is not valid YAML does not fail the scan: its body is still read and it is named in `warnings`.",
      inputSchema: z
        .object({
          vault: VaultId,
          folder: VaultPath.optional(),
          limit: z.number().int().positive().max(5000).default(DEFAULT_SCAN_LIMIT),
          cursor: z.string().optional(),
          require_no_outgoing: z.boolean().default(false),
        })
        .strict(),
      outputSchema: FindOrphansOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const warnings = new ScanWarnings();
        const orphans = scanOrphans(
          {
            root: v.root,
            acl: ctx.acl,
            grantedScopes: ctx.grantedScopes,
            wikiFolder: v.wikiFolder,
            wikiFolders: v.wikiFolders,
            rawFolders: v.rawFolders,
          },
          warnings,
          { folder: sub, requireNoOutgoing: input.require_no_outgoing },
        );
        const skip = offsetOf(input.cursor);
        const page = orphans.slice(skip, skip + input.limit);
        const truncated = orphans.length > skip + input.limit;
        return {
          ...warnings.out(),
          vault: v.id,
          total: orphans.length,
          truncated,
          next_cursor: nextOffsetCursor(skip, page.length, truncated),
          orphans: page,
        };
      },
    }),

    defineTool({
      name: "find_unresolved_links",
      domain: "links",
      description:
        "Find internal links that do not resolve to any note (dangling links), including quoted wikilinks in properties (tagged source=property). response_format=concise returns {source_path, target, line} per link, without col and kind.",
      inputSchema: ScanInput,
      outputSchema: FindUnresolvedLinksOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const warnings = new ScanWarnings();
        const skip = offsetOf(input.cursor);
        const scanned = scanUnresolved(
          { root: v.root, acl: ctx.acl, grantedScopes: ctx.grantedScopes },
          warnings,
          { folder: sub, limit: skip + input.limit },
        );
        const unresolved = scanned.unresolved.slice(skip);
        const truncated = scanned.truncated;
        const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
        return {
          ...warnings.out(),
          vault: v.id,
          total: unresolved.length,
          truncated,
          next_cursor: nextOffsetCursor(skip, unresolved.length, truncated),
          unresolved: concise
            ? unresolved.map(({ source_path, target, line, source, property }) => ({
                source_path,
                target,
                line,
                ...(source === "property" ? { source, property } : {}),
              }))
            : unresolved,
        };
      },
    }),

    defineTool({
      name: "rewrite_link",
      domain: "links",
      vaultArg: "vault",
      description:
        "Repoint every link to `from_target` at `to_target` across the vault. Defaults to dry_run; a real run requires confirmation. response_format=concise drops the from_target/to_target echo (to_target stays when the memoryDefense scan redacted it) and, on a real run, the per-note changes list; notes_changed and links_rewritten stay.",
      inputSchema: RewriteInput,
      outputSchema: RewriteLinkOutput,
      requiredScopes: ["write:notes"],
      // THE-824: display-only — see ToolDefinition.conditionallyDestructive. The real gate stays
      // the requireConfirmation call below (any non-dry_run); this only stops the wire annotation
      // from advertising destructive: false for a tool that CAN demand confirmation.
      conditionallyDestructive: true,
      // The notes a real run would rewrite: a note changing, or gaining a link to the target, moves it.
      confirmationTargets: (input, { ctx, root }) =>
        root
          ? (fingerprintTargets(
              root,
              planLinkRewrite(root, ctx.acl, ctx.grantedScopes, input).edits.map((e) => e.rel),
            ) ?? argsHash("state", []))
          : null,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { edits, totalLinks, warnings } = planLinkRewrite(
          v.root,
          ctx.acl,
          ctx.grantedScopes,
          input,
        );
        const mdConfig = deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF;

        if (!input.dry_run) {
          for (const e of edits) enforcePathAcl(ctx.acl, "write", e.rel, v.root, ctx.grantedScopes);
          requireConfirmation(ctx, "rewrite_link", input, true, {
            from_target: input.from_target,
            to_target: input.to_target,
            notes: edits.length,
            links: totalLinks,
          });
          // item 1 sibling writer (GH #994 follow-up): `input.to_target` is caller-controlled and
          // gets spliced into potentially many notes at once — scan EVERY edit's final body BEFORE
          // writing any of them (a block-mode refusal must not leave a partially-applied
          // multi-note rewrite on disk), same guard write_note/append_note/patch_note already get.
          const scannedEdits = edits.map((e) => ({
            ...e,
            text: enforceMemoryDefenseOnNoteWrite(mdConfig, e.rel, e.text, {
              metrics: deps.metrics,
            }).content,
          }));
          for (const e of scannedEdits) {
            writeNoteAtomic(resolveVaultPath(v.root, e.rel), e.text, false);
            deps.reindex?.(v.id, e.rel, e.text);
          }
        }
        // Security review round (MEDIUM #7): echo the SCANNED to_target, not the raw
        // caller-supplied one — a secret-shaped to_target spliced into every edit's body above
        // must not still come back unredacted in this same response, dry_run or not (a preview
        // is exactly as much of a leak surface as a real write).
        const toTarget = redactedEcho(mdConfig, input.to_target);
        const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
        const changes = edits.map((e) => ({ path: e.rel, count: e.count }));
        return {
          vault: v.id,
          dry_run: input.dry_run,
          // concise: the caller already knows what it asked for. A redacted to_target is the one
          // echo that tells it something it did not send, so that one stays.
          ...(concise ? {} : { from_target: input.from_target }),
          ...(!concise || toTarget !== input.to_target ? { to_target: toTarget } : {}),
          notes_changed: edits.length,
          links_rewritten: totalLinks,
          ...(concise && !input.dry_run ? {} : { changes }),
          ...rewriteWarningsOut(warnings),
        };
      },
    }),

    defineTool({
      name: "prune_hub_links",
      domain: "links",
      vaultArg: "vault",
      // Reads the hub note (input.path); the write targets are the computed set of notes linking to
      // it, enforced handler-side (each edit calls enforcePathAcl write) — not input-derivable.
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Prune unresolved and/or duplicate links from a hub note. Defaults to dry_run; a real run requires confirmation. response_format=concise drops removed[] and prev_hash on a real run; removed_count and content_hash stay, and a dry run keeps both.",
      inputSchema: PruneInput,
      outputSchema: PruneHubLinksOutput,
      requiredScopes: ["write:notes"],
      // THE-824: see rewrite_link above.
      conditionallyDestructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
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

        const index = buildVaultIndex(readableNotes(v.root, ctx.acl, ctx.grantedScopes));
        const { text, removed } = pruneHubLinks(raw, index, {
          removeUnresolved: input.remove_unresolved,
          removeDuplicates: input.remove_duplicates,
        });

        // Security review round (MEDIUM #7): `finalText` tracks whatever actually lands on disk —
        // `text` (unscanned) when nothing is written (dry_run, or nothing removed), the
        // memoryDefense-scanned bytes when a real write happens. `content_hash` below must hash
        // THIS, not the pre-write `text`, or a redact-mode write reports a hash for bytes that
        // were never persisted.
        let finalText = text;
        if (!input.dry_run && removed.length > 0) {
          enforcePathAcl(ctx.acl, "write", rel, v.root, ctx.grantedScopes);
          requireConfirmation(ctx, "prune_hub_links", input, true, {
            path: rel,
            removed: removed.length,
          });
          // item 1 sibling writer: the hub note's body may carry a pre-existing secret elsewhere
          // (outside the pruned links) that predates memoryDefense — scan the final body before
          // this write too, same as every other M1 writer.
          const mdConfig = deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF;
          finalText = enforceMemoryDefenseOnNoteWrite(mdConfig, rel, text, {
            metrics: deps.metrics,
          }).content;
          writeNoteAtomic(abs, finalText, false);
          deps.reindex?.(v.id, rel, finalText);
        }
        const slim =
          resolveResponseFormat(input, deps.responseFormat) === "concise" && !input.dry_run;
        return {
          vault: v.id,
          path: rel,
          dry_run: input.dry_run,
          removed_count: removed.length,
          ...(slim ? {} : { removed, prev_hash: hash }),
          content_hash: contentHash(finalText),
        };
      },
    }),
  ];
}
