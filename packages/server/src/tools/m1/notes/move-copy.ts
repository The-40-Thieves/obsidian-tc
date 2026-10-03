// WP8: notes-tools.ts split. move_note and copy_note — extracted verbatim out of
// buildNotesTools. Paired because both relocate/duplicate a note to a new path with the same
// overwrite-then-trash-destination shape (soft-delete the existing destination to .trash before
// writing over it, so overwritten content stays recoverable). move_note additionally rewrites
// backlinks in every other note that pointed at the old path — planBacklinks below is private
// to move_note; copy_note does not rewrite links (see its description).
import { err, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import {
  enforceMemoryDefenseOnNoteWrite,
  MEMORY_DEFENSE_OFF,
  refusePathIfSecretShaped,
} from "../../../experiential/memory-defense";
import type { ToolDefinition } from "../../../mcp/registry";
import type { MetricsRecorder } from "../../../metrics/registry";
import { enforcePathAcl, ImmutableRewriteSkips } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { requireConfirmation } from "../../../vault/hitl";
import { buildVaultIndex, resolveTarget } from "../../../vault/links";
import {
  commitPlanned,
  type PlannedRewrite,
  PreImageSnapshots,
  planFingerprint,
  plannedRewrite,
  RewriteScan,
} from "../../../vault/move-plan";
import { noteExists, readNote, replaceDestination, writeNoteAtomic } from "../../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../../vault/paths";
import { captureSnapshot } from "../../../vault/snapshots";
import { applyWriteBatch } from "../../../vault/write-batch";
import { type RewriteWarning, rewriteWarningsOut } from "../../scan-warnings";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { CopyInput, CopyNoteOutput, MoveInput, MoveNoteOutput } from "./schemas";

// ── helpers ──────────────────────────────────────────────────────────────────

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function basenameNoExt(p: string): string {
  const b = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  return b.replace(/\.md$/i, "");
}

/** Everything move_note decided before it touches the vault. */
interface MovePlan {
  /** The source's bytes as planned: the source is removed only if it still holds them. */
  raw: string;
  /** Hash of the source as planned: the plan is stale if it has changed. */
  hash: string;
  /** The source's content as it will land at the destination (memoryDefense-scanned). */
  scannedRaw: string;
  backlinks: BacklinkPlan;
}

/** The backlink rewrite of a move, computed and PROVEN before anything is moved (planBacklinks),
 *  then written together with the moved note as one batch. */
interface BacklinkPlan {
  pending: PlannedRewrite[];
  warnings: RewriteWarning[];
}

/** Plan the rewrite of every other note that pointed at the moved note: the new text of each, with
 *  every changed link re-parsed and every body memoryDefense-scanned (a `block` refusal happens here,
 *  before the move). It only reads, so it runs BEFORE the move and a link that cannot be written
 *  refuses the whole move while the file is still in place. Both path sets are rebuilt from the
 *  vault as it is now, whichever side of the move that is, so old-target links still resolve to
 *  fromRel and are repointed at the new location. */
// ACL carve-out: this rewrites links in EVERY referencing note to keep links valid,
// including notes outside the caller's write whitelist. Deliberate graph-integrity
// invariant (a constrained link-text update, not arbitrary write access) — audit #12.
function planBacklinks(
  root: string,
  fromRel: string,
  toRel: string,
  readable: (rel: string) => boolean,
  skips: ImmutableRewriteSkips,
  defense: VaultMemoryDefenseConfig,
  metrics: MetricsRecorder | undefined,
): BacklinkPlan {
  const current = walkVault(root, { extensions: [".md"] }).map((e) => e.relPath);
  const postPaths = current.filter((p) => p !== fromRel);
  if (!postPaths.includes(toRel)) postPaths.push(toRel);
  const oldPaths = current.filter((p) => p !== toRel);
  if (!oldPaths.includes(fromRel)) oldPaths.push(fromRel);
  const oldIndex = buildVaultIndex(oldPaths);
  const newIndex = buildVaultIndex(postPaths);
  const newBase = basenameNoExt(toRel);
  const unique = (newIndex.byBasename.get(newBase.toLowerCase()) ?? []).length === 1;
  const newTarget = unique ? newBase : toRel.replace(/\.md$/i, "");

  const pending: PlannedRewrite[] = [];
  const warnings: RewriteWarning[] = [];
  const scan = new RewriteScan(skips);
  for (const p of postPaths) {
    if (p === toRel) continue; // the moved note's own outgoing links are unaffected
    const abs = resolveVaultPath(root, p);
    const note = scan.read(abs, p);
    if (!note) continue;
    const { raw } = note;
    const rewrite = scan.note(
      raw,
      (target) => {
        const r = resolveTarget(oldIndex, target);
        return r.resolved && r.target_path === fromRel ? newTarget : null;
      },
      p,
    );
    if (!rewrite) continue;
    // a warning names its note, and the rewrite is vault-wide: only name notes the caller may read
    if (readable(p)) for (const w of rewrite.warnings) warnings.push({ path: p, ...w });
    if (rewrite.count > 0) pending.push(plannedRewrite(abs, p, raw, rewrite, defense, metrics));
  }
  scan.refuseIfFailed();
  return { pending, warnings };
}

// ── tools ────────────────────────────────────────────────────────────────────

export function createMoveNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "move_note",
    domain: "notes",
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    // Backlink rewrites in other notes are a deliberate integrity carve-out (like move_attachment,
    // N-3) and stay handler-enforced; the ACL-gated paths are the source (delete) + dest (write).
    pathAcl: (input) => [
      { op: "delete", path: input.from },
      { op: "write", path: input.to },
    ],
    description:
      "Move/rename a note and update backlinks. Crossing a folder boundary OR overwriting an existing destination requires confirmation; an overwritten destination is soft-deleted to .trash (recoverable).",
    inputSchema: MoveInput,
    outputSchema: MoveNoteOutput,
    requiredScopes: ["write:notes", "delete:notes"],
    // THE-824: display-only — see ToolDefinition.conditionallyDestructive. The real gate stays the
    // requireConfirmation call below (crossFolder || overwriteExisting); this only stops the wire
    // annotation from advertising destructive: false for a tool that CAN demand confirmation.
    conditionallyDestructive: true,
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const fromRel = normalizeVaultPath(input.from);
      const toRel = normalizeVaultPath(input.to);
      if (fromRel === toRel) throw err.invalidInput("from and to are identical", { path: fromRel });
      const fromAbs = resolveVaultPath(v.root, fromRel);
      const toAbs = resolveVaultPath(v.root, toRel);
      enforcePathAcl(ctx.acl, "delete", fromRel, v.root, ctx.grantedScopes);
      enforcePathAcl(ctx.acl, "write", toRel, v.root, ctx.grantedScopes);
      const mdConfig = deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF;
      // item 1 sibling writer (GH #994 follow-up): a caller-chosen destination path can itself be
      // secret-shaped — mirrors commit_capture's own target_path refusal, before anything else
      // reads or touches the filesystem.
      refusePathIfSecretShaped(mdConfig, "to", toRel, { metrics: deps.metrics });

      const fromEx = noteExists(fromAbs);
      if (!fromEx.exists || fromEx.type === "folder")
        throw err.noteNotFound("source note not found", { path: fromRel });
      const toEx = noteExists(toAbs);
      if (toEx.exists && toEx.type === "folder")
        throw err.invalidInput("destination is a folder", { path: toRel });
      if (toEx.exists && !input.overwrite)
        throw err.noteExists("destination already exists; set overwrite", { path: toRel });

      // Plan and PROVE the whole move before anything is touched: the moved note's scanned content
      // and every backlink rewrite (each link re-parsed, each body memoryDefense-scanned). A
      // destination whose links cannot be written (an existing `C#/` folder, a `)` in a markdown
      // link target) or a note a `block`-mode scan refuses ends here, with the file still in place
      // and its backlinks still valid. The plan holds each note's pre-image; the commit re-checks it.
      const skips = new ImmutableRewriteSkips(ctx.acl, v.root, ctx.grantedScopes);
      const readable = (rel: string): boolean => readableRel(ctx.acl, rel, ctx.grantedScopes);
      const planMove = (record: boolean): MovePlan => {
        const { raw, hash } = readNote(fromAbs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: fromRel,
            expected: input.prev_hash,
            actual: hash,
          });
        const metrics = record ? deps.metrics : undefined;
        // The relocated CONTENT can carry a pre-existing secret that predates memoryDefense (the
        // note may have been written before the vault opted in), so scan the bytes about to land at
        // the new path, same guard write_note/append_note/patch_note get.
        const scannedRaw = enforceMemoryDefenseOnNoteWrite(mdConfig, toRel, raw, {
          ...(metrics ? { metrics } : {}),
        }).content;
        const backlinks = input.update_backlinks
          ? planBacklinks(v.root, fromRel, toRel, readable, skips, mdConfig, metrics)
          : { pending: [], warnings: [] };
        return { raw, hash, scannedRaw, backlinks };
      };
      const first = planMove(true);

      const crossFolder = dirOf(fromRel) !== dirOf(toRel);
      const overwriteExisting = toEx.exists && input.overwrite;
      requireConfirmation(ctx, "move_note", input, crossFolder || overwriteExisting, {
        from: fromRel,
        to: toRel,
        overwrite: overwriteExisting,
      });

      // The move and every backlink rewrite land as ONE write batch (vault/write-batch.ts): the
      // moved note is created at its destination (exclusive: a note that appeared there is never
      // replaced) and each backlink note is replaced only if it still holds the bytes the plan was
      // made from. A CAS miss or an I/O error rolls the whole batch back, the moved note included,
      // and replaceDestination puts a trashed destination back. The source is removed as the batch's
      // last step and only if it still holds the planned bytes (an edit that lands after the final
      // recheck keeps it and rolls the batch back, then the move is planned again around the edit).
      // On overwrite, the destination is soft-deleted first so its content is recoverable (the
      // source is hardDelete'd after, but its content survives at toRel); the effect is marked
      // committed once the move is not undone (THE-572: a retry after the source is gone would
      // otherwise answer note_not_found).
      const snapshots = new PreImageSnapshots(ctx.db, deps.snapshots, v.id, "move_note", ctx.now);
      let trashedDestTo = null as string | null;
      const plan = commitPlanned({
        first,
        plan: planMove,
        fingerprint: (p) => planFingerprint(p.backlinks.pending, [p.hash]),
        commit: (p, recheck) => {
          try {
            if (overwriteExisting) snapshots.capture(toRel, readNote(toAbs).raw);
            for (const r of p.backlinks.pending) snapshots.capture(r.rel, r.raw);
            ({ trashedTo: trashedDestTo } = replaceDestination({
              root: v.root,
              toRel,
              toAbs,
              replacing: overwriteExisting,
              write: (o) =>
                applyWriteBatch(
                  [
                    {
                      abs: toAbs,
                      rel: toRel,
                      content: p.scannedRaw,
                      prevRaw: null,
                      createDirs: input.options.create_dirs,
                      replacesExisting: o.replacesExisting,
                    },
                    ...p.backlinks.pending.map((r) => ({
                      abs: r.abs,
                      rel: r.rel,
                      content: r.text,
                      prevRaw: r.raw,
                      createDirs: false,
                    })),
                  ],
                  {
                    beforeCommit: recheck,
                    removals: [{ abs: fromAbs, rel: fromRel, expected: p.raw }],
                  },
                ),
              markEffectCommitted: ctx.markEffectCommitted,
            }));
          } catch (e) {
            snapshots.failed(e);
            throw e;
          }
        },
      });
      snapshots.landed();
      // THE-291: keep the search index coherent across the move — drop the source path,
      // index the destination, and reindex every backlink-rewritten note.
      deps.deindex?.(v.id, fromRel);
      deps.reindex?.(v.id, toRel, plan.scannedRaw);
      for (const r of plan.backlinks.pending) deps.reindex?.(v.id, r.rel, r.text);
      return {
        vault: v.id,
        from: fromRel,
        to: toRel,
        moved: true,
        overwritten: toEx.exists,
        trashed_dest_to: trashedDestTo,
        content_hash: contentHash(plan.scannedRaw),
        backlinks_updated: {
          notes: plan.backlinks.pending.length,
          links: plan.backlinks.pending.reduce((n, r) => n + r.count, 0),
        },
        ...rewriteWarningsOut(plan.backlinks.warnings),
        ...skips.out(),
      };
    },
  });
}

