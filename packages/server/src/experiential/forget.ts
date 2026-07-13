// THE-239 — dependency-aware deletion (the Synchronized Backflow fast-follow). The immediate
// tombstone / blocked-set half shipped with THE-228 (agent_episodes.blocked, enforced by every
// reader); this module is the propagation half: forgetting a target also clears or reports the
// DERIVED artifacts that carry it, and every forget appends to a hash-chained audit log.
//
// Policy (from the ticket's GDPR / EU-AI-Act tension):
//   * default mode "tombstone": block + audit — retrieval history is KEPT as audit trail;
//   * mode "erase": PII posture — content fields are scrubbed and retrieval rows deleted.
// Derived artifacts that regenerate on their own cadence (weekly syntheses, contradiction
// rows) or that are authored notes themselves (reflections) are REPORTED, never mutated:
// their lifecycle is owned elsewhere, and a forget must not silently rewrite authored text.
// The SBU parameter pathway was dropped by the 2026-06-26 reclassification (hosted stateless
// models never train on episodes).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/types";

export interface ForgetLogEntry {
  ts: number;
  kind: "episode" | "note";
  target: string;
  mode: "tombstone" | "erase";
  details: Record<string, unknown>;
}

const GENESIS = "0".repeat(64);

function rowHash(
  prevHash: string,
  ts: number,
  kind: string,
  target: string,
  mode: string,
  detailsJson: string,
): string {
  return createHash("sha256")
    .update(`${prevHash}|${ts}|${kind}|${target}|${mode}|${detailsJson}`)
    .digest("hex");
}

