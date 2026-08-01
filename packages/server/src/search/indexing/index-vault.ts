// WP3 slice 3 (docs/plans/2026-07-30-codebase-refactor-map.md): indexVault, moved verbatim out of
// indexer.ts — the whole-vault walk, two-phase batching (plan+embed outside any transaction, apply a
// batch inside one), stale-note cleanup, edge reconciliation (literal + derived), and aggregated
// IndexStats. It owns the WRITE TRANSACTION boundary (inWriteTransaction) for its batches: the
// generation bump (bumpGeneration) at the end runs as its OWN transaction, after every flush has
// committed, mirroring indexNote's placement (see index-note.ts) of the bump as the last write in a
// transaction that follows applyNoteWrites. index-note.ts's deindexNote is imported here for the
// stale-path sweep — a sibling import, not a cycle (importing indexer.ts itself, the facade, would be).
import { tableExists } from "../../db/introspect";
import { inWriteTransaction } from "../../db/txn";
import { parseNote } from "../../vault/frontmatter";
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
  upsertNoteRow,
} from "../fts";
import { bumpGeneration } from "../generation";
import {
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
} from "../representation";
import { ensureChunkSparse } from "../sparse";
import { ensureVecChunks } from "../vec";
import {
  EMBED_BATCH,
  EMBED_CONCURRENCY,
  EMBED_MAX_BATCH_TOKENS,
  embedPlans,
} from "./embed-batches";
import { deindexNote } from "./index-note";
import {
  computeNotePlan,
  hasBodyShaColumn,
  hasDerivedEdgeColumns,
  preloadChunkState,
  readNoteTags,
} from "./note-plan";
import { applyNoteWrites, fireIndexHook } from "./persist-note-plan";
import type { DedupCache, IndexStats, IndexVaultArgs, NoteWritePlan } from "./types";

