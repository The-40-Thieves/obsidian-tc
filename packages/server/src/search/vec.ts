import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedPrepare, type Database } from "../db/types";
import { type RepresentationManifest, representationFingerprint } from "./representation";
import { EMBEDDED_VEC_BASE64 } from "./vec-embedded";

const requireFromHere = createRequire(import.meta.url);

// Encode a JS number[] as a little-endian float32 BLOB — the on-disk wire format
// shared by sqlite-vec's vec0 columns and the brute-force scan in search/semantic.
// THE-687: ArrayLike<number>, not number[] — `Float32Array.from` already accepts any ArrayLike, so
// a Float32Array (what every caller that just decoded a row is holding) was rejected by the
// signature while working perfectly at runtime. Surfaced once bun-smoke joined the typechecker.
export function floatBlob(vector: ArrayLike<number>): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

// Decode a float32 BLOB (Uint8Array/Buffer from a SQLite row) into a Float32Array view.
// Returned directly (zero-copy, THE-266) so the native cosine path takes the typed array
// without re-copying into a number[]; callers only index it and read .length.
export function blobToFloats(blob: Uint8Array): Float32Array {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Float32Array requires a 4-byte-aligned offset; copy when a row view isn't.
  const aligned = u8.byteOffset % 4 === 0 ? u8 : u8.slice();
  const floats = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );
  return floats;
}

// Connections that already loaded the sqlite-vec extension. semanticSearch calls loadVec on
// every query, so memoizing the idempotent require + loadExtension + vec_version() probe per
// connection makes it O(1) after the first success. Failures are NOT cached (a transient failure
// stays retryable); node:sqlite (no loadExtension) is rejected before the cache check.
const vecLoaded = new WeakSet<Database>();

// THE-663: sqlite's extension loader derives the entry-point symbol it dlsym()s from the
// materialized file's basename, so it must be exactly "vec0.<ext>" or loadExtension fails with
// an "undefined symbol" error even though the bytes are correct. Extension is platform-specific,
// mirroring sqlite-vec's own extensionSuffix(). See docs/design/retrieval-dense-index.md.
function vecExtension(): string {
  if (process.platform === "win32") return "dll";
  if (process.platform === "darwin") return "dylib";
  return "so";
}

// Lazily materializes the embedded vec0 binary to a private temp file, once per process, and
// reuses that path for every subsequent loadVec() call — the embedded-copy analogue of vecLoaded's
// per-connection memoization below. Returns undefined when this binary carries no embedded copy
// (EMBEDDED_VEC_BASE64 is the empty placeholder outside a --compile release build), so loadVec
// falls through to its existing "can't load" return false.
//
// Exported (only) so bun-smoke/vec-embedded.test.ts can exercise the materialize+loadExtension
// mechanism directly against a real vec0 binary, without needing an actual --compile build to
// force loadVec's require("sqlite-vec") to fail — see that test for why.
let embeddedVecPath: string | undefined;
export function materializeEmbeddedVec(): string | undefined {
  if (embeddedVecPath) return embeddedVecPath;
  if (!EMBEDDED_VEC_BASE64) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "otc-vec-"));
  chmodSync(dir, 0o700);
  const out = join(dir, `vec0.${vecExtension()}`);
  writeFileSync(out, Buffer.from(EMBEDDED_VEC_BASE64, "base64"));
  chmodSync(out, 0o755);
  embeddedVecPath = out;
  return out;
}

