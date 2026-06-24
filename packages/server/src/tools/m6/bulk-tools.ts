// Domain 25 — Bulk operations (G2.1 / THE-182). Three batch tools over the vault
// filesystem: bulk_create_notes, bulk_set_property, bulk_move_notes. Each requires
// the `bulk:notes` scope on top of its underlying write/delete scope, so dispatch
// auto-floors a HITL elicit token (bulk is in HITL_FLOOR_FAMILIES) AND denies the
// call under a read-only ACL (bulk is in MUTATING_FAMILIES) — no per-tool floor
// logic needed. Every sub-operation still funnels through resolveVaultPath +
// enforcePathAcl per target. Rate limiting is enforced once, dispatch-wide, by the policy
// gate (THE-210): bulk tools resolve to the `bulk` tier there, not here.
//
// Partial-failure contract:
//   - bulk_create_notes / bulk_set_property: best-effort-continue by default
//     (stop_on_first_error opt-in); the per-item results[] carries each ok/error.
//   - bulk_move_notes: best-effort validation per move, then an all-or-nothing
//     link-rewrite pass computed over the whole graph and applied together. dry_run
//     (default true) previews predicted backlink updates without touching disk.
//
// idempotency_key / bulk_idempotency_key are accepted as forward-compat surface
// (replay dedup is THE-197, Policy layer) — same stance as M1 WriteOptions.
import {
  ElicitToken,
  ObsidianTcError,
  VaultId,
  VaultPath,
  err,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { runBulk } from "../../vault/bulk";
import { parseNote, serializeNote } from "../../vault/frontmatter";
import { type VaultIndex, buildVaultIndex, resolveTarget } from "../../vault/links";
import { hardDelete, noteExists, readNote, trashNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { rewriteLinks } from "../../vault/rewrite";
import { defineTool } from "../m1/define";
import type { M6Deps } from "./shared";

// ── move helpers ────────────────────────────────────────────────────────────────

function basenameNoExt(p: string): string {
  const b = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  return b.replace(/\.md$/i, "");
}

/** The link text a moved note should be referenced by: bare basename when unique
 *  in the post-move index, else the full extension-less path (Obsidian shortest-link). */
function newTargetFor(toRel: string, postIndex: VaultIndex): string {
  const base = basenameNoExt(toRel);
  const unique = (postIndex.byBasename.get(base.toLowerCase()) ?? []).length === 1;
  return unique ? base : toRel.replace(/\.md$/i, "");
}

/**
 * Rewrite every link that pointed at a moved note to its new location, across the
 * whole vault (including moved notes' own links to other moved notes). `apply`
 * false simulates over the current (pre-move) tree for dry_run prediction; true
 * runs after the files have moved and writes the rewrites. Returns per-move and
 * total link counts.
 */
// ACL carve-out: this rewrites links in EVERY referencing note to keep links valid,
// including notes outside the caller's write whitelist. Deliberate graph-integrity
// invariant (a constrained link-text update, not arbitrary write access) — audit #12.
function rewriteForMoves(
  root: string,
  moveMap: Map<string, string>,
  prePaths: string[],
  apply: boolean,
): { perMove: Map<string, number>; total: number } {
  const oldIndex = buildVaultIndex(prePaths);
  const postPaths = apply
    ? walkVault(root, { extensions: [".md"] }).map((e) => e.relPath)
    : prePaths.map((p) => moveMap.get(p) ?? p);
  const postIndex = buildVaultIndex(postPaths);
  // Notes to scan on disk: post-move locations when applied, else the current tree.
  const scanPaths = apply ? postPaths : prePaths;

  const perMove = new Map<string, number>();
  let total = 0;
  for (const p of scanPaths) {
    const abs = resolveVaultPath(root, p);
    let raw: string;
    try {
      raw = readNote(abs).raw;
    } catch {
      continue; // a path that vanished mid-pass is skipped, not fatal
    }
    const { text, count } = rewriteLinks(raw, (target) => {
      const r = resolveTarget(oldIndex, target);
      if (!r.resolved || r.target_path === undefined) return null;
      const toRel = moveMap.get(r.target_path);
      if (toRel === undefined) return null;
      perMove.set(r.target_path, (perMove.get(r.target_path) ?? 0) + 1);
      return newTargetFor(toRel, postIndex);
    });
    if (count > 0) {
      total += count;
      if (apply) writeNoteAtomic(abs, text, false);
    }
  }
  return { perMove, total };
}

// ── schemas ────────────────────────────────────────────────────────────────────

const BulkConcurrency = z.number().int().min(1).max(16).default(4);

const CreateItem = z.object({
  path: VaultPath,
  content: z.string(),
  frontmatter: z.record(z.unknown()).optional(),
  mode: z.enum(["create", "overwrite", "upsert"]).default("create"),
  idempotency_key: z.string().min(1).max(128).optional(),
});

const BulkCreateInput = z
  .object({
    vault: VaultId,
    items: z.array(CreateItem).min(1).max(200),
    bulk_idempotency_key: z.string().min(1).max(128).optional(),
    max_concurrent: BulkConcurrency,
    stop_on_first_error: z.boolean().default(false),
    elicit_token: ElicitToken.optional(),
  })
  .strict();

const BulkSetPropertyInput = z
  .object({
    vault: VaultId,
    paths: z.array(VaultPath).min(1).max(500),
    key: z.string().min(1),
    value: z.unknown(),
    max_concurrent: BulkConcurrency,
    stop_on_first_error: z.boolean().default(false),
    elicit_token: ElicitToken.optional(),
  })
  .strict();

const BulkMoveInput = z
  .object({
    vault: VaultId,
    moves: z
      .array(z.object({ from: VaultPath, to: VaultPath }))
      .min(1)
      .max(100),
    update_backlinks: z.boolean().default(true),
    overwrite: z.boolean().default(false),
    dry_run: z.boolean().default(true),
    elicit_token: ElicitToken.optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
  })
  .strict();

// ── tools ────────────────────────────────────────────────────────────────────

export function buildBulkTools(deps: M6Deps): ToolDefinition[] {
  const clampConcurrency = (n: number): number =>
    Math.max(1, Math.min(n, deps.throttle.maxConcurrentWritesPerVault));

  return [
    defineTool({
      name: "bulk_create_notes",
      description:
        "Batch-create notes with per-item results. Each item creates/overwrites/upserts a note (content + optional frontmatter). HITL-floored (bulk) and throttled; best-effort by default (stop_on_first_error opt-in).",
      inputSchema: BulkCreateInput,
      requiredScopes: ["write:notes", "bulk:notes"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const report = await runBulk(
          input.items,
          {
            maxConcurrent: clampConcurrency(input.max_concurrent),
            stopOnFirstError: input.stop_on_first_error,
            now: ctx.now,
          },
          (item) => ({ path: item.path }),
          (item) => {
            const rel = normalizeVaultPath(item.path);
            const abs = resolveVaultPath(v.root, rel);
            enforcePathAcl(ctx.acl, "write", rel);
            const ex = noteExists(abs);
            if (ex.exists && ex.type === "folder")
              throw err.invalidInput("path is a folder", { path: rel });
            if (item.mode === "create" && ex.exists)
              throw err.noteExists("note already exists; use overwrite or upsert", { path: rel });
            if (item.mode === "overwrite" && !ex.exists)
              throw err.noteNotFound("note does not exist; use create or upsert", { path: rel });
            const body = serializeNote(item.frontmatter ?? null, item.content);
            writeNoteAtomic(abs, body, true);
            return {
              mode_used: ex.exists ? "overwrite" : "create",
              content_hash: contentHash(body),
            };
          },
        );
        return { vault: v.id, ...report };
      },
    }),

    defineTool({
      name: "bulk_set_property",
      description:
        "Set one frontmatter property across many notes, with per-item results (prev_value). HITL-floored (bulk) and throttled; best-effort by default (stop_on_first_error opt-in).",
      inputSchema: BulkSetPropertyInput,
      requiredScopes: ["write:notes", "bulk:notes"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const report = await runBulk(
          input.paths,
          {
            maxConcurrent: clampConcurrency(input.max_concurrent),
            stopOnFirstError: input.stop_on_first_error,
            now: ctx.now,
          },
          (path) => ({ path }),
          (path) => {
            const rel = normalizeVaultPath(path);
            const abs = resolveVaultPath(v.root, rel);
            enforcePathAcl(ctx.acl, "write", rel);
            const ex = noteExists(abs);
            if (!ex.exists || ex.type === "folder")
              throw err.noteNotFound("note not found", { path: rel });
            const parsed = parseNote(readNote(abs).raw);
            const fm = { ...(parsed.frontmatter ?? {}) };
            const prev = Object.hasOwn(fm, input.key) ? fm[input.key] : null;
            // Store an explicitly-supplied null as null; only a truly-absent value
            // defaults to null (F5).
            fm[input.key] = "value" in input ? input.value : null;
            writeNoteAtomic(abs, serializeNote(fm, parsed.body), false);
            return { prev_value: prev ?? null };
          },
        );
        return { vault: v.id, ...report };
      },
    }),

    defineTool({
      name: "bulk_move_notes",
      description:
        "Batch-move notes and rewrite backlinks across the whole link graph (rewrite phase is all-or-nothing). dry_run (default true) previews predicted backlink updates without touching disk. Set overwrite to clobber existing destinations (each is soft-deleted to .trash, recoverable). HITL-floored (bulk) and throttled.",
      inputSchema: BulkMoveInput,
      requiredScopes: ["write:notes", "delete:notes", "bulk:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        interface MoveRow {
          from: string;
          to: string;
          fromRel?: string;
          toRel?: string;
          destExists?: boolean;
          ok: boolean;
          error?: ReturnType<ObsidianTcError["toJSON"]>;
        }

        const rows: MoveRow[] = input.moves.map((m) => {
          try {
            const fromRel = normalizeVaultPath(m.from);
            const toRel = normalizeVaultPath(m.to);
            if (fromRel === toRel)
              throw err.invalidInput("from and to are identical", { path: fromRel });
            enforcePathAcl(ctx.acl, "delete", fromRel);
            enforcePathAcl(ctx.acl, "write", toRel);
            const fromEx = noteExists(resolveVaultPath(v.root, fromRel));
            if (!fromEx.exists || fromEx.type === "folder")
              throw err.noteNotFound("source note not found", { path: fromRel });
            const toEx = noteExists(resolveVaultPath(v.root, toRel));
            if (toEx.exists && toEx.type === "folder")
              throw err.invalidInput("destination is a folder", { path: toRel });
            const destExists = toEx.exists;
            if (destExists && !input.overwrite)
              throw err.noteExists("destination already exists; set overwrite", { path: toRel });
            return { from: m.from, to: m.to, fromRel, toRel, destExists, ok: true };
          } catch (e) {
            const error = (
              e instanceof ObsidianTcError
                ? e
                : new ObsidianTcError("internal_error", (e as Error).message)
            ).toJSON();
            return { from: m.from, to: m.to, ok: false, error };
          }
        });

        // In-batch hazards the per-row pass cannot see: a destination claimed by
        // two moves (the 2nd clobbers the 1st, whose source is already hardDeleted
        // -> permanent loss) and chained moves (a dest that is also a source) which
        // corrupt order-dependently. Reject the offending rows so dry_run and the
        // real run share outcomes (the all-or-nothing contract).
        const okFrom = new Set<string>();
        const okTo = new Set<string>();
        for (const r of rows) {
          if (r.ok && r.fromRel && r.toRel) {
            okFrom.add(r.fromRel);
            okTo.add(r.toRel);
          }
        }
        const claimed = new Set<string>();
        for (const r of rows) {
          if (!r.ok || !r.fromRel || !r.toRel) continue;
          let reason: string | null = null;
          if (okFrom.has(r.toRel))
            reason = "destination is also a source of another move in this batch (chained move)";
          else if (okTo.has(r.fromRel))
            reason = "source is also a destination of another move in this batch (chained move)";
          else if (claimed.has(r.toRel))
            reason = "destination already claimed by another move in this batch";
          if (reason) {
            r.ok = false;
            r.error = new ObsidianTcError("invalid_input", reason, {
              from: r.fromRel,
              to: r.toRel,
            }).toJSON();
          } else {
            claimed.add(r.toRel);
          }
        }

        const prePaths = walkVault(v.root, { extensions: [".md"] }).map((e) => e.relPath);
        const moveMap = new Map<string, string>();
        for (const r of rows) if (r.ok && r.fromRel && r.toRel) moveMap.set(r.fromRel, r.toRel);

        if (input.dry_run) {
          const { perMove, total } = input.update_backlinks
            ? rewriteForMoves(v.root, moveMap, prePaths, false)
            : { perMove: new Map<string, number>(), total: 0 };
          return {
            vault: v.id,
            processed: rows.length,
            dry_run: true,
            total_backlinks_updated: total,
            results: rows.map((r) => ({
              from: r.from,
              to: r.to,
              ok: r.ok,
              ...(r.ok
                ? { backlinks_updated: perMove.get(r.fromRel ?? "") ?? 0 }
                : { error: r.error }),
            })),
          };
        }

        // Real move — phase 1: relocate each valid file; drop any that throw.
        for (const r of rows) {
          if (!r.ok || !r.fromRel || !r.toRel) continue;
          try {
            const fromAbs = resolveVaultPath(v.root, r.fromRel);
            const toAbs = resolveVaultPath(v.root, r.toRel);
            // On overwrite, soft-delete the clobbered destination first (recoverable).
            if (r.destExists && input.overwrite) trashNote(v.root, r.toRel);
            const { raw } = readNote(fromAbs);
            writeNoteAtomic(toAbs, raw, true);
            hardDelete(fromAbs);
          } catch (e) {
            r.ok = false;
            r.error = (
              e instanceof ObsidianTcError
                ? e
                : new ObsidianTcError("internal_error", (e as Error).message)
            ).toJSON();
            moveMap.delete(r.fromRel);
          }
        }

        // Phase 2: all-or-nothing rewrite over the whole graph for the moved set.
        const { perMove, total } = input.update_backlinks
          ? rewriteForMoves(v.root, moveMap, prePaths, true)
          : { perMove: new Map<string, number>(), total: 0 };

        return {
          vault: v.id,
          processed: rows.length,
          dry_run: false,
          total_backlinks_updated: total,
          results: rows.map((r) => ({
            from: r.from,
            to: r.to,
            ok: r.ok,
            ...(r.ok
              ? { backlinks_updated: perMove.get(r.fromRel ?? "") ?? 0 }
              : { error: r.error }),
          })),
        };
      },
    }),
  ];
}
