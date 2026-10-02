// WP8: notes-tools.ts split. move_note and copy_note — extracted verbatim out of
// buildNotesTools. Paired because both relocate/duplicate a note to a new path with the same
// overwrite-then-trash-destination shape (soft-delete the existing destination to .trash before
// writing over it, so overwritten content stays recoverable). move_note additionally rewrites
// backlinks in every other note that pointed at the old path — updateBacklinks below is private
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
  hardDelete,
  noteExists,
  readNote,
  replaceDestination,
  writeNoteAtomic,
  writeNotesAllOrNothingGuarded,
} from "../../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../../vault/paths";
import { rewriteLinks } from "../../../vault/rewrite";
import { captureSnapshot } from "../../../vault/snapshots";
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

/** Rewrite links in every other note that pointed at the moved note. Runs after
 *  the file has moved on disk; reconstructs the pre-move path set so old-target
 *  links still resolve to fromRel, then repoints them at the new location. */
// ACL carve-out: this rewrites links in EVERY referencing note to keep links valid,
// including notes outside the caller's write whitelist. Deliberate graph-integrity
// invariant (a constrained link-text update, not arbitrary write access) — audit #12.
function updateBacklinks(
  root: string,
  fromRel: string,
  toRel: string,
  mdConfig: VaultMemoryDefenseConfig,
  metrics: MetricsRecorder | undefined,
  readable: (rel: string) => boolean,
  skips: ImmutableRewriteSkips,
): {
  notes: number;
  links: number;
  rewritten: Array<{ rel: string; text: string }>;
  warnings: RewriteWarning[];
} {
  const postPaths = walkVault(root, { extensions: [".md"] }).map((e) => e.relPath);
  const oldPaths = postPaths.filter((p) => p !== toRel).concat(fromRel);
  const oldIndex = buildVaultIndex(oldPaths);
  const newIndex = buildVaultIndex(postPaths);
  const newBase = basenameNoExt(toRel);
  const unique = (newIndex.byBasename.get(newBase.toLowerCase()) ?? []).length === 1;
  const newTarget = unique ? newBase : toRel.replace(/\.md$/i, "");

  const pending: Array<{ abs: string; rel: string; text: string; count: number }> = [];
  const warnings: RewriteWarning[] = [];
  for (const p of postPaths) {
    if (p === toRel) continue; // the moved note's own outgoing links are unaffected
    const abs = resolveVaultPath(root, p);
    const { raw } = readNote(abs);
    const {
      text,
      count,
      warnings: ws,
    } = rewriteLinks(raw, (target) => {
      const r = resolveTarget(oldIndex, target);
      return r.resolved && r.target_path === fromRel ? newTarget : null;
    });
    // a warning names its note, and the rewrite is vault-wide: only name notes the caller may read
    if (readable(p)) for (const w of ws) warnings.push({ path: p, ...w });
    if (count > 0 && !skips.blocks(p)) pending.push({ abs, rel: p, text, count });
  }
  // Security review round (GH #994 follow-up) + residual fix: scan every rewritten body BEFORE
  // any of them is written — the shared all-or-nothing helper (vault/notes-io.ts). A note being
  // rewritten here can carry a pre-existing secret that predates memoryDefense; a block-worthy
  // match in note N must refuse the WHOLE backlink rewrite, not leave notes before it repointed
  // and notes after it stale.
  const written = writeNotesAllOrNothingGuarded(
    pending.map((p) => ({ abs: p.abs, path: p.rel, content: p.text })),
    mdConfig,
    { metrics },
  );
  let notes = 0;
  let links = 0;
  const rewritten: Array<{ rel: string; text: string }> = [];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const w = written[i];
    if (!p || !w) continue;
    rewritten.push({ rel: p.rel, text: w.content });
    notes++;
    links += p.count;
  }
  return { notes, links, rewritten, warnings };
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

      const { raw, hash } = readNote(fromAbs);
      if (input.prev_hash !== undefined && input.prev_hash !== hash)
        throw err.concurrentModification("note changed since prev_hash", {
          path: fromRel,
          expected: input.prev_hash,
          actual: hash,
        });

      const crossFolder = dirOf(fromRel) !== dirOf(toRel);
      const overwriteExisting = toEx.exists && input.overwrite;
      requireConfirmation(ctx, "move_note", input, crossFolder || overwriteExisting, {
        from: fromRel,
        to: toRel,
        overwrite: overwriteExisting,
      });

      // Every refusal runs BEFORE the destination is touched: the relocated CONTENT can carry a
      // pre-existing secret that predates memoryDefense (the note may have been written before the
      // vault opted in), so scan the bytes about to land at the new path, same guard
      // write_note/append_note/patch_note get. A `block` refusal thrown after the trash used to
      // strand the destination in .trash.
      const scannedRaw = enforceMemoryDefenseOnNoteWrite(mdConfig, toRel, raw, {
        metrics: deps.metrics,
      }).content;
      // On overwrite, soft-delete the destination first so its content is recoverable (the source
      // is hardDelete'd below, but its content survives at toRel); replaceDestination restores it if
      // the write fails. The effect is marked committed once the move is not undone (THE-572: a
      // retry after the source is gone would otherwise answer note_not_found, and leaves
      // updateBacklinks' rewrites unfinished with no indication).
      if (overwriteExisting)
        captureSnapshot(
          ctx.db,
          deps.snapshots,
          v.id,
          toRel,
          readNote(toAbs).raw,
          "move_note",
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
      hardDelete(fromAbs);
      // THE-291: keep the search index coherent across the move — drop the source path,
      // index the destination, and reindex every backlink-rewritten note below.
      deps.deindex?.(v.id, fromRel);
      deps.reindex?.(v.id, toRel, scannedRaw);
      const skips = new ImmutableRewriteSkips(ctx.acl, v.root, ctx.grantedScopes);
      const backlinks = input.update_backlinks
        ? updateBacklinks(
            v.root,
            fromRel,
            toRel,
            mdConfig,
            deps.metrics,
            (rel) => readableRel(ctx.acl, rel, ctx.grantedScopes),
            skips,
          )
        : { notes: 0, links: 0, rewritten: [], warnings: [] };
      for (const rw of backlinks.rewritten) deps.reindex?.(v.id, rw.rel, rw.text);
      return {
        vault: v.id,
        from: fromRel,
        to: toRel,
        moved: true,
        overwritten: toEx.exists,
        trashed_dest_to: trashedDestTo,
        content_hash: contentHash(scannedRaw),
        backlinks_updated: { notes: backlinks.notes, links: backlinks.links },
        ...rewriteWarningsOut(backlinks.warnings),
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
