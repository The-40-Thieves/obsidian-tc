// WP3 slice 1 (docs/plans/2026-07-30-codebase-refactor-map.md): the READ-ONLY planning phase,
// moved verbatim out of indexer.ts. Every function here reads the database and computes a plan;
// none writes to it, opens a transaction, or calls an embedding provider. embed-batches.ts (the
// provider-call phase) and indexer.ts (persistence + orchestration) both depend on this file;
// this file must depend on neither of them.
import type { Database } from "../../db/types";
import { parseNote } from "../../vault/frontmatter";
import { contentHash } from "../../vault/paths";
import { chunkNote, enrichChunkText } from "../chunk";
import { scanSecrets } from "../secrets";
import type { ExistingRow, PlannedChunk, PlanResult } from "./types";

// Stable, content-independent id for a chunk slot. Re-chunking the same note
// reproduces these ids, so content_hash alone decides re-embed vs. skip.
export function chunkId(vaultId: string, path: string, index: string): string {
  const key = [vaultId, path, index].join(" ");
  return "chk_".concat(contentHash(key).slice(0, 24));
}

// THE-487: token estimate for the embed batch budget. chars/4 is the right rule-of-thumb for prose,
// but link-dense Markdown ([[...]], tables, URLs) fragments into ~2-2.5x more tokens, so a chars/4
// budget overflowed the provider's n_ctx and forced a bisect+retry. We tighten the divisor toward 3
// as the special-character density rises: prose stays at chars/4 (no batch-size regression), dense
// text is estimated conservatively (fewer overflows). Zero-dependency and still intentionally coarse —
// it only needs to keep a request under n_ctx, not be exact; a real tokenizer is the follow-up if
// measurement shows residual retries.
export function estimateEmbedTokens(text: string): number {
  const len = text.length;
  if (len === 0) return 0;
  const special = (text.match(/[^\w\s]/g) ?? []).length;
  // >12% non-word/non-space (brackets, pipes, slashes, punctuation) marks link/table-dense Markdown.
  const divisor = special / len > 0.12 ? 3 : 4;
  return Math.ceil(len / divisor);
}

// THE-501: preload the whole vault's lightweight chunk state (ids + hashes + active model) in ONE
// query, grouped by path, so a full reconcile plans every note without a per-note chunk query. Never
// loads content or vectors — memory stays bounded to identifiers and hashes.
export function preloadChunkState(db: Database, vaultId: string): Map<string, ExistingRow[]> {
  const rows = db
    .prepare(
      "SELECT c.path AS path, c.rowid AS rowid, c.id AS id, c.content_hash AS content_hash, e.model AS active_model FROM chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? ORDER BY c.path",
    )
    .all(vaultId) as Array<ExistingRow & { path: string }>;
  const byPath = new Map<string, ExistingRow[]>();
  for (const r of rows) {
    const list = byPath.get(r.path);
    const row: ExistingRow = {
      rowid: r.rowid,
      id: r.id,
      content_hash: r.content_hash,
      active_model: r.active_model,
    };
    if (list) list.push(row);
    else byPath.set(r.path, [row]);
  }
  return byPath;
}

// The chunk-row query a single path's plan is computed against — factored out so THE-925's
// concurrent-writer guard (index-vault.ts, applied immediately before a batched plan is written)
// can re-read the SAME rows a plan's `existing` snapshot came from, at apply time, and compare.
export function readExistingChunkRows(db: Database, vaultId: string, path: string): ExistingRow[] {
  return db
    .prepare(
      "SELECT c.rowid AS rowid, c.id AS id, c.content_hash AS content_hash, e.model AS active_model FROM chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? AND c.path = ?",
    )
    .all(vaultId, path) as ExistingRow[];
}

// THE-925: true when `current` (a fresh read of a path's chunk rows) still matches `planned` (the
// `existing` snapshot a plan was computed against) — same set of chunk ids, each with the same
// content_hash and active_model. A batched apply (index-vault.ts) must check this immediately
// before writing a plan: a concurrent index-on-write commit (write_note / the vault watcher,
// routed through THE-455's IndexCoordinator to indexNote, on the SAME cache.db connection) can land
// between a plan's pre-read and its apply, since indexVault plans+embeds a whole batch outside any
// transaction before applying it inside one. Applying a plan whose `existing` no longer matches
// would either revert the concurrent writer's fresher content back to what this plan saw, or prune
// chunk ids the concurrent writer already rewrote — invisibly, since neither writer takes a lock
// against the other. indexNote itself has the same plan-then-await-then-apply shape, but never
// needs this guard: IndexCoordinator is the only production caller and serializes same-path work
// (THE-455), so no second write for the SAME path can land inside one indexNote call's own await.
export function existingRowsMatch(planned: ExistingRow[], current: ExistingRow[]): boolean {
  if (planned.length !== current.length) return false;
  const byId = new Map(current.map((r) => [r.id, r]));
  return planned.every((p) => {
    const c = byId.get(p.id);
    return (
      c !== undefined && c.content_hash === p.content_hash && c.active_model === p.active_model
    );
  });
}