// Load the sqlite-vec extension on this connection. Returns false (never throws)
// when the runtime can't load extensions (node:sqlite) or the platform binary is
// unavailable, so callers degrade to the brute-force cosine scan.
export function loadVec(db: Database): boolean {
  if (typeof db.loadExtension !== "function") return false;
  if (vecLoaded.has(db)) return true;
  try {
    const sqliteVec = requireFromHere("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(sqliteVec.getLoadablePath());
    db.prepare("SELECT vec_version()").get();
    vecLoaded.add(db);
    return true;
  } catch {
    // THE-663: require() above resolves relative to import.meta.url, which `bun build
    // --compile` freezes to the build machine's path, so it throws in every published
    // standalone binary, on every platform. Falls back to the copy baked into this binary for
    // its own target platform — see vec-embedded.ts.
    try {
      const embedded = materializeEmbeddedVec();
      if (!embedded) return false;
      db.loadExtension(embedded);
      db.prepare("SELECT vec_version()").get();
      vecLoaded.add(db);
      return true;
    } catch {
      return false;
    }
  }
}

// Create the per-vault, dimension-bound vec0 virtual table (cosine metric) and
// record it in schema_migrations as 20260519_002_vec_chunks_<dims>, matching the
// schema.sql header. The table + row persist in the DB file; the extension still
// must be reloaded per connection via loadVec. Returns false when the extension
// can't load (caller uses the brute-force scan instead).
//
// THE-460: `fp` is the full representation fingerprint (provider/model/dimensions + distance
// metric + chunker/enrichment versions + schema gen), not just dims. It's persisted in the
// dedicated vec_index_fingerprint table and compared on every call; ANY field changing (a
// same-dimension model swap, a chunker/enrichment version bump, a schema-gen bump, or a plain
// dimension change) triggers the same rebuild+backfill path as the legacy pre-partition shape.
/** THE-612: fired exactly once per DROP+rebuild — see `ensureVecChunks`'s `onRebuild` opt. */
export interface VecRebuildEvent {
  /** "legacy_shape": a pre-partition table was found and reshaped in place. "fingerprint_changed":
   *  the stored representation (provider/model/dims/metric/enrichment/chunker/schema) no longer
   *  matches what was last built — a deploy changed the embedding model, or one config field did. */
  reason: "legacy_shape" | "fingerprint_changed";
  /** Active vectors NOT backfilled because they were captured at a different representation than
   *  the one this rebuild is for — a re-embed regenerates them on the next reconcile. */
  skippedVectors: number;
}

/**
 * THE-683: takes the full RepresentationManifest, not just a VecFingerprint — the extra axes
 * (pooling, instruct prefixes, MRL truncation, multi-vector heads) can make two "same provider,
 * same model" representations produce non-interchangeable vectors. See
 * docs/design/retrieval-dense-index.md for why the fingerprint-only shape was insufficient.
 *
 * Callers build the manifest with `buildRepresentationManifest` — the single derivation, so the
 * two production sites can't disagree about the identity of the index they share.
 */
export function ensureVecChunks(
  db: Database,
  manifest: RepresentationManifest,
  opts: {
    now?: () => number;
    /** THE-612: this event is RARE (a deploy changed the embedding model, or a pre-partition db is
     *  being upgraded) and has a HUGE blast radius — every vault sharing this table goes cold on
     *  dense retrieval until it re-embeds — so it is worth reporting even though this module has no
     *  injected logger and never imports the metrics recorder. Optional and additive, same shape as
     *  the other `opts` callbacks in this file's siblings (log.ts, activation.ts). */
    onRebuild?: (event: VecRebuildEvent) => void;
    /** The value `chunk_embeddings.model` / `vec_chunks.model` actually stores, i.e. `provider.id`
     *  (e.g. "ollama:bge-m3", or "ollama:bge-m3@rev1" once a revision is set — see
     *  embeddings/index.ts's withRevision). Distinct from `fp.model`, which is the BARE model name
     *  and part of the canonical fingerprint string folded by vecFingerprint() — redefining
     *  `fp.model` to `provider.id` would change every existing fingerprint in the field and force
     *  every deployed index to rebuild. Undefined preserves today's behaviour exactly (bind
     *  `fp.model`), so no non-production caller changes. */
    activeModel?: string;
  } = {},
): boolean {
  if (!loadVec(db)) return false;
  const now = opts.now ?? Date.now;
  const dims = manifest.dimensions;
  const version = `20260519_002_vec_chunks_${dims}`;
  // THE-277 item 3 (sqlite-vec >= 0.1.9): vault_id as a PARTITION KEY pre-shards the KNN per
  // vault (the cross-vault crowding THE-287 worked around becomes structurally impossible when
  // the caller passes vaultId), and +path/+model aux columns kill the metadata JOIN for the
  // fields the hot path needs. +content is deliberately NOT aux — it would duplicate the whole
  // corpus text inside the vec file; content stays a batched JOIN only when requested.
  const ddl = `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, vault_id TEXT partition key, +path TEXT, +model TEXT, embedding float[${dims}] distance_metric=cosine)`;

  // THE-460: a dedicated one-row table tracks the computed fingerprint string. Created up front
  // (idempotent) so both the "table missing" and "table present" branches below can read/compare
  // against whatever was last recorded.
  db.exec(
    "CREATE TABLE IF NOT EXISTS vec_index_fingerprint (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL)",
  );
  const computedFp = representationFingerprint(manifest);
  const storedFp = (
    db.prepare("SELECT fingerprint FROM vec_index_fingerprint WHERE id = 1").get() as
      | { fingerprint: string }
      | undefined
  )?.fingerprint;

  const hasTable =
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'vec_chunks'").get() !== undefined;
  if (!hasTable) {
    db.exec(ddl);
  } else {
    // Shape-detect a legacy (pre-partition) table and rebuild it IN PLACE from the stored
    // embeddings — chunk_embeddings holds every active vector, so no re-embed is needed and
    // the rebuilt index is bit-identical (same vectors, same cosine metric).
    let legacy = false;
    try {
      db.prepare("SELECT vault_id FROM vec_chunks LIMIT 1").get();
    } catch {
      legacy = true;
    }
    // THE-460: a fingerprint mismatch is the general rebuild trigger — it SUBSUMES the old
    // THE-457 dims-only check (dimensions are one of the fields folded into the fingerprint) and
    // additionally catches a same-dimension model swap, a chunker/enrichment version bump, or a
    // schema-gen bump. The backfill below only re-inserts vectors already at the current dims
    // (length = dims*4), so a mid-swap re-embed fills the rest on its own reconcile — same as
    // before.
    const fpChanged = storedFp !== computedFp;
    if (legacy || fpChanged) {
      db.exec("DROP TABLE vec_chunks");
      db.exec(ddl);
      const canBackfill =
        db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'chunk_embeddings'").get() !==
        undefined;
      // A pre-partition rebuild only backfills vectors whose byte length matches the CURRENT dims
      // (dims*4). Active embeddings at a DIFFERENT dimensionality (a model/dim swap not yet
      // re-embedded) are excluded and would otherwise vanish from the KNN index silently. Count the
      // skip so it lands in the migration checksum below (this module has no logger, and refusing
      // outright would brick a legitimate mid-swap rebuild).
      let skipped = 0;
      if (canBackfill) {
        const active = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1",
            )
            .get() as { n: number }
        ).n;
        // THE-460 (fix A): filter on model as well as byte length — length alone can't distinguish
        // a same-dimension model swap (old-model vectors are dims*4 too), which would otherwise
        // silently score new-model queries against old-model embeddings. Bind opts.activeModel
        // (the actually-stored provider.id), falling back to fp.model only when absent — see
        // docs/design/retrieval-dense-index.md for why binding fp.model alone is wrong.
        db.prepare(
          `INSERT INTO vec_chunks (chunk_id, vault_id, path, model, embedding)
           SELECT e.chunk_id, c.vault_id, c.path, e.model, e.embedding
           FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
           WHERE e.is_active = 1 AND length(e.embedding) = ${dims * 4} AND e.model = ?`,
        ).run(opts.activeModel ?? manifest.model);
        // THE-612: NOT `.changes` from the INSERT above — vec0's shadow tables make `.changes`
        // report shadow-table writes rather than logical rows. vec_chunks was just DROPped and
        // recreated, so COUNT(*) here is exactly what this INSERT wrote. See
        // docs/design/retrieval-dense-index.md.
        const inserted = (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number })
          .n;
        skipped = active - inserted;
      }
      const rebuiltVersion = `20260712_004_vec_chunks_aux_${dims}`;
      const rec = db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(rebuiltVersion);
      if (!rec) {
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
        ).run(
          rebuiltVersion,
          now(),
          "m2-runtime",
          0,
          `vec0:partition+aux:${dims}${skipped > 0 ? `:skipped${skipped}` : ""}`,
        );
      }
      // THE-612: a full re-embed of every vault sharing this table, previously silent. `legacy`
      // and `fpChanged` are the only two ways into this block, so exactly one reason applies.
      const reason = legacy ? "legacy_shape" : "fingerprint_changed";
      process.stderr.write(
        `[vec] rebuilding vec_chunks (${reason}): every vault's dense index was dropped and is ` +
          `backfilling from chunk_embeddings${skipped > 0 ? `; ${skipped} vector(s) at a different representation are left for the next re-embed` : ""}.\n`,
      );
      opts.onRebuild?.({ reason, skippedVectors: skipped });
    }
  }
  const recorded = db
    .prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get(version);
  if (!recorded) {
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
    ).run(version, now(), "m2-runtime", 0, `vec0:cosine:${dims}`);
  }
  // THE-460: only write when the fingerprint actually changed — a no-change call (fingerprint
  // matches, table already current) stays a true no-op with no writes here.
  if (storedFp !== computedFp) {
    db.prepare(
      "INSERT INTO vec_index_fingerprint (id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint",
    ).run(computedFp);
  }
  return true;
}

