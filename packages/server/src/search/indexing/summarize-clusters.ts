// THE-628 (second PR): the cluster-level (tier-2) summary pass — RAPTOR-style: cluster tier-1's
// note_summaries embeddings with kmeans() (search/cluster.ts, REUSED as-is — this file does NOT
// reuse assignClusters, which is chunk-specific and writes chunks.cluster_id, a different table
// for a different purpose) and, per cluster, ask the gateway to summarize the MEMBER NOTE
// SUMMARIES (not raw note content — summarizing summaries is exactly what makes this tier-2
// rather than a second copy of tier-1).
//
// Runs on the OFFLINE cluster cadence (the `obsidian-tc cluster` CLI command — see cli/commands/
// cluster.ts), NOT per-write and NOT inside indexVault: cluster membership is only meaningful
// after a fresh assignClusters-style pass, and re-deriving it per note write would be both wrong
// (clustering needs the whole corpus) and wasteful (a single edited note does not usually change
// which cluster anything falls in). Mirrors summarize-notes.ts's two-phase shape and its resume
// discipline — see that file's header for the full rationale, only briefly repeated here:
//
// TWO PHASES. Phase 1 generates cluster summaries (gateway.extract, per cluster, bounded
// concurrency). Phase 2 batch-embeds them (embedProvider.embed(texts, ...) over a VARIABLE array
// of accumulated summary texts) — the tier-1 lesson applies identically here: a single-element
// LITERAL `.embed([...])` call trips test/query-encoder.test.ts's source-scan gate, which reserves
// that exact call shape for query-encoder.ts's single-query dense encode. Batching also means one
// round trip for N cluster summaries instead of N.
//
// RESUME: a cluster's identity is its `cluster_key` — hash(sorted(member content_hashes)) — so a
// re-cluster that reproduces the exact same member set (same notes, same content) reproduces the
// exact same key, and existingClusterKeys() skips it without a gateway call. A re-cluster that
// changes membership OR a member's content produces a NEW key, so it is (re)computed — see the
// migration header for why superseded keys are not garbage-collected in this first PR.
import { tableExists } from "../../db/introspect";
import type { Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import type { GatewayClient } from "../../gateway";
import { runWithConcurrency } from "../../util/concurrency";
import { defaultK, kmeans } from "../cluster";
import {
  clusterKeyOf,
  existingClusterKeys,
  hasClusterSummaries,
  upsertClusterSummary,
} from "../cluster-summaries";
import { blobToFloats } from "../vec";

const DEFAULT_MAX_CONCURRENCY = 12; // same research-brief range as tier-1 (8-16 in-flight extract() calls)
const DEFAULT_MAX_CONTENT_CHARS = 8000;
// Phase 2's batch size — mirrors summarize-notes.ts's SUMMARY_EMBED_BATCH. Cluster summaries are
// short texts (like note summaries), and there are FEWER clusters than notes (defaultK ~ sqrt(n)),
// so this batch size is, if anything, more generously inside budget than the note tier's.
const CLUSTER_EMBED_BATCH = 64;

const CLUSTER_SYSTEM_PROMPT =
  "The following are summaries of several related notes, grouped because they are semantically " +
  "similar. Write a single 2-4 sentence summary that captures the shared theme(s) across all of " +
  "them. Return only the summary text — no preamble, no markdown formatting, no list of the " +
  "individual notes.";

interface NoteSummaryRow {
  path: string;
  contentHash: string;
  summary: string;
  embedding: Uint8Array;
}

export interface BuildClusterSummariesOptions {
  /** Bounded in-flight extract() calls across clusters. Default 12. */
  maxConcurrency?: number;
  /** Cap on the joined member-summaries text sent to the summarizer per cluster. */
  maxContentChars?: number;
  /** Cluster count override — default is defaultK(memberCount), matching assignClusters. */
  k?: number;
  maxIters?: number;
  seed?: number;
  now?: () => number;
}

export interface BuildClusterSummariesStats {
  /** Embedded note_summaries rows for this vault that fed clustering. */
  consideredNotes: number;
  /** Clusters kmeans produced this pass (before the resume/skip check). */
  clusters: number;
  /** Newly (re)summarized this pass — a gateway call was made and a row was written. */
  summarized: number;
  /** cluster_key already present (unchanged member set) — no gateway call. */
  skipped: number;
  /** A gateway call was attempted and failed, or returned an unusable (empty) summary. */
  failed: number;
}

/** A phase-1 output: a cluster that was successfully summarized and is waiting for phase 2's
 *  batch embed. */
interface PendingClusterSummary {
  clusterKey: string;
  memberPaths: string[];
  summaryText: string;
  model: string;
}

/**
 * Cluster `vaultId`'s embedded note_summaries and (re)generate a summary for every cluster whose
 * cluster_key is not already present. Best-effort throughout, never throws — same contract as
 * summarizeNotes: a gateway failure on one cluster (phase 1) is counted `failed`; an embed-provider
 * failure on one BATCH (phase 2) leaves that batch's summaries written but unembedded (still
 * counted `summarized`) rather than lost.
 */
export async function buildClusterSummaries(
  db: Database,
  vaultId: string,
  gateway: GatewayClient,
  embedProvider: EmbeddingProvider,
  opts: BuildClusterSummariesOptions = {},
): Promise<BuildClusterSummariesStats> {
  const now = opts.now ?? Date.now;
  const maxChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const empty: BuildClusterSummariesStats = {
    consideredNotes: 0,
    clusters: 0,
    summarized: 0,
    skipped: 0,
    failed: 0,
  };
  if (!tableExists(db, "note_summaries") || !hasClusterSummaries(db)) return empty;

  const noteRows = db
    .prepare(
      "SELECT path, content_hash AS contentHash, summary, embedding FROM note_summaries WHERE vault_id = ? AND embedding IS NOT NULL ORDER BY path",
    )
    .all(vaultId) as NoteSummaryRow[];
  if (noteRows.length === 0) return empty;

  const vectors = noteRows.map((r) => Array.from(blobToFloats(r.embedding)));
  const k = opts.k ?? defaultK(noteRows.length);
  const res = kmeans(vectors, k, {
    ...(opts.maxIters !== undefined ? { maxIters: opts.maxIters } : {}),
    seed: opts.seed ?? 1,
  });

  // Group member rows by their assigned cluster index.
  const groups = new Map<number, NoteSummaryRow[]>();
  res.assignments.forEach((clusterIdx, i) => {
    const row = noteRows[i];
    if (!row) return;
    const arr = groups.get(clusterIdx);
    if (arr) arr.push(row);
    else groups.set(clusterIdx, [row]);
  });

  const existingKeys = existingClusterKeys(db, vaultId);
  interface ClusterCandidate {
    clusterKey: string;
    memberPaths: string[];
    memberSummaries: string[];
  }
  const toBuild: ClusterCandidate[] = [];
  let skipped = 0;
  for (const members of groups.values()) {
    const clusterKey = clusterKeyOf(members.map((m) => m.contentHash));
    if (existingKeys.has(clusterKey)) {
      skipped += 1;
      continue;
    }
    toBuild.push({
      clusterKey,
      memberPaths: members.map((m) => m.path),
      memberSummaries: members.map((m) => m.summary),
    });
  }

  // Phase 1: generate cluster summaries, bounded concurrency across clusters.
  let failed = 0;
  const pending: PendingClusterSummary[] = [];
  await runWithConcurrency(
    toBuild,
    Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    async (cluster) => {
      const joined = cluster.memberSummaries
        .map((s, i) => `- (${cluster.memberPaths[i] ?? "?"}) ${s}`)
        .join("\n")
        .slice(0, maxChars);
      try {
        const completion = await gateway.extract({
          messages: [
            { role: "system", content: CLUSTER_SYSTEM_PROMPT },
            { role: "user", content: joined },
          ],
          temperature: 0,
          maxTokens: 320,
        });
        const summaryText = completion.text.trim();
        if (summaryText.length === 0) {
          failed += 1;
          return;
        }
        pending.push({
          clusterKey: cluster.clusterKey,
          memberPaths: cluster.memberPaths,
          summaryText,
          model: completion.model,
        });
      } catch {
        failed += 1;
      }
    },
  );

  // Phase 2: batch-embed every generated cluster summary, then persist. `texts` is a variable
  // array (`batch.map(...)`), never a literal — see this file's header for why that is load-bearing.
  let summarized = 0;
  for (let i = 0; i < pending.length; i += CLUSTER_EMBED_BATCH) {
    const batch = pending.slice(i, i + CLUSTER_EMBED_BATCH);
    const texts = batch.map((p) => p.summaryText);
    let vecs: number[][] | null = null;
    try {
      vecs = await embedProvider.embed(texts, { input: "document" });
    } catch {
      vecs = null; // whole-batch failure -> this batch's cluster summaries land without embeddings
    }
    batch.forEach((p, j) => {
      const embedding = vecs?.[j];
      upsertClusterSummary(db, vaultId, {
        clusterKey: p.clusterKey,
        summary: p.summaryText,
        model: p.model,
        memberPaths: p.memberPaths,
        ...(embedding ? { embedding, embeddingModel: embedProvider.id } : {}),
        createdAt: now(),
      });
      summarized += 1;
    });
  }

  return {
    consideredNotes: noteRows.length,
    clusters: groups.size,
    summarized,
    skipped,
    failed,
  };
}

export interface ClusterSummaryPassConfig {
  enabled: boolean;
  maxConcurrency?: number;
  maxContentChars?: number;
  k?: number;
  seed?: number;
  now?: () => number;
}

/**
 * The gate for the WHOLE cluster-summary pass — same "off means provably untouched" contract as
 * maybeSummarizeVault: `cfg.enabled === false` returns before `makeGateway` is invoked, so no
 * GatewayClient is ever constructed and buildClusterSummaries never runs. Callers (the
 * `obsidian-tc cluster` CLI command) pass a lazy gateway factory for the same reason tier-1 does.
 */
export async function maybeBuildClusterSummaries(
  db: Database,
  vaultId: string,
  cfg: ClusterSummaryPassConfig,
  makeGateway: () => GatewayClient,
  embedProvider: EmbeddingProvider,
): Promise<BuildClusterSummariesStats | null> {
  if (!cfg.enabled) return null;
  const gateway = makeGateway();
  return buildClusterSummaries(db, vaultId, gateway, embedProvider, {
    ...(cfg.maxConcurrency !== undefined ? { maxConcurrency: cfg.maxConcurrency } : {}),
    ...(cfg.maxContentChars !== undefined ? { maxContentChars: cfg.maxContentChars } : {}),
    ...(cfg.k !== undefined ? { k: cfg.k } : {}),
    ...(cfg.seed !== undefined ? { seed: cfg.seed } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
  });
}
