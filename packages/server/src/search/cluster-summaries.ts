// THE-628 (second PR): the cluster-level (tier-2) summary tier's data-access layer over
// `cluster_summaries` + `cluster_summary_members` (migration 20260819_002) — the row-level CRUD
// the offline cluster-summary builder (search/indexing/summarize-clusters.ts) needs, plus a
// brute-force semantic search over cluster embeddings for the DARK retrieval candidate stream
// (graph_search_stages/candidate_assembly.ts). Mirrors note-summaries.ts's shape exactly (same
// brute-force-is-deliberate rationale — cluster count is sqrt(note count), smaller still).
//
// THE HARD PART, and the reason this file exists rather than reusing note-summaries.ts's search
// wholesale: a cluster summary is derived from MULTIPLE notes with potentially DIFFERENT ACL.
// note-summaries.ts's per-path isReadable check is INSUFFICIENT here — see searchClusterSummaries
// below for the full design.
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { contentHash } from "../vault/paths";
import { cosineBatch } from "./native";
import { blobToFloats, floatBlob } from "./vec";

/** Stable, content-independent candidate id for a cluster's summary — the Candidate-stream
 *  analogue of noteSummaryId(). Prefixed distinctly from both a chunk id ("chk_") and a note-
 *  summary id ("sum_") so a cluster-summary candidate can never collide with (or be mistaken for)
 *  either downstream. */
export function clusterSummaryId(vaultId: string, clusterKey: string): string {
  return `clu_${contentHash(`${vaultId} ${clusterKey}`).slice(0, 24)}`;
}

/** The cluster's identity key: a hash of the SORTED content_hashes of its member note_summaries
 *  rows. Order-independent (sorted first) so the same member set always hashes the same regardless
 *  of kmeans' internal iteration order — see the migration header for why this is what makes a
 *  cluster summary invalidate on either membership or content change with no separate flag. */
export function clusterKeyOf(memberContentHashes: readonly string[]): string {
  return contentHash([...memberContentHashes].sort().join(","));
}

export interface ClusterSummaryRecord {
  clusterKey: string;
  summary: string;
  model: string;
  /** The member notes' paths, in ANY order — persisted verbatim to cluster_summary_members and
   *  read back by the ACL filter. REQUIRED: an empty array would write a summary with no way to
   *  ever verify a caller may see it, so callers must not upsert a cluster with zero members. */
  memberPaths: readonly string[];
  embedding?: number[];
  embeddingModel?: string;
  createdAt: number;
}

/** Does this cache.db carry the cluster_summaries tables (migration 20260819_002)? Same
 *  degrade-to-"no summaries" discipline as hasNoteSummaries. */
export function hasClusterSummaries(db: Database): boolean {
  return tableExists(db, "cluster_summaries") && tableExists(db, "cluster_summary_members");
}

/** Every cluster_key already stored for this vault — the builder's resume/skip check: a
 *  freshly-computed cluster whose key is already in this set had the exact same member content
 *  hashes last pass and is not regenerated (mirrors existingSummaryHash's role in the note tier,
 *  but as a set lookup since cluster_key IS the invalidation signal, not a separate hash column). */
export function existingClusterKeys(db: Database, vaultId: string): Set<string> {
  const rows = db
    .prepare("SELECT cluster_key FROM cluster_summaries WHERE vault_id = ?")
    .all(vaultId) as Array<{ cluster_key: string }>;
  return new Set(rows.map((r) => r.cluster_key));
}

/** Upsert a cluster's summary row AND its member-path set, atomically — a cluster summary with no
 *  matching member rows (partial write) would be unfilterable by the ACL check below, so the two
 *  tables must move together or not at all. Replaces (not accumulates) member rows on conflict,
 *  same current-state discipline as note_summaries: a re-upsert of the SAME cluster_key (which the
 *  builder's resume check makes rare — it skips existing keys — but a caller CAN still choose to
 *  force a rewrite) replaces the member set rather than appending to it. */