/**
 * THE-582: impose a total order on the KNN result — distance ascending, then chunk_id (compared
 * by code unit, not localeCompare, to avoid trading one source of host-dependence for another) —
 * so equal distances rank deterministically instead of in whatever order vec0's scan produced.
 * Done here rather than in SQL because vec0 rejects a second sort key
 * ("Only a single 'ORDER BY distance' clause is allowed on vec0 KNN queries").
 *
 * Exact ties are not a corner case: identical-content chunks embed to a bit-identical distance
 * (duplicate bodies, boilerplate, shared templates), and the tie order can decide top-K
 * membership, not just order within it — this previously produced a host-dependent nDCG. See
 * docs/design/retrieval-dense-index.md for the measurement.
 */
function totalOrderByDistance<T extends { chunk_id: string; distance: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
  });
}

// k-NN over vec_chunks for a query vector; returns chunk_id + cosine distance
// (0 = identical direction, 1 = orthogonal) nearest-first, ties broken by chunk_id
// (THE-582). Cosine similarity is 1 - distance. Requires loadVec to have already
// succeeded on this connection.
// THE-277: pass vaultId to prune the KNN to that vault's partition shard — the
// scan never touches other vaults' vectors, and the aux path rides along free.
export function vecKnn(
  db: Database,
  query: number[],
  k: number,
  vaultId?: string,
): Array<{ chunk_id: string; distance: number; path?: string }> {
  if (vaultId !== undefined) {
    return totalOrderByDistance(
      db
        .prepare(
          "SELECT chunk_id, path, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? AND vault_id = ? ORDER BY distance",
        )
        .all(floatBlob(query), k, vaultId) as Array<{
        chunk_id: string;
        distance: number;
        path?: string;
      }>,
    );
  }
  return totalOrderByDistance(
    db
      .prepare(
        "SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(floatBlob(query), k) as Array<{ chunk_id: string; distance: number }>,
  );
}

// Insert/replace a chunk's vector in vec_chunks. vec0 has no UPSERT, so this is
// delete-then-insert. Call only when the extension is loaded on this connection.
export function upsertVec(
  db: Database,
  chunkId: string,
  vector: number[],
  meta: { vaultId: string; path: string; model: string },
): void {
  // THE-316: static-arity SQL on the per-chunk reconcile write path — cache the compiled statement
  // by SQL text so a warm reindex does not recompile the vec0 DELETE/INSERT once per embedded chunk.
  cachedPrepare(db, "DELETE FROM vec_chunks WHERE chunk_id = ?").run(chunkId);
  cachedPrepare(
    db,
    "INSERT INTO vec_chunks (chunk_id, vault_id, path, model, embedding) VALUES (?, ?, ?, ?, ?)",
  ).run(chunkId, meta.vaultId, meta.path, meta.model, floatBlob(vector));
}
