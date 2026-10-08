// index.embeddings (GH #1160) — is the active-embedding state the dense index relies on coherent?
//
// Two silent failures sat behind one missing constraint: a chunk with more than one `is_active = 1`
// embedding made note-plan's active-model join arbitrary, which emptied vec_chunks on rebuild and
// reported every unchanged note as a "concurrent write" skip. Migration 20261008_001 makes the first
// impossible; this check still reports it (a cache.db written by an older build, a restored backup)
// and adds the cross-check nothing else makes: vec_chunks holds the rows the active embeddings at
// the configured width say it should.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open";
import { loadVec } from "../search/vec";
import { errorMessage } from "../util/errors";
import type { Check, CheckStatus } from "./types";

export interface EmbeddingIntegrityState {
  /** Active embeddings that belong to a chunk, across every vault in the store. */
  activeEmbeddings: number;
  /** The embedding width (dimensions) the dense index is configured for. */
  configuredWidth: number;
  /** Active embeddings whose vector is exactly that width — what vec_chunks should hold. */
  activeAtConfiguredWidth: number;
  /** Chunks carrying more than one active embedding, and up to five `chunk: modelA, modelB` samples. */
  multiActiveChunks: number;
  multiActiveSamples: string[];
  /** Rows in vec_chunks; undefined when it cannot be read (sqlite-vec not loadable, table absent). */
  vecRows?: number;
  vecUnreadable?: string;
  error?: string;
}

export interface EmbeddingIntegrityView {
  /** Attached only under `--probe`: it opens cache.db, like every other store-touching check. */
  probe?: () => EmbeddingIntegrityState | undefined;
}

export function embeddingIntegrityCheck(view: EmbeddingIntegrityView): Check {
  return {
    id: "index.embeddings",
    category: "retrieval",
    run: () => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary:
            "embedding integrity (not probed): run `doctor --probe` to check active embeddings against the dense index",
          details: { embeddings: "not probed" },
        };
      }
      const s = view.probe();
      if (s === undefined) {
        return {
          status: "ok" as CheckStatus,
          summary: "embedding integrity: no cache.db or embeddings table yet",
          details: { embeddings: "nothing to check" },
        };
      }
      if (s.error !== undefined) {
        return {
          status: "warning" as CheckStatus,
          summary: "embedding integrity: the probe failed",
          issues: [`could not inspect chunk_embeddings — ${s.error}`],
        };
      }
      const details: Record<string, string | string[]> = {
        activeEmbeddings: String(s.activeEmbeddings),
        activeAtConfiguredWidth: `${s.activeAtConfiguredWidth} at width ${s.configuredWidth}`,
        vecChunksRows:
          s.vecRows !== undefined ? String(s.vecRows) : `unreadable (${s.vecUnreadable})`,
      };
      // A double-active chunk is a FAIL: it is what emptied the dense index in the field, and nothing
      // downstream warns about it.
      if (s.multiActiveChunks > 0) {
        return {
          status: "fail" as CheckStatus,
          summary: `embedding integrity: ${s.multiActiveChunks} chunk(s) carry more than one active embedding`,
          details,
          issues: [
            `${s.multiActiveChunks} chunk(s) have several is_active = 1 rows (e.g. ${s.multiActiveSamples.join(" | ")}); the active-model lookup is arbitrary for them`,
          ],
          remediation:
            "Start obsidian-tc on this build: migration 20261008_001 deactivates all but the newest generation per chunk and makes a second active row impossible. Then run index_vault so any dense-index gap refills.",
        };
      }
      if (s.vecRows !== undefined && s.vecRows !== s.activeAtConfiguredWidth) {
        const missing = s.activeAtConfiguredWidth - s.vecRows;
        return {
          status: "warning" as CheckStatus,
          summary:
            missing > 0
              ? `embedding integrity: vec_chunks is missing ${missing} of ${s.activeAtConfiguredWidth} active embedding(s) at width ${s.configuredWidth}`
              : `embedding integrity: vec_chunks holds ${-missing} more row(s) than the ${s.activeAtConfiguredWidth} active embedding(s) at width ${s.configuredWidth}`,
          details,
          issues: [
            `vec_chunks has ${s.vecRows} row(s); ${s.activeAtConfiguredWidth} active embedding(s) are at the configured width (${s.activeEmbeddings} active overall)`,
          ],
          remediation:
            s.activeEmbeddings > s.activeAtConfiguredWidth
              ? "Some active embeddings are at a different width/model than the configured one: run index_vault to re-embed them."
              : "Run index_vault; if the gap persists, change nothing in the embeddings config and check the server log for a `[vec] WARNING` rebuild line.",
        };
      }
      return {
        status: "ok" as CheckStatus,
        summary: `embedding integrity: ${s.activeEmbeddings} active embedding(s), one per chunk${s.vecRows !== undefined ? `, vec_chunks agrees (${s.vecRows} row(s))` : ""}`,
        details,
      };
    },
  };
}

/** Reads the state `embeddingIntegrityCheck` judges. Owns its own open/close, like probeIndexCoverage. */
export async function probeEmbeddingIntegrity(
  cacheDir: string,
  configuredWidth: number,
  busyTimeoutMs: number,
): Promise<EmbeddingIntegrityState | undefined> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return undefined;
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  const base = {
    activeEmbeddings: 0,
    configuredWidth,
    activeAtConfiguredWidth: 0,
    multiActiveChunks: 0,
    multiActiveSamples: [] as string[],
  };
  try {
    db = await openDatabase(path, busyTimeoutMs);
    const opened = db;
    const has = (name: string): boolean =>
      opened.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = ?").get(name) !== undefined;
    if (!has("chunk_embeddings") || !has("chunks")) return undefined;
    const count = (sql: string, ...params: unknown[]): number =>
      (opened.prepare(sql).get(...params) as { n: number }).n;
    const active =
      "FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1";
    const multi = opened
      .prepare(
        `SELECT e.chunk_id AS chunk_id, GROUP_CONCAT(e.model, ', ') AS models ${active}
          GROUP BY e.chunk_id HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ chunk_id: string; models: string }>;
    const state: EmbeddingIntegrityState = {
      ...base,
      activeEmbeddings: count(`SELECT COUNT(*) AS n ${active}`),
      activeAtConfiguredWidth: count(
        `SELECT COUNT(*) AS n ${active} AND length(e.embedding) = ?`,
        configuredWidth * 4,
      ),
      multiActiveChunks: multi.length,
      multiActiveSamples: multi.slice(0, 5).map((m) => `${m.chunk_id.slice(0, 12)}: ${m.models}`),
    };
    if (!loadVec(opened)) return { ...state, vecUnreadable: "sqlite-vec is not loadable here" };
    try {
      return { ...state, vecRows: count("SELECT COUNT(*) AS n FROM vec_chunks") };
    } catch (e) {
      return { ...state, vecUnreadable: errorMessage(e) };
    }
  } catch (e) {
    return { ...base, error: errorMessage(e) };
  } finally {
    try {
      db?.close?.();
    } catch {
      /* closing a handle we may never have opened must not fail the run */
    }
  }
}