// Compute a note's write plan WITHOUT embedding — NO network, NO database writes, NO transaction.
// Vectors are filled later by embedPlans, which batches the embed() calls across many notes so a
// reconcile does not pay one serial round-trip per note. Returns { plan: null } when the note is
// unchanged (nothing to prune or embed), so the caller opens no transaction for a warm re-index.
export function computeNotePlan(
  db: Database,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
  /** Cross-path embedding dedup (migration 20260719_001): a per-RUN registry of content_hash -> the
   *  first walked path producing that EMBED text. Keying on content_hash (not the raw body_sha) is
   *  what makes dedup safe under contextual enrichment (THE-406): content_hash covers the title +
   *  breadcrumb + body actually embedded, so two identical bodies under DIFFERENT titles no longer
   *  collide and no longer share a (wrongly-titled) vector; with enrichment off it equals the raw-body
   *  hash, so cross-path dedup of identical bodies is unchanged. Purely in-memory, so it works even on
   *  a cache.db that predates the body_sha column. Callers on the batched indexVault path share ONE
   *  map across the whole walk; single-note paths pass a fresh (effectively empty) map. */
  dedupRegistry: Map<string, string> = new Map(),
  /** THE-454: enable cross-path embedding dedup only when applyNoteWrites can later COPY the
   *  sibling's stored vector to a skipEmbed chunk — i.e. when the body_sha column exists. Without
   *  it, embed every chunk, or a duplicate path would be left with no vector (dense-invisible). */
  dedupEnabled = false,
  /** THE-531: the active embedding model (provider.id). A chunk whose stored active embedding is from
   *  a DIFFERENT model is re-embedded even when its content_hash is unchanged, so a same-dimension
   *  model swap re-embeds the corpus on the next reconcile instead of silently shrinking it. Omitted
   *  -> content-hash-only gate (back-compat). */
  model?: string,
  /** THE-501: preloaded per-path chunk state for the whole vault (built once by preloadChunkState).
   *  When present, this note's slice is used and no per-note chunk query runs. Omitted -> per-note
   *  query (the single-note indexing path). */
  preloadedExisting?: Map<string, ExistingRow[]>,
  /** THE-424: indexing.chunkTokens. Undefined -> the chunker's own DEFAULT_CHUNK_TOKENS, which is
   *  what every caller got before this parameter existed, so an un-updated caller is unchanged
   *  rather than silently re-chunked. Last in the list for the same reason. */
  chunkTokens?: number,
): PlanResult {
  // THE-823: `path` is already this function's own parameter — pass it through so a malformed note
  // reached via computeNotePlan (rather than index-vault.ts's earlier parseNote call) still names
  // itself.
  const body = parseNote(raw, path).body;
  // Secret-gate (THE-134 fold): a chunk whose content matches a credential shape is dropped
  // before embedding — never embedded, never stored, pruned if it existed. Class names only
  // are logged; the matched value is never logged or thrown.
  let secretsSkipped = 0;
  const flagged: string[] = [];
  // THE-406: with enrichment on, the content hash is computed over the ENRICHED text, so flipping
  // embeddings.chunkContext re-embeds every chunk on the next pass instead of silently serving
  // vectors built from a different representation.
  const desired = chunkNote(body, chunkTokens !== undefined ? { maxTokens: chunkTokens } : {})
    .map((c): PlannedChunk => {
      // body_sha keys on the RAW body (c.content), PRE-enrichment — it must NOT depend on the
      // path-salted embed text, so identical bodies at different paths collide (migration
      // 20260719_001).
      const bodySha = contentHash(c.content);
      if (!enrich) return { ...c, id: chunkId(vaultId, path, c.index), bodySha };
      const embedText = enrichChunkText(path, c.headings, c.content);
      return {
        ...c,
        id: chunkId(vaultId, path, c.index),
        embedText,
        contentHash: contentHash(embedText),
        bodySha,
      };
    })
    .filter((c) => {
      const scan = scanSecrets(c.content);
      if (scan.clean) return true;
      flagged.push(c.content);
      secretsSkipped += 1;
      process.stderr.write(
        `[ingest] secret-gate skipped ${path}#${c.index} (${scan.classes.join(", ")})\n`,
      );
      return false;
    });
  const desiredIds = new Set(desired.map((d) => d.id));
  // THE-531: LEFT JOIN the active embedding so we know each chunk's stored model, not just its
  // content_hash. A chunk with no active embedding yields active_model = null (re-embed).
  // THE-501: on a full reconcile the caller preloads the whole vault's chunk state in ONE query and
  // passes this note's slice, so computeNotePlan issues no per-note chunk query (N queries -> 1). The
  // single-note path passes no preload and keeps the targeted per-note query.
  const existing = preloadedExisting?.get(path) ?? readExistingChunkRows(db, vaultId, path);
  const existingById = new Map(existing.map((e) => [e.id, e]));
  // Re-embed when the content changed OR (THE-531) the stored active model differs from the current
  // one. When `model` is undefined the model check is skipped (back-compat, content-hash-only gate).
  const toEmbed = desired.filter((d) => {
    const ex = existingById.get(d.id);
    if (!ex || ex.content_hash !== d.contentHash) return true;
    return model !== undefined && ex.active_model !== model;
  });
  const unchanged = desired.length - toEmbed.length;
  const willPrune = existing.some((e) => !desiredIds.has(e.id));
  // Cross-path embedding dedup (migration 20260719_001). Register EVERY desired chunk's raw-body
  // hash (changed or not) so a later path dedups against a body already indexed here — first walked
  // path wins. Then flag any TO-EMBED chunk whose body was first seen at a DIFFERENT path: it is
  // still STORED at this path (applyNoteWrites writes the chunk row), but its embedding is
  // reused/skipped — embedPlans never sends it to the provider and applyNoteWrites writes no
  // embedding row for it. Same-path repeats keep firstPath === path and are never skipped (an index
  // shift is change detection's job, not dedup's).
  // THE-499: count dedup reuse and let the caller aggregate it into a single per-pass summary,
  // instead of one synchronous stderr line per duplicate chunk (which could cost more than the dedup
  // and floods CI logs). Individual paths stay available behind OBSIDIAN_TC_DEBUG_DEDUP.
  let dedupSkipped = 0;
  if (dedupEnabled) {
    const debug = process.env.OBSIDIAN_TC_DEBUG_DEDUP !== undefined;
    for (const d of desired) {
      if (!dedupRegistry.has(d.contentHash)) dedupRegistry.set(d.contentHash, path);
    }
    for (const d of toEmbed) {
      const firstPath = dedupRegistry.get(d.contentHash);
      if (firstPath !== undefined && firstPath !== path) {
        d.skipEmbed = true;
        dedupSkipped += 1;
        if (debug) {
          process.stderr.write(
            `[ingest] embed-text dedup: ${path}#${d.index} reuses the embedding already computed for ` +
              `${firstPath} (identical embed text); the vector is copied, not recomputed\n`,
          );
        }
      }
    }
  }
  if (toEmbed.length === 0 && !willPrune) {
    return { plan: null, unchanged, secretsSkipped, flagged, dedupSkipped };
  }
  return {
    plan: { path, existing, desiredIds, toEmbed, vectors: [], ts },
    unchanged,
    secretsSkipped,
    flagged,
    dedupSkipped,
  };
}

