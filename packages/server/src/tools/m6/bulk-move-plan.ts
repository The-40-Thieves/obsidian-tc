// bulk_move_notes' PLAN: every note a batch of moves rewrites, proven and scanned, before anything
// moves. Split out of bulk-tools.ts so that file stays under the line ceiling; see planMoves.
import { existsSync } from "node:fs";
import { err, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import { enforceMemoryDefenseOnNoteWrite } from "../../experiential/memory-defense";
import type { MetricsRecorder } from "../../metrics/registry";
import type { ImmutableRewriteSkips } from "../../vault/acl-path";
import { buildVaultIndex, resolveTarget, type VaultIndex } from "../../vault/links";
import { type PlannedRewrite, plannedRewrite, RewriteScan } from "../../vault/move-plan";
import { resolveVaultPath } from "../../vault/paths";

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

/** One moved note as planned: where it comes from, the hash of the bytes the plan read, and the
 *  content that lands at the destination (its own links already repointed, memoryDefense-scanned). */
export interface PlannedMove {
  fromRel: string;
  toRel: string;
  fromAbs: string;
  toAbs: string;
  hash: string;
  /** The bytes `hash` is of: what the source removal compares against. */
  raw: string;
  content: string;
}

export interface MovesPlan {
  perMove: Map<string, number>;
  total: number;
  hidden: boolean;
  /** Notes that are not moving and could not be read, so their links were not updated (a count). */
  unreadable: number;
  moved: PlannedMove[];
  /** The rewrites of notes that are NOT themselves moved (a moved note's rewrite is its `content`). */
  rewrites: PlannedRewrite[];
}

/**
 * Plan every link that pointed at a moved note, across the whole vault (including moved notes' own
 * links to other moved notes), WITHOUT writing anything: the new body of every rewritten note with
 * each changed link re-parsed (RewriteScan), memoryDefense-scanned, and carrying its pre-image. The
 * real run commits exactly this plan (one write batch that also creates the moved notes), so it is
 * not recomputed after anything has moved; dry_run reads the same plan for its prediction. The
 * post-move paths are `prePaths` with each source mapped to its destination, and a destination
 * being overwritten counted once (`replacing`), so a basename that is unique after the move gets
 * its bare link.
 */
// ACL carve-out: this rewrites links in EVERY referencing note to keep links valid,
// including notes outside the caller's write whitelist. Deliberate graph-integrity
// invariant (a constrained link-text update, not arbitrary write access) — audit #12.
// The REPORT is not part of that carve-out: `perMove`/`total` count only links in notes the caller
// may read (`visible`), and `hidden` says a note the caller cannot see also held links — a flag, never
// a number or a path, so the difference cannot be used to probe a hidden note's links.
export function planMoves(args: {
  root: string;
  moveMap: Map<string, string>;
  prePaths: string[];
  replacing: ReadonlySet<string>;
  updateBacklinks: boolean;
  defense: VaultMemoryDefenseConfig;
  metrics: MetricsRecorder | undefined;
  visible: (relPath: string) => boolean;
  skips: ImmutableRewriteSkips;
}): MovesPlan {
  const { root, moveMap, prePaths, replacing, defense, metrics, visible, skips } = args;
  const oldIndex = buildVaultIndex(prePaths);
  const postPaths = [
    ...new Set(prePaths.filter((p) => !replacing.has(p)).map((p) => moveMap.get(p) ?? p)),
  ];
  const postIndex = buildVaultIndex(postPaths);
  const scanPaths = args.updateBacklinks
    ? prePaths.filter((p) => !replacing.has(p))
    : [...moveMap.keys()];

  const perMove = new Map<string, number>();
  let total = 0;
  let hidden = false;
  const moved: PlannedMove[] = [];
  const rewrites: PlannedRewrite[] = [];
  const scan = new RewriteScan(skips);
  for (const p of scanPaths) {
    const abs = resolveVaultPath(root, p);
    const toRel = moveMap.get(p);
    // a note that vanished mid-pass is skipped (a source that vanished is not a plan: its row's
    // bytes are needed). An unreadable SOURCE is a recorded refusal (RewriteScan.read); an unreadable
    // note that is not moving is skipped, as it was before, so it cannot fail the other rows.
    const note = scan.read(abs, p, toRel !== undefined);
    if (!note) {
      if (toRel !== undefined && !existsSync(abs))
        throw err.noteNotFound("source note not found", { path: p });
      continue;
    }
    const { raw, hash } = note;
    const inThisNote = new Map<string, number>();
    const rewrite = args.updateBacklinks
      ? scan.note(
          raw,
          (target) => {
            const r = resolveTarget(oldIndex, target);
            if (!r.resolved || r.target_path === undefined) return null;
            const to = moveMap.get(r.target_path);
            if (to === undefined) return null;
            inThisNote.set(r.target_path, (inThisNote.get(r.target_path) ?? 0) + 1);
            return newTargetFor(to, postIndex);
          },
          p,
        )
      : null;
    const rewritten = rewrite !== null && rewrite.count > 0 ? rewrite : null;
    if (rewritten) {
      if (visible(p)) {
        total += rewritten.count;
        for (const [m, n] of inThisNote) perMove.set(m, (perMove.get(m) ?? 0) + n);
      } else hidden = true;
    }
    if (toRel !== undefined) {
      // The relocated note's own bytes were scanned for its row before the plan (metrics counted
      // once there); this scan is of the final text, which only differs by its repointed links.
      const content = enforceMemoryDefenseOnNoteWrite(
        defense,
        toRel,
        rewritten?.text ?? raw,
      ).content;
      moved.push({
        fromRel: p,
        toRel,
        fromAbs: abs,
        toAbs: resolveVaultPath(root, toRel),
        hash,
        raw,
        content,
      });
    } else if (rewritten) rewrites.push(plannedRewrite(abs, p, raw, rewritten, defense, metrics));
  }
  scan.refuseIfFailed();
  return { perMove, total, hidden, unreadable: scan.unreadableSkipped, moved, rewrites };
}