/** Append one forget event to the hash chain. Returns the new head hash. */
export function appendForgetLog(edb: Database, e: ForgetLogEntry): string {
  const last = edb.prepare("SELECT hash FROM forget_log ORDER BY seq DESC LIMIT 1").get() as
    | { hash: string }
    | undefined;
  const prev = last?.hash ?? GENESIS;
  const detailsJson = JSON.stringify(e.details);
  const hash = rowHash(prev, e.ts, e.kind, e.target, e.mode, detailsJson);
  edb
    .prepare(
      "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(e.ts, e.kind, e.target, e.mode, detailsJson, prev, hash);
  return hash;
}

/** Walk the chain and recompute every hash. A single edited, removed, or reordered row breaks it. */
export function verifyForgetLog(edb: Database): { ok: boolean; entries: number; breakAt?: number } {
  const rows = edb
    .prepare(
      "SELECT seq, ts, kind, target, mode, details, prev_hash, hash FROM forget_log ORDER BY seq ASC",
    )
    .all() as Array<{
    seq: number;
    ts: number;
    kind: "episode" | "note";
    target: string;
    mode: "tombstone" | "erase";
    details: string | null;
    prev_hash: string;
    hash: string;
  }>;
  let prev = GENESIS;
  for (const r of rows) {
    const expect = rowHash(prev, r.ts, r.kind, r.target, r.mode, r.details ?? "");
    if (r.prev_hash !== prev || r.hash !== expect) {
      return { ok: false, entries: rows.length, breakAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

export interface EpisodeForgetResult {
  found: boolean;
  already_blocked: boolean;
  scrubbed_fields: number;
  preference_evidence_mentions: number;
  head: string | null;
}

/** Forget one work-memory episode. Tombstone always (blocked=1 + valid_until); erase mode
 *  additionally scrubs the content-bearing fields — the row skeleton stays so the caller
 *  attribution chain and the audit log remain intact. */
export function forgetEpisode(
  edb: Database,
  id: string,
  opts: { nowMs: number; erase?: boolean },
): EpisodeForgetResult {
  const row = edb.prepare("SELECT id, blocked FROM agent_episodes WHERE id = ?").get(id) as
    | { id: string; blocked: number }
    | undefined;
  if (!row) {
    return {
      found: false,
      already_blocked: false,
      scrubbed_fields: 0,
      preference_evidence_mentions: 0,
      head: null,
    };
  }
  const alreadyBlocked = row.blocked === 1;
  // THE-239: the tombstone/scrub mutation and the hash-chain append must be atomic — a crash
  // between them would leave the episode blocked/scrubbed with NO audit row, breaking the
  // "every forget is audited" guarantee. Wrap both in one transaction (mirrors activation.ts).
  let scrubbed = 0;
  let mentions = 0;
  let head: string;
  edb.exec("BEGIN");
  try {
    edb
      .prepare(
        "UPDATE agent_episodes SET blocked = 1, valid_until = COALESCE(valid_until, ?) WHERE id = ?",
      )
      .run(opts.nowMs, id);
    if (opts.erase) {
      scrubbed = edb
        .prepare(
          "UPDATE agent_episodes SET args_json = NULL, summary = NULL, tags = NULL, error_code = NULL WHERE id = ?",
        )
        .run(id).changes as number;
    }
    // Preference-delta evidence is free text (no FK by design) — report mentions, never rewrite
    // the append-only delta audit.
    mentions = (
      edb
        .prepare("SELECT COUNT(*) AS n FROM preference_deltas WHERE evidence LIKE ?")
        .get(`%${id}%`) as { n: number }
    ).n;
    head = appendForgetLog(edb, {
      ts: opts.nowMs,
      kind: "episode",
      target: id,
      mode: opts.erase ? "erase" : "tombstone",
      details: {
        already_blocked: alreadyBlocked,
        scrubbed: scrubbed > 0,
        preference_evidence_mentions: mentions,
      },
    });
    edb.exec("COMMIT");
  } catch (e) {
    edb.exec("ROLLBACK");
    throw e;
  }
  return {
    found: true,
    already_blocked: alreadyBlocked,
    scrubbed_fields: scrubbed,
    preference_evidence_mentions: mentions,
    head,
  };
}

export interface NoteForgetResult {
  chunk_ids: string[];
  retrieval_rows: number;
  retrieval_rows_deleted: number;
  activation_rows_deleted: number;
  prewarm_invalidated: boolean;
  outdated_reflections: string[];
  syntheses_mentions: number;
  contradictions_mentions: number;
  head: string;
}

/** Propagate a note deletion through the derived stores. The note file itself must already be
 *  gone from the vault (delete_note / user action) — this clears what DERIVES from it. Erase
 *  mode hard-deletes the note's retrieval history (PII posture); the default keeps it (audit). */
export function forgetNote(
  edb: Database,
  cacheDb: Database,
  opts: {
    vaultId: string;
    relPath: string;
    nowMs: number;
    erase?: boolean;
    /** cache dir holding prewarm-<vault>.json; absent -> prewarm step skipped */
    prewarmDir?: string;
    /** absolute vault root; absent -> reflections scan skipped */
    vaultRoot?: string;
    memoryFolder?: string;
  },
): NoteForgetResult {
  const chunkIds = (
    cacheDb
      .prepare("SELECT id FROM chunks WHERE vault_id = ? AND path = ?")
      .all(opts.vaultId, opts.relPath) as Array<{ id: string }>
  ).map((r) => r.id);

  // Retrieval history is COUNTED up front (read-only); the erase/delete + activation cleanup run
  // inside the audit transaction below, so the derived-state mutation and the hash-chain append
  // commit together (a crash between would delete state with no audit row).
  let retrievalRows = 0;
  if (chunkIds.length > 0) {
    const ph = chunkIds.map(() => "?").join(",");
    retrievalRows = (
      edb
        .prepare(`SELECT COUNT(*) AS n FROM chunk_retrievals WHERE chunk_id IN (${ph})`)
        .get(...chunkIds) as { n: number }
    ).n;
  }

  // Prewarm cache: if the cached bundle mentions the path or any chunk id, drop the file —
  // the next bootstrap composes live.
  let prewarmInvalidated = false;
  if (opts.prewarmDir) {
    const file = join(opts.prewarmDir, `prewarm-${opts.vaultId}.json`);
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, "utf8");
        if (raw.includes(opts.relPath) || chunkIds.some((id) => raw.includes(id))) {
          rmSync(file, { force: true });
          prewarmInvalidated = true;
        }
      } catch {
        /* unreadable cache -> leave it; TTL bounds the exposure */
      }
    }
  }

  // Report-only surfaces (lifecycle owned elsewhere; forget never rewrites authored text):
  const synthMentions = tableExists(cacheDb, "syntheses")
    ? (
        cacheDb
          .prepare("SELECT COUNT(*) AS n FROM syntheses WHERE patterns LIKE ? OR clusters LIKE ?")
          .get(`%${opts.relPath}%`, `%${opts.relPath}%`) as { n: number }
      ).n
    : 0;
  const contraMentions = tableExists(cacheDb, "contradictions")
    ? (
        cacheDb
          .prepare(
            "SELECT COUNT(*) AS n FROM contradictions WHERE source_path = ? OR conflict_path = ?",
          )
          .get(opts.relPath, opts.relPath) as { n: number }
      ).n
    : 0;
  const outdatedReflections: string[] = [];
  if (opts.vaultRoot) {
    const dir = join(opts.vaultRoot, opts.memoryFolder ?? "memory", "reflections");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        try {
          const text = readFileSync(join(dir, f), "utf8");
          if (text.includes(opts.relPath) || chunkIds.some((id) => text.includes(id))) {
            outdatedReflections.push(f);
          }
        } catch {
          /* unreadable reflection -> skip */
        }
      }
    }
  }

  // THE-239: the derived-state DELETEs + the hash-chain append are one transaction — a crash
  // between them would erase retrieval/activation state with no audit row. The filesystem effects
  // above (prewarm/reflections) stay OUTSIDE: a file delete can't roll back and is TTL-bounded.
  let retrievalDeleted = 0;
  let activationDeleted = 0;
  let head: string;
  edb.exec("BEGIN");
  try {
    if (chunkIds.length > 0) {
      const ph = chunkIds.map(() => "?").join(",");
      // Retrieval history: erase deletes, audit keeps.
      if (opts.erase) {
        retrievalDeleted = edb
          .prepare(`DELETE FROM chunk_retrievals WHERE chunk_id IN (${ph})`)
          .run(...chunkIds).changes as number;
      }
      // Derived activation state has no audit value once the source is gone.
      activationDeleted = edb
        .prepare(`DELETE FROM vault_object_state WHERE object_id IN (${ph})`)
        .run(...chunkIds).changes as number;
    }
    head = appendForgetLog(edb, {
      ts: opts.nowMs,
      kind: "note",
      target: opts.relPath,
      mode: opts.erase ? "erase" : "tombstone",
      details: {
        chunks: chunkIds.length,
        retrieval_rows: retrievalRows,
        retrieval_rows_deleted: retrievalDeleted,
        activation_rows_deleted: activationDeleted,
        prewarm_invalidated: prewarmInvalidated,
        outdated_reflections: outdatedReflections,
        syntheses_mentions: synthMentions,
        contradictions_mentions: contraMentions,
      },
    });
    edb.exec("COMMIT");
  } catch (e) {
    edb.exec("ROLLBACK");
    throw e;
  }
  return {
    chunk_ids: chunkIds,
    retrieval_rows: retrievalRows,
    retrieval_rows_deleted: retrievalDeleted,
    activation_rows_deleted: activationDeleted,
    prewarm_invalidated: prewarmInvalidated,
    outdated_reflections: outdatedReflections,
    syntheses_mentions: synthMentions,
    contradictions_mentions: contraMentions,
    head,
  };
}

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}