// THE-500 defaults: 100 notes was the prior hardcoded flush size; 8 MiB caps a batch of large notes.
const DEFAULT_BATCH_MAX_NOTES = 100;
const DEFAULT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export async function indexVault(args: IndexVaultArgs): Promise<IndexStats> {
  const now = args.now ?? Date.now;
  // THE-460: fold the embedding provider/model/dims + the fixed representation constants +
  // whether chunkContext enrichment is on (it changes the embedded text) into one fingerprint,
  // so ANY representation change — not only a dimension change — rebuilds vec_chunks.
  const hasVec = ensureVecChunks(
    args.db,
    {
      provider: args.provider.provider,
      model: args.provider.model,
      dimensions: args.provider.dimensions,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: args.chunkContext === true ? ENRICHMENT_VERSION : 0,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
      // Must match runtime/indexing-wiring.ts exactly. If these diverge, boot and index_vault each
      // DROP and rebuild the table the other just built — an unbounded rebuild loop.
      revision: args.revision,
    },
    {
      now,
      onRebuild: args.onVecRebuild,
      // Fix A: the backfill must match what chunk_embeddings.model actually stores.
      activeModel: args.provider.id,
    },
  );
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
  // under an UNCHANGED path (never re-walked this pass, hence not registered below) still dedups a new
  // path carrying the same embed text. First path wins (deterministic by path). Gated on hasBodySha,
  // which mirrors when the copy path is active (dedupEnabled). Caveat: if a seeded first path's content
  // CHANGES this same run, a same-embed-text new path defers to a now-stale first path; it self-heals
  // on the next reindex (the new path then becomes the first).
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
  if (!streamWalk) {
    const walked = walkVault(args.root, { sub: args.sub, extensions: [".md"] });
    for (const e of walked) walkedSet.add(e.relPath);
    statByPath = new Map(walked.map((e) => [e.relPath, { mtime: e.mtime, size: e.size }]));
    notes = walked.map((e) => e.relPath).filter(args.isReadable);
  }
  // THE-501: one bulk load of the vault's chunk state (ids/hashes/active-model), so computeNotePlan
  // plans every note from memory instead of a per-note query. Safe because each note owns its path's
  // chunks exclusively, so a note's slice is unaffected by earlier notes' writes in this pass.
  const preloadedExisting = preloadChunkState(args.db, args.vaultId);
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
    model: args.provider.id,
    dimensions: args.provider.dimensions,
  };
  // Collect each note's links during the index walk so vault_edges is reconciled in one
  // full-state pass — the undirected links_to graph W-RETRIEVAL walks (THE-233 W-INGEST).
  const noteLinks = new Map<string, ExtractedLink[]>();
  // Two-phase batching: PLAN each note (including its embed() network call) with no transaction,
  // then APPLY a batch of plans in ONE transaction. The write lock is never held across a note's
  // embed, and a K-note reconcile pays ~ceil(N/BATCH) fsyncs instead of N. A batch is the atomic
  // unit — a mid-batch failure rolls the whole batch back; that only costs re-work (the reconcile
  // is idempotent, the content-hash skip re-converges next pass), never correctness. Safe because
  // indexVault is the sole writer on this single connection during the reconcile, so a plan's
  // pre-read `existing` snapshot cannot be raced before its apply.
  const BATCH = args.batch?.maxNotes ?? DEFAULT_BATCH_MAX_NOTES;
  const BATCH_MAX_BYTES = args.batch?.maxBytes ?? DEFAULT_BATCH_MAX_BYTES;
  let batch: NoteWritePlan[] = [];
  let batchBytes = 0; // THE-500: accumulated raw note bytes in the pending batch
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const applied = batch;
    batch = [];
    batchBytes = 0;
    // Batch the embed() calls across the whole batch (THE-277) BEFORE opening the write txn, so the
    // reconcile makes ceil(chunks/EMBED_BATCH) requests with a few in flight instead of one serial
    // round-trip per note. The write lock is still never held across a network call.
    const report = await embedPlans(
      args.provider,
      applied,
      args.embed?.batchSize ?? EMBED_BATCH,
      args.embed?.concurrency ?? EMBED_CONCURRENCY,
      args.embed?.maxBatchTokens ?? EMBED_MAX_BATCH_TOKENS,
    );
    stats.embed_batch_rejections += report.rejections;
    if (report.rejections > 0) {
      process.stderr.write(
        `[index] vault "${args.vaultId}": ${report.rejections} embed request(s) exceeded the ` +
          `provider's context (HTTP 400/413) and were bisected + retried. Lower ` +
          `embeddings.maxBatchTokens to avoid the extra round-trips.\n`,
      );
    }
    // THE-390: a chunk the provider rejects even alone quarantines its NOTE — the rest of the
    // batch still applies and the reconcile completes (surfaced via stats + reconcile health;
    // the content-hash skip retries the note next pass). Deliberate consequence: a quarantined
    // note keeps serving its LAST-INDEXED chunks (stale-but-consistent) rather than being pruned
    // to a search hole or failing the whole reindex; its notes/FTS metadata may be newer, which
    // the notes pass already allows by design (THE-291 independence).
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
    inWriteTransaction(
      args.db,
      "index_batch",
      () => {
        for (const plan of toApply) {
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
          stats.chunks_upserted += r.upserted;
          stats.chunks_deleted += r.deleted;
          stats.chunks_dedup_unresolved += r.dedupUnresolved;
          if (r.dedupUnresolved > 0) unresolvedPaths.push(plan.path);
          if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
        }
      },
      args.sql,
    );
    if (unresolvedPaths.length > 0) {
      const sample = unresolvedPaths.slice(0, 3).join(", ");
      process.stderr.write(
        `[ingest] vault "${args.vaultId}": ${unresolvedPaths.length} note(s) had a dedup-skipped ` +
          `chunk with no source vector to copy (${sample}${unresolvedPaths.length > 3 ? ", ..." : ""}) ` +
          `— those chunks are FTS-only until the owner re-embeds successfully.\n`,
      );
    }
    // THE-486: a committed plan means this note's chunk embeddings changed this pass (toEmbed
    // non-empty and/or a prune) — computeNotePlan never returns a plan otherwise (see its
    // toEmbed.length === 0 && !willPrune early return). This is the kNN delta's change signal,
    // reusing the SAME plan data fireIndexHook already reports rather than threading a new seam.
    for (const plan of toApply) changedChunkPaths.add(plan.path);
    for (const plan of toApply) fireIndexHook(args.onIndexed, plan);
  };
  // The two-transaction split (notes vs chunks) is a deliberate atomicity gap; it is safe ONLY because
  // the next index_vault self-heals either side (an absent chunk set re-embeds; a missing notes row is
  // rewritten). That invariant is pinned by test/index-selfheal.test.ts — do not break it.
  // THE-291: the notes/FTS pass is flushed INDEPENDENTLY of the chunk/embed pass, so a broken
  // embedding backend cannot block metadata/FTS readiness (they need no embeddings). Notes
  // batches commit inline during the walk; chunk plans still batch through the embed flush.
  let notesBatch: NoteRecord[] = [];
  const flushNotes = (): void => {
    if (!hasNotes || notesBatch.length === 0) return;
    const rows = notesBatch;
    notesBatch = [];
    inWriteTransaction(
      args.db,
      "index_notes_flush",
      () => {
        for (const rec of rows) upsertNoteRow(args.db, args.vaultId, rec, hasFts, now());
      },
      args.sql,
    );
    stats.notes_upserted += rows.length;
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
    noteLinks.set(rel, extractLinks(parseNote(raw).body));
    // THE-486: capture this pass's tags straight from the raw content (no DB round-trip) so the
    // tag-cooccurrence delta can diff against oldNotesTagsSnapshot below — a note's frontmatter tags
    // can change with NO chunk content change, so this must NOT be gated on `plan` existing.
    if (densifyTagsRequested) newNotesTagsWalked.set(rel, noteTags(raw).all);
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
    );
    stats.chunks_unchanged += unchanged;
    stats.secrets_skipped += secretsSkipped;
    stats.chunks_dedup_reused += dedupSkipped; // THE-499: aggregate, not per-chunk stderr
    if (hasNotes && raw !== "") {
      const rec = buildNoteRecord(rel, raw, flagged, stat, now());
      if (noteRowHash(args.db, args.vaultId, rel) !== rec.contentHash) {
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
  flushNotes();
  // THE-291: stale-path sweep — ONLY on unscoped runs (a folder-scoped index_vault call must
  // never deindex the rest of the vault), and diffed against the UNFILTERED walk so files an
  // ACL-restricted caller cannot see are not destroyed.
  if (hasNotes && args.sub === undefined) {
    const known = args.db
      .prepare("SELECT path FROM notes WHERE vault_id = ?")
      .all(args.vaultId) as Array<{ path: string }>;
    for (const row of known) {
      if (!walkedSet.has(row.path)) {
        deindexNote(args.db, args.vaultId, row.path, hasVec, args.chunkContext === true, args.sql);
        stats.notes_deleted += 1;
        // THE-486: a deleted note's chunk embeddings AND its tags are both gone — both delta
        // computations need to know, so its derived edges in both directions get pruned rather than
        // orphaned (a scope that omits it would never delete a stale edge pointing at it).
        deletedPaths.add(row.path);
        changedChunkPaths.add(row.path);
      }
    }
  }
  args.onNotesPass?.();
  await flush();
  // Edge maintenance is full-state (resolving targets needs the whole note universe), so it
  // runs once per indexVault pass, not per-note-write. Skipped gracefully when vault_edges is
  // absent (pre-integration, before W-SCHEMA lands).
  if (tableExists(args.db, "vault_edges")) {
    const edgeStats = reconcileVaultEdges(
      args.db,
      args.vaultId,
      desiredEdges(noteLinks, notes),
      now,
    );
    stats.edges_inserted = edgeStats.inserted;
    stats.edges_deleted = edgeStats.deleted;
    // Densification (docs/plans/2026-07-13-graph-densification.md): derived edges — shared-tag
    // co-occurrence + vec0 kNN neighbors — reconciled on their OWN edge_types, so the literal layer and
    // the LLM layer (semantically_similar_to, built out-of-band by the densify-llm runner) are never
    // touched here.
    //
    // THE-486: a flag OFF still reconciles to an EMPTY desired set via the FULL reconcileDerivedEdges —
    // that is what makes "turn the flag off" actually prune (the layer must not survive invisibly,
    // ready to reappear the moment the flag flips back on). A flag ON reconciles DELTA-only once a
    // baseline exists: only the notes/chunks this pass actually touched (plus, for kNN, their existing
    // edge-neighbors and forward vector neighbors — see knnDiscoveryScope) are re-scored; edges
    // entirely outside that scope are
    // assumed already correct and are never read or rewritten. The very FIRST on-pass (no rows of this
    // edge_type exist yet — "cold start", which also covers a flag just flipped from off, since off
    // always prunes to zero) has no delta baseline to build on and falls back to the full recompute,
    // exactly matching the old always-full behaviour for that one pass.
    // Guarded on the densification columns: reconciling unconditionally against a vault_edges that
    // predates migration 20260713_001 would throw on the upsert and kill the entire index pass.
    if (derivedColumnsOk) {
      const tagFanout = { maxTagFanout: args.densify?.maxTagFanout ?? 25 };
      if (!densifyTagsRequested) {
        reconcileDerivedEdges(args.db, args.vaultId, [], ["shared_tag"], now);
      } else if (countDerivedEdges(args.db, args.vaultId, "shared_tag") === 0) {
        // Cold start: build the FULL post-pass tag map the same way a from-scratch reconcile would —
        // readNoteTags reads notes AFTER this pass's upserts/deletes have all committed.
        const tagDesired = tagCooccurrenceEdges(readNoteTags(args.db, args.vaultId), tagFanout);
        reconcileDerivedEdges(args.db, args.vaultId, tagDesired, ["shared_tag"], now);
      } else {
        // THE-486 warm delta: the FULL post-pass tag map is the old snapshot overlaid with this pass's
        // walked notes' fresh tags, minus anything deleted — cheaper than re-reading the whole notes
        // table, and exactly what it would read anyway (every untouched note keeps its old value).
        const newNotesTagsFull = new Map(oldNotesTagsSnapshot);
        for (const [path, tags] of newNotesTagsWalked) newNotesTagsFull.set(path, tags);
        for (const path of deletedPaths) newNotesTagsFull.delete(path);
        const tagChangedNotes = notesWithTagChanges(oldNotesTagsSnapshot, newNotesTagsFull, [
          ...newNotesTagsWalked.keys(),
          ...deletedPaths,
        ]);
        // Mirrors the kNN branch below: NO note's tags changed this pass -> skip the call entirely
        // (not even the scope build runs), same "no scan on a true no-op" guarantee as acceptance
        // criterion 1, applied to the tag layer too.
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

      const knnOpts = { k: args.densify?.knnK ?? 8, minSim: args.densify?.knnMinSim ?? 0 };
      if (!densifyKnnRequested) {
        reconcileDerivedEdges(args.db, args.vaultId, [], ["similar_to"], now);
      } else if (countDerivedEdges(args.db, args.vaultId, "similar_to") === 0) {
        const knnDesired = computeKnnEdges(args.db, args.vaultId, knnOpts);
        reconcileDerivedEdges(args.db, args.vaultId, knnDesired, ["similar_to"], now);
      } else if (changedChunkPaths.size > 0) {
        // THE-533: knnDiscoveryScope, not knnNeighborScope — the edge-only expansion cannot reach a
        // note that would newly rank a changed/new note in its OWN top-k without being ranked back,
        // so it needs the forward vector neighbours too. Costs one extra vecKnn per CHANGED chunk
        // (not per vault chunk), which is what keeps THE-486's speedup intact.
        const scope = knnDiscoveryScope(args.db, args.vaultId, changedChunkPaths, knnOpts);
        const knnDesired = computeKnnEdgesForPaths(args.db, args.vaultId, scope, knnOpts);
        reconcileDerivedEdgesScoped(args.db, args.vaultId, knnDesired, ["similar_to"], scope, now);
      }
      // else: densifyKnnRequested but changedChunkPaths is empty — nothing this pass could have
      // invalidated any similar_to edge, so THE-486 acceptance criterion 1 applies: skip the call
      // entirely (not even a scope lookup runs) rather than paying any kNN scan on a warm no-op pass.
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