export function createCopyNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "copy_note",
    domain: "notes",
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    pathAcl: (input) => [
      { op: "read", path: input.from },
      { op: "write", path: input.to },
    ],
    description: "Copy a note to a new path (backlinks are not rewritten for copies).",
    inputSchema: CopyInput,
    outputSchema: CopyNoteOutput,
    requiredScopes: ["write:notes"],
    // THE-824: see move_note above.
    conditionallyDestructive: true,
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const fromRel = normalizeVaultPath(input.from);
      const toRel = normalizeVaultPath(input.to);
      const fromAbs = resolveVaultPath(v.root, fromRel);
      const toAbs = resolveVaultPath(v.root, toRel);
      enforcePathAcl(ctx.acl, "read", fromRel, v.root, ctx.grantedScopes);
      enforcePathAcl(ctx.acl, "write", toRel, v.root, ctx.grantedScopes);
      const mdConfig = deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF;
      // item 1 sibling writer: see move_note's identical comment above.
      refusePathIfSecretShaped(mdConfig, "to", toRel, { metrics: deps.metrics });

      const fromEx = noteExists(fromAbs);
      if (!fromEx.exists || fromEx.type === "folder")
        throw err.noteNotFound("source note not found", { path: fromRel });
      const toEx = noteExists(toAbs);
      if (toEx.exists && !input.overwrite)
        throw err.noteExists("destination already exists; set overwrite", { path: toRel });

      // Overwriting an existing destination is a conditional-HITL, recoverable op — mirror
      // move_note: require confirmation, then soft-delete the destination first so its prior
      // content survives in .trash. Without this, copy_note --overwrite clobbered the target
      // irreversibly with no HITL floor (the sibling move_note already guarded this).
      const overwriteExisting = toEx.exists && input.overwrite;
      requireConfirmation(ctx, "copy_note", input, overwriteExisting, {
        from: fromRel,
        to: toRel,
        overwrite: overwriteExisting,
      });

      const { raw } = readNote(fromAbs);
      // Every refusal before the destination is touched (see move_note).
      const scannedRaw = enforceMemoryDefenseOnNoteWrite(mdConfig, toRel, raw, {
        metrics: deps.metrics,
      }).content;
      // THE-572: unlike move_note this leaves the source in place, so a retry re-runs the WHOLE
      // sequence — under overwrite that means a second .trash entry and a second snapshot row for
      // content that never changed. replaceDestination marks the effect committed once it is not
      // undone, before either of those can repeat.
      if (overwriteExisting)
        captureSnapshot(
          ctx.db,
          deps.snapshots,
          v.id,
          toRel,
          readNote(toAbs).raw,
          "copy_note",
          ctx.now,
        );
      const { trashedTo: trashedDestTo } = replaceDestination({
        root: v.root,
        toRel,
        toAbs,
        replacing: overwriteExisting,
        write: (o) => writeNoteAtomic(toAbs, scannedRaw, input.options.create_dirs, o),
        markEffectCommitted: ctx.markEffectCommitted,
      });
      deps.reindex?.(v.id, toRel, scannedRaw);
      return {
        vault: v.id,
        from: fromRel,
        to: toRel,
        copied: true,
        overwritten: toEx.exists,
        trashed_dest_to: trashedDestTo,
        content_hash: contentHash(scannedRaw),
      };
    },
  });
}
