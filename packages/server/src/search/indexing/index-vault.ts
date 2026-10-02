// indexVault: the whole-vault walk — two-phase batching (plan+embed outside any transaction,
// apply a batch inside one), stale-note cleanup, edge reconciliation, and aggregated IndexStats.
// Owns the WRITE TRANSACTION boundary for its batches: bumpGeneration runs as its OWN transaction
// after every flush commits, mirroring indexNote's placement (index-note.ts) as the last write
// after applyNoteWrites. The stale-path and excluded-note sweeps live in sweep-notes.ts.
// See docs/design/search-indexing-and-cache.md.
import { tableExists } from "../../db/introspect";
import { inWriteTransaction } from "../../db/txn";
import { errorMessage } from "../../util/errors";
import { isFrontmatterYamlError, parseNote, splitFrontmatterBody } from "../../vault/frontmatter";
import { type ExtractedLink, extractLinks } from "../../vault/links";
import { readNote } from "../../vault/notes-io";
import { resolveVaultPath, walkVault, walkVaultStream } from "../../vault/paths";
import { noteTags } from "../../vault/tags";
import { ensureChunkColbert } from "../chunk_colbert";
import { ensureChunkFts } from "../chunk_fts";
import {
  computeKnnEdges,
  computeKnnEdgesForPaths,
  countDerivedEdges,
  knnDiscoveryScope,
  notesWithTagChanges,
  reconcileDerivedEdges,
  reconcileDerivedEdgesScoped,
  tagCooccurrenceEdges,
  tagCooccurrenceEdgesForNotes,
  tagCooccurrenceScope,
} from "../derived-edges";
import { desiredEdges, reconcileVaultEdges } from "../edges";
import {
  buildNoteRecord,
  ensureNotesFts,
  hasNotesTable,
  type NoteRecord,
  noteRowHash,
  notesRowExpectedForSize,
  upsertNoteRow,
} from "../fts";
import { bumpGeneration } from "../generation";
import { deleteNoteSummary } from "../note-summaries";
import { resolveRetrievalDefaults } from "../retrieval-defaults";
import { ensureChunkSparse } from "../sparse";
import { ensureVecChunks } from "../vec";
import {
  EMBED_BATCH,
  EMBED_CONCURRENCY,
  EMBED_MAX_BATCH_TOKENS,
  embedPlans,
} from "./embed-batches";
import { readLeaderEpoch } from "./leader-epoch";
import {
  computeNotePlan,
  existingRowsMatch,
  hasBodyShaColumn,
  hasDerivedEdgeColumns,
  preloadChunkState,
  readExistingChunkRows,
  readNoteTags,
} from "./note-plan";
import { applyNoteWrites, fireIndexHook } from "./persist-note-plan";
import { sweepUnindexedNotes } from "./sweep-notes";
import type { DedupCache, IndexStats, IndexVaultArgs, NoteWritePlan } from "./types";
import { commitFence, preloadFenceGenerations } from "./write-fence";