export function upsertClusterSummary(
  db: Database,
  vaultId: string,
  rec: ClusterSummaryRecord,
): void {
  if (rec.memberPaths.length === 0) {
    throw new Error("upsertClusterSummary: memberPaths must be non-empty (ACL filter requires it)");
  }
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO cluster_summaries (vault_id, cluster_key, summary, model, embedding, embedding_model, member_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault_id, cluster_key) DO UPDATE SET
         summary = excluded.summary,
         model = excluded.model,
         embedding = excluded.embedding,
         embedding_model = excluded.embedding_model,
         member_count = excluded.member_count,
         created_at = excluded.created_at`,
    ).run(
      vaultId,
      rec.clusterKey,
      rec.summary,
      rec.model,
      rec.embedding ? floatBlob(rec.embedding) : null,
      rec.embeddingModel ?? null,
      rec.memberPaths.length,
      rec.createdAt,
    );
    db.prepare("DELETE FROM cluster_summary_members WHERE vault_id = ? AND cluster_key = ?").run(
      vaultId,
      rec.clusterKey,
    );
    const insMember = db.prepare(
      "INSERT INTO cluster_summary_members (vault_id, cluster_key, path) VALUES (?, ?, ?)",
    );
    for (const path of rec.memberPaths) insMember.run(vaultId, rec.clusterKey, path);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * THE-854: garbage-collect superseded `cluster_summaries` rows for `vaultId` — the follow-up the
 * 20260819_002 migration header names explicitly ("Superseded cluster_key rows are NOT
 * garbage-collected by this PR"). `cluster_key` is a hash of the SORTED member content_hashes
 * (clusterKeyOf), so a re-cluster that changes a cluster's membership OR a member's content mints a
 * NEW key and orphans the OLD row — nothing ever deletes it otherwise, and the table is also a
 * candidate pool for retrieval.
 *
 * `currentClusterKeys` is the builder's COMPLETE key set for this pass — every cluster_key produced
 * by this run's clustering, whether newly summarized or skipped as unchanged (see
 * summarize-clusters.ts's buildClusterSummaries). Any stored row whose cluster_key is NOT in that
 * set no longer corresponds to any cluster this pass produced, so it is deleted.
 *
 * Vault-scoped: the SELECT and both DELETEs are all keyed on `vaultId`, so this can never touch
 * another vault's rows (THE-563/564 partitioning).
 *
 * Deletes `cluster_summary_members` BEFORE `cluster_summaries` for each doomed key, and both moves
 * happen inside ONE transaction — same BEGIN/COMMIT/ROLLBACK shape as upsertClusterSummary above,
 * so a crash mid-GC can never leave a summary row deleted with its member rows still present (or
 * the reverse leaving a summary row with no members, which the mixed-ACL filter above cannot then
 * verify). Neither table declares a FOREIGN KEY (see the migration), so this ordering is not backed
 * by a cascade — it is the whole safety mechanism, mirroring acl_path_set.ts's evictAclPathSets.
 *
 * Best-effort like the rest of this file: a cache.db that predates the cluster_summaries migration
 * has nothing to GC and returns 0 rather than erroring.
 */
export function gcSupersededClusterSummaries(
  db: Database,
  vaultId: string,
  currentClusterKeys: ReadonlySet<string>,
): number {
  if (!hasClusterSummaries(db)) return 0;
  const rows = db
    .prepare("SELECT cluster_key FROM cluster_summaries WHERE vault_id = ?")
    .all(vaultId) as Array<{ cluster_key: string }>;
  const doomed = rows.map((r) => r.cluster_key).filter((k) => !currentClusterKeys.has(k));
  if (doomed.length === 0) return 0;
  db.exec("BEGIN");
  try {
    const delMembers = db.prepare(
      "DELETE FROM cluster_summary_members WHERE vault_id = ? AND cluster_key = ?",
    );
    const delSummary = db.prepare(
      "DELETE FROM cluster_summaries WHERE vault_id = ? AND cluster_key = ?",
    );
    for (const key of doomed) {
      delMembers.run(vaultId, key);
      delSummary.run(vaultId, key);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return doomed.length;
}

export interface ClusterSummaryHit {
  /** Synthetic candidate id — see clusterSummaryId(). Never a real chunk_id, never a note-summary
   *  id. */
  chunk_id: string;
  /** Not a real vault path — a cluster spans many. Kept as the cluster_key so downstream code that
   *  expects a "path" field on a Candidate has a stable, cluster-identifying string; consumers must
   *  not treat it as a file path (it is not one and does not resolve to a note). */
  path: string;
  content: string;
  score: number;
}

interface ClusterRow {
  cluster_key: string;
  summary: string;
  embedding: Uint8Array;
}

/**
 * Brute-force cosine search over embedded cluster summaries — THE MANDATORY SECURITY FILTER (THE
 * HARD PART from the cluster plan): a cluster summary is derived from MULTIPLE notes with
 * potentially DIFFERENT ACL. Surfacing it to a caller who cannot read every member note leaks the
 * content of whichever member(s) they cannot read, even though the cluster_summaries row itself
 * names no single path — note-summaries.ts's per-path isReadable check is structurally
 * insufficient for a multi-note row.
 *
 * SAFE (conservative, leak-free) design: a cluster is a candidate ONLY IF the caller can read
 * EVERY one of its member notes (all member paths pass isReadable). A cluster whose member set
 * cannot be resolved at all (cluster_summary_members has zero rows for its cluster_key — the
 * write path never produces this, but the read path must not assume it never can) is excluded
 * FAIL-CLOSED, same as a mixed-readability cluster — never fail-open on missing membership data.
 * This is restrictive (a heavily-restricted caller sees few or no cluster summaries) but provably
 * leak-free; a more granular design (cluster only within ACL-homogeneous groups) is a deliberate
 * follow-up, not built here.
 */
export function searchClusterSummaries(
  db: Database,
  vaultId: string,
  queryVec: number[],
  opts: { k: number; isReadable?: (path: string) => boolean; minScore?: number },
): ClusterSummaryHit[] {
  if (opts.k <= 0 || !hasClusterSummaries(db)) return [];
  const readable = opts.isReadable ?? (() => true);

  const memberRows = db
    .prepare("SELECT cluster_key, path FROM cluster_summary_members WHERE vault_id = ?")
    .all(vaultId) as Array<{ cluster_key: string; path: string }>;
  const membersByCluster = new Map<string, string[]>();
  for (const r of memberRows) {
    const arr = membersByCluster.get(r.cluster_key);
    if (arr) arr.push(r.path);
    else membersByCluster.set(r.cluster_key, [r.path]);
  }

  const rows = (
    db
      .prepare(
        "SELECT cluster_key, summary, embedding FROM cluster_summaries WHERE vault_id = ? AND embedding IS NOT NULL",
      )
      .all(vaultId) as ClusterRow[]
  ).filter((r) => {
    const members = membersByCluster.get(r.cluster_key);
    // Fail-closed: no resolvable member set (empty or missing) -> never a candidate. A caller must
    // be verified able to read EVERY member, and there is nothing to verify against here.
    return members !== undefined && members.length > 0 && members.every((p) => readable(p));
  });
  if (rows.length === 0) return [];

  const dim = queryVec.length;
  const same = rows.filter((r) => r.embedding.byteLength === dim * 4);
  if (same.length === 0) return [];
  const flat = new Float32Array(same.length * dim);
  same.forEach((r, i) => {
    flat.set(blobToFloats(r.embedding), i * dim);
  });
  const queryF32 = Float32Array.from(queryVec);
  const scores = cosineBatch(queryF32, flat, dim);
  const hits: ClusterSummaryHit[] = [];
  same.forEach((r, i) => {
    const score = scores[i] ?? 0;
    if (opts.minScore !== undefined && score < opts.minScore) return;
    hits.push({
      chunk_id: clusterSummaryId(vaultId, r.cluster_key),
      path: r.cluster_key,
      content: r.summary,
      score,
    });
  });
  // Total order: score descending, then cluster_key — same tie-break discipline as
  // note-summaries.ts/semantic.ts (THE-582), so two identically-scored clusters resolve
  // deterministically rather than by table-scan order.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return hits.slice(0, opts.k);
}