/** Does the chunks table carry the body_sha column (migration 20260719_001)? A cache.db provisioned
 *  before that migration — or a bare fixture — lacks it; the INSERT then omits body_sha so the write
 *  path keeps working (the in-memory dedup registry is unaffected). Mirrors hasDerivedEdgeColumns. */
// THE-491: column presence only changes at migration time, and migrations run at open before any
// probe — so this is a per-connection constant. It was re-issuing PRAGMA table_info per NOTE
// (called at :684 in the write path and again per reconcile), so a 1000-note vault paid 1000+
// round trips to answer a fixed question. WeakMap keyed on the connection, matching the pattern
// hasNotesTable already uses in fts.ts, so a closed db's entry is collectable.
const bodyShaCache = new WeakMap<Database, boolean>();
const derivedEdgeCache = new WeakMap<Database, boolean>();

/** @internal exported for the memoization test; production callers use it directly. */
export function hasBodyShaColumn(db: Database): boolean {
  const cached = bodyShaCache.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    ok = cols.some((c) => c.name === "body_sha");
  } catch {
    ok = false;
  }
  bodyShaCache.set(db, ok);
  return ok;
}

/** Does vault_edges carry the densification columns (migration 20260713_001: confidence +
 *  source_fingerprint)? A vault_edges provisioned BEFORE that migration — or a bare fixture — has neither,
 *  and the derived-edge upsert would throw and take the whole index pass down with it. No columns means no
 *  derived edge can exist, so there is nothing to reconcile and nothing to prune: skipping is safe. */
/** @internal exported for the memoization test; production callers use it directly. */
export function hasDerivedEdgeColumns(db: Database): boolean {
  const cached = derivedEdgeCache.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const cols = db.prepare("PRAGMA table_info(vault_edges)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    ok = names.has("confidence") && names.has("source_fingerprint");
  } catch {
    ok = false;
  }
  derivedEdgeCache.set(db, ok);
  return ok;
}

/** Per-note frontmatter tag sets (notes.tags is a JSON array). A note with unparseable tags contributes
 *  none — one bad row never aborts the index pass.
 *  @internal exported for the THE-486 delta-vs-full-recompute regression test; production callers use
 *  it directly. */
export function readNoteTags(db: Database, vaultId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db.prepare("SELECT path, tags FROM notes WHERE vault_id = ?").all(vaultId) as Array<{
    path: string;
    tags: string | null;
  }>;
  for (const row of rows) {
    try {
      const parsed = row.tags ? (JSON.parse(row.tags) as unknown) : [];
      if (Array.isArray(parsed)) {
        out.set(
          row.path,
          parsed.filter((t): t is string => typeof t === "string"),
        );
      }
    } catch {
      // unparseable tags -> this note contributes none
    }
  }
  return out;
}