// THE-500: default flush thresholds. See docs/design/search-indexing-and-cache.md.
const DEFAULT_BATCH_MAX_NOTES = 100;
const DEFAULT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export async function indexVault(args: IndexVaultArgs): Promise<IndexStats> {
  const now = args.now ?? Date.now;
  // THE-645: captured once, up front, so onProgress reports a stable start time for the whole pass
  // rather than the time of whichever flush happens to fire.
  const startedAt = now();
  // THE-683: the caller passes the manifest it already built; this no longer re-derives one,
  // making cross-derivation drift with runtime/indexing-wiring.ts unrepresentable. A caller
  // without one (tests, eval harnesses) builds it with buildRepresentationManifest, the same
  // function boot uses. See docs/design/search-indexing-and-cache.md.
  const hasVec = ensureVecChunks(args.db, args.representation, {
    now,
    onRebuild: args.onVecRebuild,
    // Fix A: the backfill must match what chunk_embeddings.model actually stores.
    activeModel: args.provider.id,
  });
  // THE-291: notes metadata + FTS ride the reconcile. The UNFILTERED walk backs the stale-path
  // sweep (ACL-invisible-but-present files must never be deindexed); the readable subset drives
  // indexing exactly as before.
  const hasNotes = hasNotesTable(args.db);
  const hasFts = hasNotes && ensureNotesFts(args.db, { now });
  const hasChunkFts = ensureChunkFts(args.db, { now, enrich: args.chunkContext === true });
  const hasEmbedFull = typeof args.provider.embedFull === "function";
  const hasChunkSparse = hasEmbedFull && ensureChunkSparse(args.db);
  const hasChunkColbert = hasEmbedFull && ensureChunkColbert(args.db);
  const hasBodySha = hasBodyShaColumn(args.db);
  // THE-486: whether this vault's vault_edges can even carry derived edges at all (pre-migration dbs
  // cannot) — computed ONCE up front (hasDerivedEdgeColumns memoizes per-db anyway) so the tag-delta
  // snapshot below is skipped entirely when densification could never run this pass.
  const derivedColumnsOk = hasDerivedEdgeColumns(args.db);
  const densifyTagsRequested =
    derivedColumnsOk && args.densify?.tagEdges === true && tableExists(args.db, "notes");
  const densifyKnnRequested = derivedColumnsOk && args.densify?.knnEdges === true;
  // THE-486: the tag-cooccurrence DELTA needs the PRE-pass tag state, so this must be read before any
  // note-row write in this pass commits (the walk below flushes notes inline). newNotesTagsWalked is
  // filled by the walk (fresh tags parsed straight from each readable note's raw content, no DB
  // round-trip needed); deletedPaths + changedChunkPaths are filled by the stale-path sweep and the
  // chunk-write flush respectively, further down.
  const oldNotesTagsSnapshot = densifyTagsRequested
    ? readNoteTags(args.db, args.vaultId)
    : new Map<string, string[]>();
  const newNotesTagsWalked = new Map<string, string[]>();
  // THE-486: notes whose chunk embeddings changed this pass (re-embedded, pruned, or the whole note
  // deleted) — the kNN delta's change signal. A note with no plan this pass had no embedding change.
  const changedChunkPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  // Cross-path embedding dedup (migration 20260719_001): ONE registry shared across the whole walk,
  // so an EMBED text produced under the first walked path is reused/skipped everywhere else this pass.
  // Keyed on content_hash (the enriched embed text under THE-406), not the raw body_sha, so distinctly
  // titled notes never share a vector. Purely in-memory — works even when the body_sha column is absent.
  const dedupRegistry = new Map<string, string>();
  // THE-445: seed the registry from embed texts already embedded in a PRIOR run, so content indexed
  // under an UNCHANGED path (never re-walked this pass) still dedups against a new path carrying the
  // same embed text. First path wins (deterministic by path). Gated on hasBodySha. Self-heals if a
  // seeded path's content changes mid-run — see docs/design/search-indexing-and-cache.md.
  if (hasBodySha) {
    const seeded = args.db
      .prepare(
        "SELECT content_hash AS contentHash, path FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
      )
      .all(args.vaultId) as Array<{ contentHash: string; path: string }>;
    for (const row of seeded) {
      if (!dedupRegistry.has(row.contentHash)) dedupRegistry.set(row.contentHash, row.path);
    }
  }
  // THE-490: the default (non-streaming) path below is UNCHANGED from before this ticket — walked,
  // walkedSet, statByPath and notes are all computed eagerly, exactly as before. The opt-in
  // streaming path (args.walk?.streaming) is deferred to the loop further down, where it walks
  // lazily via walkVaultStream instead, interleaved with per-note processing.
  const streamWalk = args.walk?.streaming === true;
  const walkedSet = new Set<string>();
  let statByPath = new Map<string, { mtime: number; size: number }>();
  let notes: string[] = [];
  // Obsidian's Excluded files (search/index-exclusion.ts): walked, present, link targets — but
  // never indexed. They stay in walkedSet (the file exists) and out of `notes`.
  const isIndexExcluded = args.isIndexExcluded ?? (() => false);
  const excludedWalked: string[] = [];
  if (!streamWalk) {
    const walked = walkVault(args.root, { sub: args.sub, extensions: [".md"] });
    for (const e of walked) walkedSet.add(e.relPath);
    statByPath = new Map(walked.map((e) => [e.relPath, { mtime: e.mtime, size: e.size }]));
    const indexable: string[] = [];
    for (const e of walked)
      (isIndexExcluded(e.relPath) ? excludedWalked : indexable).push(e.relPath);
    notes = indexable.filter(args.isReadable);
  }
  // THE-501: one bulk load of the vault's chunk state (ids/hashes/active-model), so computeNotePlan
  // plans every note from memory instead of a per-note query. Safe because each note owns its path's
  // chunks exclusively, so a note's slice is unaffected by earlier notes' writes in this pass.
  const preloadedExisting = preloadChunkState(args.db, args.vaultId);
  // GH #995 follow-up: one bulk load of the vault's note_write_fence state (mirrors
  // preloadedExisting exactly) so a full reconcile plans every note's fence baseline from memory
  // instead of a per-note query.
  const preloadedFenceGenerations = preloadFenceGenerations(args.db, args.vaultId);
  const stats: IndexStats = {
    notes_seen: notes.length,
    notes_indexed: 0,
    chunks_upserted: 0,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: hasVec,
    fts_enabled: hasFts,
    notes_upserted: 0,
    notes_deleted: 0,
    notes_embed_failed: 0,
    chunks_dedup_reused: 0,
    chunks_dedup_unresolved: 0,
    embed_batch_rejections: 0,
    notes_stale_skipped: 0,
    notes_epoch_stale_skipped: 0,
    notes_frontmatter_failed: 0,
    frontmatter_failures: [],
    model: args.provider.id,
    dimensions: args.provider.dimensions,
  };
  // Collect each note's links during the index walk so vault_edges is reconciled in one
  // full-state pass — the undirected links_to graph W-RETRIEVAL walks (THE-233 W-INGEST).
  const noteLinks = new Map<string, ExtractedLink[]>();
  // THE-934 fix round 4 (2): vault-relative paths under egress.excludePaths seen by this walk.
  const egressExcludedPaths = new Set<string>();
  // Two-phase batching: PLAN each note (including its embed() network call) with no transaction,
  // then APPLY a batch of plans in ONE transaction. A mid-batch failure rolls the whole batch back
  // (idempotent reconcile, never a correctness issue). THE-925 correction: this was previously
  // "safe because indexVault is the sole writer on this connection during the reconcile" — that
  // stopped holding once THE-455 routed write_note/the vault watcher through IndexCoordinator ->
  // indexNote on the SAME connection, unserialized against indexVault. The apply loop below guards
  // against that with a freshness re-check immediately before writing each plan. See
  // docs/design/search-indexing-and-cache.md.
  const BATCH = args.batch?.maxNotes ?? DEFAULT_BATCH_MAX_NOTES;
  const BATCH_MAX_BYTES = args.batch?.maxBytes ?? DEFAULT_BATCH_MAX_BYTES;
  let batch: NoteWritePlan[] = [];
  let batchBytes = 0; // THE-500: accumulated raw note bytes in the pending batch
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const applied = batch;
    batch = [];
    batchBytes = 0;
    // GH #995: a shutdown already in progress when this flush was ABOUT to start — drop this
    // batch's plans without even attempting an embed call. Idempotent: the next reconcile re-plans
    // and re-embeds the same notes from scratch (same self-heal every other stale/aborted-batch
    // path in this file relies on).
    if (args.signal?.aborted) return;
    // THE-277: batch the embed() calls across the whole batch BEFORE opening the write txn, so the
    // reconcile makes ceil(chunks/EMBED_BATCH) requests with a few in flight instead of one serial
    // round-trip per note. The write lock is never held across a network call.
    const report = await embedPlans(
      args.provider,
      applied,
      args.embed?.batchSize ?? EMBED_BATCH,
      args.embed?.concurrency ?? EMBED_CONCURRENCY,
      args.embed?.maxBatchTokens ?? EMBED_MAX_BATCH_TOKENS,
      args.signal,
      args.embedPace,
    );
    // GH #995: the embed pass above was cut short mid-batch — `report` is a quiet no-op stand-in
    // (embed-batches.ts), not a real result. Writing it would commit chunks with no vectors for
    // whatever sub-batches never ran. Drop the whole batch instead; the next reconcile re-plans it.
    if (args.signal?.aborted) return;
    stats.embed_batch_rejections += report.rejections;
    if (report.rejections > 0) {
      process.stderr.write(
        `[index] vault "${args.vaultId}": ${report.rejections} embed request(s) exceeded the ` +
          `provider's context (HTTP 400/413) and were bisected + retried. Lower ` +
          `embeddings.maxBatchTokens to avoid the extra round-trips.\n`,
      );
    }
    // THE-390: a chunk the provider rejects even alone quarantines its NOTE — the rest of the
    // batch still applies and the reconcile completes; the quarantined note keeps serving its
    // last-indexed chunks rather than being pruned to a search hole. Deliberate — do not "fix" by
    // failing the whole reindex. See docs/design/search-indexing-and-cache.md.
    let toApply = applied;
    if (report.failed.length > 0) {
      const failedSet = new Set(report.failed);
      toApply = applied.filter((p) => !failedSet.has(p));
      stats.notes_embed_failed += report.failed.length;
      const sample = report.failed
        .slice(0, 3)
        .map((p) => p.path)
        .join(", ");
      process.stderr.write(
        `[index] vault "${args.vaultId}": embed provider rejected ${report.failed.length} ` +
          `note(s) even at single-text size (${sample}${report.failed.length > 3 ? ", ..." : ""}) ` +
          `— skipped this pass. If this persists, the chunk exceeds the provider's context; ` +
          `use a larger-context embedding model.\n`,
      );
    }
    // THE-488: one dedup-source cache for the WHOLE flush batch — duplicates span notes/paths, so the
    // memo must outlive a single applyNoteWrites call to collapse the repeated JOINs.
    const dedupCache: DedupCache = new Map();
    // THE-588: paths with at least one unresolved dedup skip this batch (owner had no stored vector
    // to copy) — sampled into the stderr warning below, same shape as the failed/rejected warnings.
    const unresolvedPaths: string[] = [];
    // THE-925: paths this flush skipped because a concurrent write_note/watcher commit changed them
    // after their plan was computed — sampled into the stderr warning below.
    const staleSkippedPaths: string[] = [];
    // THE-925: only plans actually WRITTEN this flush feed changedChunkPaths/fireIndexHook below —
    // a plan the guard skips must not be reported as a committed change.
    const appliedPlans: NoteWritePlan[] = [];
    // GH #995 follow-up (demotion residual): re-check the leader epoch THIS RECONCILE RUN started
    // with, inside the same transaction the batch commits in — a successor may have promoted since
    // this run began, mid-batch, while an embed sub-batch above was in flight. note_write_fence
    // alone cannot always catch this: a successor's own reconcile may not yet (or ever) replan a
    // note whose content this stale batch is about to commit unchanged, so it never bumps that
    // note's fence. `epochStale` gates the WHOLE batch's apply loop below rather than aborting the
    // transaction — an empty commit is harmless and cheaper than a rollback.
    //
    // Fix round (cross-vendor review): the read MUST happen inside the transaction callback, not
    // before `inWriteTransaction` is called. WAL lets a successor's `bumpLeaderEpoch` (an autocommit
    // write) land between an outside-the-transaction read and this call's own `BEGIN IMMEDIATE`,
    // which would silently widen the race window this check exists to close. `epochStale` is
    // reassigned from inside the callback so the stats increment below still sees the real value.
    let epochStale = false;
    inWriteTransaction(
      args.db,
      "index_batch",
      () => {
        epochStale =
          args.leaderEpoch !== undefined && readLeaderEpoch(args.db) !== args.leaderEpoch;
        if (epochStale) return;
        for (const plan of toApply) {
          // THE-925 invariant: indexVault plans+embeds a whole batch OUTSIDE any transaction, then
          // applies it here, inside one. That gap is a real race window on this connection —
          // write_note/the vault watcher (THE-455's IndexCoordinator -> indexNote) write the SAME
          // cache.db and are not serialized against indexVault. Immediately before writing THIS
          // plan, re-read the path's current chunk rows and compare them to the `existing` snapshot
          // the plan was computed against (see readExistingChunkRows/existingRowsMatch, note-plan.ts).
          // A mismatch means a concurrent commit landed in the gap: applying the stale plan anyway
          // would either revert that commit's fresher content back to what this plan saw, or prune
          // chunk ids it already rewrote. Skip instead — the concurrent writer already left this
          // path correct, and the next index_vault re-plans it against current content either way.
          const current = readExistingChunkRows(args.db, args.vaultId, plan.path);
          if (!existingRowsMatch(plan.existing, current)) {
            staleSkippedPaths.push(plan.path);
            stats.notes_stale_skipped += 1;
            continue;
          }
          const r = applyNoteWrites(
            args.db,
            args.provider,
            args.vaultId,
            plan,
            hasVec,
            hasChunkFts,
            hasChunkSparse,
            hasChunkColbert,
            hasBodySha,
            dedupCache,
          );
          // GH #995 follow-up: a backstop, not the common case — existingRowsMatch above already
          // catches the process-local shape this connection can observe. applyNoteWrites'
          // commitFence additionally catches a same-content re-write racing a deindex tombstone
          // (existingRowsMatch alone cannot: the row shape can coincidentally match again after a
          // delete-then-identical-recreate). Same treatment as the existingRowsMatch skip above.
          if (r.staleSkipped) {
            staleSkippedPaths.push(plan.path);
            stats.notes_stale_skipped += 1;
            continue;
          }
          stats.chunks_upserted += r.upserted;
          stats.chunks_deleted += r.deleted;
          stats.chunks_dedup_unresolved += r.dedupUnresolved;
          if (r.dedupUnresolved > 0) unresolvedPaths.push(plan.path);
          if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
          appliedPlans.push(plan);
        }
      },
      args.sql,
    );
    if (epochStale) stats.notes_epoch_stale_skipped += toApply.length;
    if (unresolvedPaths.length > 0) {
      const sample = unresolvedPaths.slice(0, 3).join(", ");
      process.stderr.write(
        `[ingest] vault "${args.vaultId}": ${unresolvedPaths.length} note(s) had a dedup-skipped ` +
          `chunk with no source vector to copy (${sample}${unresolvedPaths.length > 3 ? ", ..." : ""}) ` +
          `— those chunks are FTS-only until the owner re-embeds successfully.\n`,
      );
    }
    if (staleSkippedPaths.length > 0) {
      const sample = staleSkippedPaths.slice(0, 3).join(", ");
      process.stderr.write(
        `[index] vault "${args.vaultId}": ${staleSkippedPaths.length} note(s) skipped this pass — a ` +
          `concurrent write_note/watcher commit changed the path's chunks after this plan was ` +
          `computed (${sample}${staleSkippedPaths.length > 3 ? ", ..." : ""}); the next index_vault ` +
          `reconciles them against current content.\n`,
      );
    }
    if (epochStale) {
      process.stderr.write(
        `[index] vault "${args.vaultId}": dropped a whole batch of ${toApply.length} note(s) — a ` +
          `successor has promoted leadership since this reconcile started (GH #995 follow-up); the ` +
          `successor's own reconcile supersedes this run.\n`,
      );
    }
    // THE-486: a committed plan means this note's chunk embeddings changed this pass (toEmbed
    // non-empty and/or a prune) — computeNotePlan never returns a plan otherwise (see its
    // toEmbed.length === 0 && !willPrune early return). This is the kNN delta's change signal,
    // reusing the SAME plan data fireIndexHook already reports rather than threading a new seam.
    for (const plan of appliedPlans) changedChunkPaths.add(plan.path);
    for (const plan of appliedPlans) fireIndexHook(args.onIndexed, plan);
    // THE-645: once per completed batch (never per-chunk, per the perf-gate note on IndexVaultArgs)
    // — a straight projection of the running `stats` accumulator, no new counters. `notesSeen` is
    // the streaming path's honest "unknown" (-1): the eager total isn't known until the walk
    // finishes (see THE-490's comment above), so a fabricated total would render a false percentage.
    args.onProgress?.({
      notesSeen: streamWalk ? -1 : notes.length,
      notesProcessed: stats.notes_indexed,
      chunksUpserted: stats.chunks_upserted,
      startedAt,
    });
  };
  // THE-291: the notes/FTS pass is flushed INDEPENDENTLY of the chunk/embed pass (deliberate
  // atomicity gap), so a broken embedding backend cannot block metadata/FTS readiness. Safe ONLY
  // because the next index_vault self-heals either side; pinned by test/index-selfheal.test.ts —
  // do not break it. See docs/design/search-indexing-and-cache.md.
  let notesBatch: NoteRecord[] = [];
  const flushNotes = (): void => {
    if (!hasNotes || notesBatch.length === 0) return;
    const rows = notesBatch;
    notesBatch = [];
    const upserted = inWriteTransaction(
      args.db,
      "index_notes_flush",
      () => {
        let landed = 0;
        for (const rec of rows) {
          // Fix round (cross-vendor review): a notes-row-only backfill (plan==null but the row is
          // missing/stale) previously bypassed BOTH fences entirely — a demoted leader's stale
          // metadata could overwrite fresher content, or resurrect a note's search-visible row
          // after a successor's deindex, since neither commitFence nor readLeaderEpoch ever ran
          // for this write. Same commit-time re-check as applyNoteWrites, but only when this row is
          // the SOLE write for its path this pass — see NoteRecord.fenceCheckRequired's own
          // comment for why a plan-carrying row must NOT also bump this same generation here.
          if (rec.fenceCheckRequired) {
            const fence = commitFence(args.db, args.vaultId, rec.path, rec.fenceGeneration, now());
            if (!fence.ok) continue;
          }
          upsertNoteRow(args.db, args.vaultId, rec, hasFts, now());
          landed += 1;
        }
        return landed;
      },
      args.sql,
    );
    stats.notes_upserted += upserted;
    stats.notes_stale_skipped += rows.length - upserted;
  };
  // THE-490: the per-note processing body, shared by both the eager (default) and streaming
  // (opt-in) walk paths — extracted so it exists ONCE rather than drifting between two copies.
  // `stat` is the note's own {mtime,size} from whichever WalkEntry produced `rel` (looked up from
  // statByPath in the default path; carried directly off the streamed entry in the streaming path
  // — either way the SAME values buildNoteRecord/batchBytes used before this ticket).
  const processNote = async (
    rel: string,
    stat: { mtime: number; size: number } | null,
  ): Promise<void> => {
    const raw = readNote(resolveVaultPath(args.root, rel)).raw;
    // THE-1073: probe-parse ONCE, here, before anything else touches this note's frontmatter
    // (buildNoteRecord/noteTags below both call parseNote themselves and would throw on the SAME
    // note otherwise). A YAML failure quarantines just this note — counted, listed, and named in
    // one sampled stderr line after the walk completes (below) — rather than escaping processNote
    // and rejecting the whole indexVault pass for every OTHER note in the batch (THE-1073's
    // production incident: one bad note held 17 notes out of the index for nine days). The note
    // stays in walkedSet (added by the caller before processNote runs), so it is never swept as
    // stale, and neither this flush nor flushNotes is vetoed for the rest of the batch. Any other
    // error (I/O, DB) is NOT caught here and propagates exactly as before.
    let parsed: ReturnType<typeof parseNote>;
    try {
      parsed = parseNote(raw, rel);
    } catch (e) {
      if (!isFrontmatterYamlError(e)) throw e;
      stats.notes_frontmatter_failed += 1;
      stats.frontmatter_failures.push({ path: rel, error: errorMessage(e) });
      // THE-1073 fix round 2 (HIGH, both reviewers): still extract this note's OWN links from its
      // REAL body — splitFrontmatterBody never parses YAML, so it works even here — instead of
      // leaving noteLinks empty for this path. reconcileVaultEdges uses INSERT OR IGNORE on
      // (source,target,type), so a stored row's provenance is fixed at first insert and never
      // updated by a later pass; reconstructing synthetic links from those rows (fix round 1's
      // approach) could resurrect a link this note no longer has, or miss one it just gained. This
      // note is still skipped for chunk/note-row writes (return below), but its edges are
      // recomputed exactly as if the YAML were valid.
      noteLinks.set(rel, extractLinks(splitFrontmatterBody(raw)));
      return;
    }
    // THE-823: `rel` must be threaded into link extraction here, not left for the caller to infer.
    // See docs/design/search-indexing-and-cache.md.
    noteLinks.set(rel, extractLinks(parsed.body));
    // THE-934 fix round 4 (2): every walked note that is currently excluded, whether or not this
    // pass produces a write plan for it. computeNotePlan returns `plan: null` when nothing about a
    // note's chunks changed, which is the STEADY state for an already-excluded note -- so a
    // cleanup hung off the plan (persist-note-plan.ts's own DELETE) fires on the exclusion
    // TRANSITION and never again. Collected here and swept once below, so a note stamped excluded
    // by an earlier reconcile still loses its summary row on the next one.
    if (args.isEgressExcluded?.(rel) === true) egressExcludedPaths.add(rel);
    // THE-486: capture this pass's tags straight from the raw content (no DB round-trip) so the
    // tag-cooccurrence delta can diff against oldNotesTagsSnapshot below — a note's frontmatter tags
    // can change with NO chunk content change, so this must NOT be gated on `plan` existing.
    if (densifyTagsRequested) newNotesTagsWalked.set(rel, noteTags(raw, rel).all);
    const { plan, unchanged, secretsSkipped, flagged, dedupSkipped } = computeNotePlan(
      args.db,
      args.vaultId,
      rel,
      raw,
      now(),
      args.chunkContext === true,
      dedupRegistry,
      hasBodySha, // THE-454: dedup (and thus vector-copy) only when the body_sha column exists
      args.provider.id, // THE-531: re-embed a model-superseded chunk even when content is unchanged
      preloadedExisting, // THE-501: plan from the bulk chunk-state load, no per-note query
      args.chunkTokens, // THE-424: indexing.chunkTokens; undefined -> the chunker's 512 default
      args.isEgressExcluded, // THE-934: egress.excludePaths; undefined -> nothing excluded
      parsed.body, // THE-1073: reuse the probe-parse above; this note already parsed successfully
      preloadedFenceGenerations, // GH #995 follow-up: bulk fence-state load, no per-note query
    );
    stats.chunks_unchanged += unchanged;
    stats.secrets_skipped += secretsSkipped;
    stats.chunks_dedup_reused += dedupSkipped; // THE-499: aggregate, not per-chunk stderr
    if (hasNotes && notesRowExpectedForSize(Buffer.byteLength(raw))) {
      const rec = buildNoteRecord(rel, raw, flagged, stat, now());
      if (noteRowHash(args.db, args.vaultId, rel) !== rec.contentHash) {
        // Fix round (cross-vendor review): the SAME preloaded fence baseline the chunk plan above
        // captured for this path — flushNotes re-checks it with commitFence inside its own write
        // transaction, so a notes-row-ONLY backfill (no accompanying chunk plan this pass) can no
        // longer land after a fresher commit or a deindex tombstone for this path. A note WITH a
        // plan this pass is fenced by applyNoteWrites instead (see NoteRecord.fenceCheckRequired).
        rec.fenceGeneration = preloadedFenceGenerations.get(rel) ?? 0;
        rec.fenceCheckRequired = plan === null;
        notesBatch.push(rec);
        if (notesBatch.length >= BATCH) flushNotes();
      }
    }
    if (plan) {
      batch.push(plan);
      // THE-500: flush on EITHER the note-count or the byte budget, so a run of large notes commits
      // as several bounded transactions rather than one oversized one.
      batchBytes += stat?.size ?? raw.length;
      if (batch.length >= BATCH || batchBytes >= BATCH_MAX_BYTES) await flush();
    }
  };
  if (streamWalk) {
    // THE-490: walk lazily, processing (and thus starting to embed) each readable note as soon as
    // its directory has been read, instead of waiting for the entire tree to be walked first.
    for await (const e of walkVaultStream(args.root, { sub: args.sub, extensions: [".md"] })) {
      walkedSet.add(e.relPath);
      if (isIndexExcluded(e.relPath)) {
        excludedWalked.push(e.relPath);
        continue;
      }
      if (!args.isReadable(e.relPath)) continue;
      notes.push(e.relPath);
      await processNote(e.relPath, { mtime: e.mtime, size: e.size });
    }
  } else {
    for (const rel of notes) {
      await processNote(rel, statByPath.get(rel) ?? null);
    }
  }
  stats.notes_seen = notes.length; // THE-490: notes is only fully known once the walk above completes
  // THE-1073: ONE sampled stderr line for the whole pass, same shape as THE-390's embed-rejection
  // warning above — every failing path is still in stats.frontmatter_failures (not just the
  // sample), which is what feeds plane-wiring.ts's per-path health mapping.
  if (stats.notes_frontmatter_failed > 0) {
    const sample = stats.frontmatter_failures
      .slice(0, 3)
      .map((f) => f.path)
      .join(", ");
    process.stderr.write(
      `[index] vault "${args.vaultId}": ${stats.notes_frontmatter_failed} note(s) skipped: ` +
        `frontmatter is not valid YAML (${sample}${stats.notes_frontmatter_failed > 3 ? ", ..." : ""})\n`,
    );
  }
  flushNotes();
  // THE-934 fix round 4 (2): the note_summaries sweep for EVERY excluded note this pass walked,
  // not only the ones whose exclusion status just changed. A note_summaries row is model-generated
  // text derived from the note, is searchable through searchNoteSummaries, and feeds
  // buildClusterSummaries' k-means membership, so an excluded note must own none.
  //
  // This is the walk's own copy of a cleanup applyNoteWrites (persist-note-plan.ts) also performs,
  // and the redundancy is deliberate rather than accidental. applyNoteWrites covers the common
  // case only because an excluded note happens to re-plan on every pass — an excluded chunk can
  // never hold an active embedding, so computeNotePlan's THE-531 model gate keeps it in `toEmbed`
  // forever. That is a property of a DIFFERENT feature, and a note with no chunks at all (emptied
  // on disk, or every chunk secret-gated) already falls outside it: `computeNotePlan` returns
  // `plan: null`, nothing downstream of it runs, and only this sweep can reach the row. Both are
  // tested (test/egress-index-embedding.test.ts).
  //
  // Unconditional and idempotent (a DELETE matching nothing costs an index seek), bounded by the
  // number of EXCLUDED notes rather than by vault size, and batched into one transaction the same
  // way the notes flush above is.
  if (egressExcludedPaths.size > 0) {
    inWriteTransaction(
      args.db,
      "index_egress_summaries",
      () => {
        for (const rel of egressExcludedPaths) deleteNoteSummary(args.db, args.vaultId, rel);
      },
      args.sql,
    );
  }
  // Remove the index state of excluded notes and (unscoped runs only) of notes no longer on disk.
  stats.notes_deleted += sweepUnindexedNotes({
    args,
    hasVec,
    now,
    walkedSet,
    excludedWalked,
    sweepGone: hasNotes && args.sub === undefined,
    deletedPaths,
    changedChunkPaths,
  });
  args.onNotesPass?.();
  await flush();
  // Edge maintenance is full-state (resolving targets needs the whole note universe), so it
  // runs once per indexVault pass, not per-note-write. Skipped gracefully when vault_edges is
  // absent (pre-integration, before W-SCHEMA lands).
  if (tableExists(args.db, "vault_edges")) {
    const edgeStats = reconcileVaultEdges(
      args.db,
      args.vaultId,
      // The link universe includes the excluded notes (a wikilink to one RESOLVES), but the graph
      // layer omits them, like Obsidian's Graph view: desiredEdges drops every edge touching one.
      desiredEdges(
        noteLinks,
        [...notes, ...excludedWalked.filter(args.isReadable)],
        new Set(excludedWalked),
      ),
      now,
    );
    stats.edges_inserted = edgeStats.inserted;
    stats.edges_deleted = edgeStats.deleted;
    // Densification (THE-486, docs/plans/2026-07-13-graph-densification.md): derived edges —
    // shared-tag co-occurrence + vec0 kNN neighbors — reconciled on their OWN edge_types, so the
    // literal layer and the LLM layer (semantically_similar_to) are never touched here. A flag OFF
    // reconciles to an EMPTY desired set (so turning it off actually prunes); a flag ON reconciles
    // DELTA-only once a baseline exists, falling back to a full recompute on cold start. Guarded on
    // derivedColumnsOk: a pre-migration-20260713_001 vault_edges would throw on the upsert.
    // See docs/design/search-indexing-and-cache.md.
    if (derivedColumnsOk) {
      const tagFanout = { maxTagFanout: args.densify?.maxTagFanout ?? 25 };
      if (!densifyTagsRequested) {
        reconcileDerivedEdges(args.db, args.vaultId, [], ["shared_tag"], now);
      } else if (countDerivedEdges(args.db, args.vaultId, "shared_tag") === 0) {
        // Cold start: readNoteTags reads notes AFTER this pass's upserts/deletes have committed.
        const tagDesired = tagCooccurrenceEdges(readNoteTags(args.db, args.vaultId), tagFanout);
        reconcileDerivedEdges(args.db, args.vaultId, tagDesired, ["shared_tag"], now);
      } else {
        // THE-486 warm delta: the FULL post-pass tag map is the old snapshot overlaid with this
        // pass's walked notes' fresh tags, minus anything deleted. See design note for why this is
        // cheaper than a full re-read yet equivalent to one.
        const newNotesTagsFull = new Map(oldNotesTagsSnapshot);
        for (const [path, tags] of newNotesTagsWalked) newNotesTagsFull.set(path, tags);
        for (const path of deletedPaths) newNotesTagsFull.delete(path);
        const tagChangedNotes = notesWithTagChanges(oldNotesTagsSnapshot, newNotesTagsFull, [
          ...newNotesTagsWalked.keys(),
          ...deletedPaths,
        ]);
        // Mirrors the kNN branch below: no note's tags changed this pass -> skip entirely, same
        // "no scan on a true no-op" guarantee applied to the tag layer.
        if (tagChangedNotes.size > 0) {
          const scope = tagCooccurrenceScope(
            oldNotesTagsSnapshot,
            newNotesTagsFull,
            tagChangedNotes,
          );
          const tagDesired = tagCooccurrenceEdgesForNotes(newNotesTagsFull, scope, tagFanout);
          reconcileDerivedEdgesScoped(
            args.db,
            args.vaultId,
            tagDesired,
            ["shared_tag"],
            scope,
            now,
          );
        }
      }

      // ADR-0007: the floor's constant lives in retrieval-defaults.ts. No stat derives it (the index
      // records no neighbour-similarity distribution), so this resolves config > constant only.
      const knnOpts = {
        k: args.densify?.knnK ?? 8,
        minSim: resolveRetrievalDefaults(null, { knnMinSim: args.densify?.knnMinSim }).knnMinSim
          .value,
      };
      if (!densifyKnnRequested) {
        reconcileDerivedEdges(args.db, args.vaultId, [], ["similar_to"], now);
      } else if (countDerivedEdges(args.db, args.vaultId, "similar_to") === 0) {
        const knnDesired = computeKnnEdges(args.db, args.vaultId, knnOpts);
        reconcileDerivedEdges(args.db, args.vaultId, knnDesired, ["similar_to"], now);
      } else if (changedChunkPaths.size > 0) {
        // THE-533: knnDiscoveryScope, not a narrower edge-only scope — the edge-only expansion
        // cannot reach a note that would newly rank a changed/new note in its OWN top-k without
        // being ranked back, so this needs the forward vector neighbours too. See design note.
        const scope = knnDiscoveryScope(args.db, args.vaultId, changedChunkPaths, knnOpts);
        const knnDesired = computeKnnEdgesForPaths(args.db, args.vaultId, scope, knnOpts);
        reconcileDerivedEdgesScoped(args.db, args.vaultId, knnDesired, ["similar_to"], scope, now);
      }
      // else: densifyKnnRequested but changedChunkPaths is empty — nothing this pass could have
      // invalidated, so skip entirely rather than pay a kNN scan on a warm no-op pass.
    }
  }
  // THE-496: bump the vault generation once per reconcile when anything result-affecting changed —
  // chunk upserts/deletes OR edge/densification changes. The bump is its own tiny transaction after
  // the flushes have committed; the idempotent reconcile re-bumps if a crash lands between the last
  // flush and here, and over-bumping is only a cache miss.
  const changed =
    stats.chunks_upserted > 0 ||
    stats.chunks_deleted > 0 ||
    stats.edges_inserted > 0 ||
    stats.edges_deleted > 0;
  if (changed) {
    inWriteTransaction(
      args.db,
      "index_generation",
      () => bumpGeneration(args.db, args.vaultId),
      args.sql,
    );
  }
  // THE-499: one aggregate dedup line per pass (was ~1 stderr line per duplicate chunk). Individual
  // paths are available behind OBSIDIAN_TC_DEBUG_DEDUP (emitted inline in computeNotePlan).
  if (stats.chunks_dedup_reused > 0) {
    process.stderr.write(
      `[index] vault "${args.vaultId}": dedup reused ${stats.chunks_dedup_reused} chunk embedding(s) from identical-body siblings (copied, not recomputed)\n`,
    );
  }
  return stats;
}
