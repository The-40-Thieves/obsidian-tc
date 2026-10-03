// The shared plan-then-commit machinery behind move_note, move_attachment and bulk_move_notes.
//
// A move rewrites links in other notes. That rewrite is PLANNED first (every note read, every link
// re-parsed, every body scanned by memoryDefense: nothing touched), and the plan carries each
// note's PRE-IMAGE, the exact bytes it was planned from. The commit is one `applyWriteBatch`
// (vault/write-batch.ts): it re-hashes each note immediately before replacing it and rolls the
// whole batch back on a CAS miss or an I/O error. Drift between plan and commit is handled here:
//   - a planned note changed (the CAS miss), or
//   - a note appeared or changed so that the plan would now be different (the `recheck`, which
//     re-plans inside the batch's beforeCommit and compares fingerprints),
// re-plans and re-proves ONCE, then refuses with nothing moved if the vault moved again.
import {
  err,
  ObsidianTcError,
  type VaultMemoryDefenseConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { enforceMemoryDefenseOnNoteWrite } from "../experiential/memory-defense";
import { redactSecrets } from "../experiential/redact";
import type { MetricsRecorder } from "../metrics/registry";
import type { ImmutableRewriteSkips } from "./acl-path";
import { readNote } from "./notes-io";
import { contentHash } from "./paths";
import { type LinkRewrite, rewriteLinks } from "./rewrite";
import type { TargetMapper } from "./rewrite-properties";
import {
  captureSnapshot,
  discardSnapshots,
  pruneSnapshots,
  type SnapshotCaptureConfig,
} from "./snapshots";
import { isIncompleteRollback } from "./write-batch";

/** One note a move rewrites: the bytes it was planned from and the (memoryDefense-scanned) text
 *  that replaces them. */
export interface PlannedRewrite {
  abs: string;
  rel: string;
  /** The pre-image: what the note held when the plan was made. The batch's CAS compares it. */
  raw: string;
  text: string;
  count: number;
}

/** A read that found no file: readNote throws an ENOENT (or the typed not-found) for one. */
const isVanished = (e: unknown): boolean =>
  (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
  (e instanceof ObsidianTcError && e.code === "note_not_found");

/** A refusal collected while scanning: the link in `rel` cannot be written as exactly one link. */
interface ScanFailure {
  rel: string;
  target: string | undefined;
  cause: ObsidianTcError;
}

/**
 * Scans notes for a move's rewrite and decides, per note, what happens to it:
 *   - an IMMUTABLE note (a vault's raw sources) is never proven or written: it is probed only to
 *     learn whether it links the moved target, and reported as skipped if it does. An
 *     unrepresentable link inside it must not refuse the move, which is why the skip comes first;
 *   - any other note is rewritten and every changed link proven (rewriteLinks, exactTarget);
 *   - a note whose link cannot be proven is recorded, not thrown, so `refuseIfFailed` can refuse
 *     the whole move once with every failure in hand and name only the notes the caller may read.
 */
export class RewriteScan {
  private readonly failures: ScanFailure[] = [];

  constructor(private readonly skips: ImmutableRewriteSkips) {}

  /** Read a note for the plan. A note that vanished mid-pass is null (nothing to rewrite); any
   *  other failure (a hard-linked file, an I/O error) is recorded like an unprovable link and the
   *  note is skipped, so it refuses the move through `refuseIfFailed`: named only when the caller
   *  can read it, and never with the reader's own message or details (they carry absolute paths).
   *  `record: false` skips such a note silently instead (bulk_move_notes does this for a note that
   *  is not one of its moves: one unreadable bystander does not fail the other rows). */
  read(abs: string, rel: string, record = true): { raw: string; hash: string } | null {
    try {
      return readNote(abs);
    } catch (e) {
      if (isVanished(e) || !record) return null;
      this.failures.push({
        rel,
        target: undefined,
        cause: new ObsidianTcError(
          "invalid_input",
          "The note could not be read, so its links could not be checked",
        ),
      });
      return null;
    }
  }

  /** The note's rewrite, or null when it is skipped (immutable) or could not be proven (recorded). */
  note(raw: string, map: TargetMapper, rel: string): LinkRewrite | null {
    if (this.skips.isImmutable(rel)) {
      let mapped = false;
      try {
        rewriteLinks(
          raw,
          (target, kind) => {
            const next = map(target, kind);
            if (next !== null) mapped = true;
            return next;
          },
          { exactTarget: true },
        );
      } catch (e) {
        if (!(e instanceof ObsidianTcError && e.code === "invalid_input")) throw e;
      }
      if (mapped) this.skips.note(rel);
      return null;
    }
    let last: string | null = null;
    try {
      return rewriteLinks(
        raw,
        (target, kind) => {
          const next = map(target, kind);
          if (next !== null) last = next;
          return next;
        },
        { exactTarget: true },
      );
    } catch (e) {
      if (!(e instanceof ObsidianTcError) || e.code !== "invalid_input") throw e;
      this.failures.push({
        rel,
        target: last === null ? undefined : redactSecrets(last).text,
        cause: e,
      });
      return null;
    }
  }

  /** Refuse the whole move if any note's link could not be written. The error names a note only
   *  when the caller can read it; the rest are a count, never a path. */
  refuseIfFailed(): void {
    const first = this.failures.find((f) => this.skips.canRead(f.rel));
    const hidden = this.failures.filter((f) => !this.skips.canRead(f.rel)).length;
    const some = this.failures[0];
    if (!some) return;
    // `hidden_notes` is a flag, not a count: how MANY unreadable notes link the target is a link-graph
    // oracle on notes the caller may not see (the same reason `hidden_backlinks` is a flag).
    const hiddenDetail = hidden > 0 ? { hidden_notes: true } : {};
    if (first) {
      const note = redactSecrets(first.rel).text;
      throw err.invalidInput(
        `move refused: a link in ${note} cannot be rewritten to point at the destination${
          first.target === undefined ? "" : ` (${first.target})`
        }. ${first.cause.message}.${
          hidden > 0 ? " Other notes you cannot read have the same problem." : ""
        } Nothing was moved.`,
        {
          ...first.cause.details,
          note,
          ...(first.target === undefined ? {} : { target: first.target }),
          ...hiddenDetail,
        },
      );
    }
    const target = some.target;
    throw err.invalidInput(
      `move refused: links in notes you cannot read cannot be rewritten to point at the destination${
        target === undefined ? "" : ` (${target})`
      }. Nothing was moved.`,
      { hidden_notes: true, ...(target === undefined ? {} : { target }) },
    );
  }
}

/** A planned rewrite whose new text has passed the vault's memoryDefense scan: a `block` refusal
 *  (a pre-existing secret in a note being rewritten) happens HERE, in the plan, before anything
 *  moves. `metrics` is given only to the plan that may commit, so a re-plan does not count twice. */
export function plannedRewrite(
  abs: string,
  rel: string,
  raw: string,
  rewrite: Pick<LinkRewrite, "text" | "count">,
  defense: VaultMemoryDefenseConfig | undefined,
  metrics: MetricsRecorder | undefined,
): PlannedRewrite {
  const scanned = enforceMemoryDefenseOnNoteWrite(defense, rel, rewrite.text, {
    ...(metrics ? { metrics } : {}),
  });
  return { abs, rel, raw, text: scanned.content, count: rewrite.count };
}

/** What a plan was made from AND what it will write, as one string: every planned note's path,
 *  pre-image hash and planned output hash, plus whatever else the plan rests on (`extra`: the
 *  moved sources' hashes and outputs). The output is part of it because the pre-image is not
 *  enough: a note added elsewhere can change which link form a rewrite must take (a bare `[[B]]`
 *  becomes `[[sub/B]]` once another `B` exists) while every linker still holds the same bytes. Two
 *  plans with the same fingerprint rewrite the same notes from the same bytes into the same text. */
export function planFingerprint(
  rewrites: readonly PlannedRewrite[],
  extra: readonly string[] = [],
) {
  return [
    ...extra,
    ...rewrites.map((r) => `${r.rel}\0${contentHash(r.raw)}\0${contentHash(r.text)}`),
  ].join("\n");
}

class StalePlan extends Error {}

/** Thrown by a `commit` that has undone what it did and changed what the plan rests on (bulk drops
 *  a row whose destination could not be moved aside): the plan is rebuilt without spending the
 *  one drift retry. Each throw must remove something, so the loop ends. */
export class PlanChanged extends Error {}

/** True for the CAS miss `applyWriteBatch` throws when a note changed after it was planned. */
const isCasMiss = (e: unknown): boolean =>
  e instanceof ObsidianTcError && e.code === "concurrent_modification";

/**
 * Commit a plan, re-planning once if the vault moved under it. `commit(plan, recheck)` does the
 * writes and must call `recheck` as the batch's `beforeCommit` (after staging, before the first
 * rename): it re-plans without recording metrics and throws if the plan would now differ, which
 * abandons the batch with nothing replaced. A CAS miss inside the batch has the same effect (the
 * batch rolls itself back). Either way the plan is rebuilt from the vault as it is now (`plan`
 * re-proves every link, so a NEW unrepresentable backlink refuses here with nothing moved) and
 * the commit runs again; a second drift refuses with `concurrent_modification`.
 *
 * `first` is the plan the caller already built and showed to a confirmation; it is the one
 * committed unless it has gone stale.
 */
export function commitPlanned<P>(args: {
  first: P;
  plan: (record: boolean) => P;
  fingerprint: (plan: P) => string;
  commit: (plan: P, recheck: () => void) => void;
}): P {
  let plan = args.first;
  for (let attempt = 0; ; attempt++) {
    const expected = args.fingerprint(plan);
    try {
      args.commit(plan, () => {
        if (args.fingerprint(args.plan(false)) !== expected) throw new StalePlan();
      });
      return plan;
    } catch (e) {
      if (e instanceof PlanChanged) {
        plan = args.plan(true);
        attempt--;
        continue;
      }
      if (!(e instanceof StalePlan) && !isCasMiss(e)) throw e;
      if (attempt >= 1)
        throw err.concurrentModification(
          "the vault changed while this move was being committed, twice; nothing was moved. Retry",
          { reason: "plan_stale" },
        );
      plan = args.plan(true);
    }
  }
}

/** Snapshots of the pre-images a batch replaces, taken before its first temp file, so restore_note
 *  can bring any of them back. Retention pruning waits for the batch to land, and a failed batch
 *  drops the rows it added unless its rollback was incomplete: then the pre-images are the only
 *  way back and stay (the same shape commit_wiki_page uses). */
export class PreImageSnapshots {
  private ids: number[] = [];
  private rels: string[] = [];

  constructor(
    private readonly db: Database,
    private readonly cfg: SnapshotCaptureConfig | undefined,
    private readonly vaultId: string,
    private readonly op: string,
    private readonly now: (() => number) | undefined,
  ) {}

  capture(rel: string, raw: string): void {
    const id = captureSnapshot(this.db, this.cfg, this.vaultId, rel, raw, this.op, this.now, false);
    if (id === null) return;
    this.ids.push(id);
    this.rels.push(rel);
  }

  /** The commit failed: drop this attempt's rows unless the rollback was incomplete. */
  failed(e: unknown): void {
    if (!isIncompleteRollback(e)) discardSnapshots(this.db, this.ids);
    this.ids = [];
    this.rels = [];
  }

  /** The commit landed: apply the retention pass that was held back. */
  landed(): void {
    if (this.cfg?.enabled)
      for (const rel of new Set(this.rels))
        pruneSnapshots(this.db, this.vaultId, rel, this.cfg.retention);
  }
}
