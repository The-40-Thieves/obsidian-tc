// THE-694/695 — the read-ACL predicate, materialized so SQLite can join on it.
//
// Three retrieval paths compute an aggregate over the whole corpus and hand the result to a caller
// who can only see part of it. Fixing that needs the authorization boundary visible to SQL, which
// the cross-adapter Database interface cannot otherwise provide: bun:sqlite — what production runs
// — exposes no user-defined function registration at all (measured on 1.3.14: `db.function` is
// undefined, and Bun cannot resolve `node:sqlite` either), so a scalar predicate is not an option
// and a joinable table is.
//
// THE SECURITY PROPERTY this rests on: for a fixed (fingerprint, path-string), `readableRel` is
// CONSTANT over time. Its only inputs are `isDefaultDenied(path)` — pure in the path string — plus
// `matchedPathGlob("read", path)` and `strictReadDefault`, and `aclFingerprint` canonicalizes both
// of the latter. So a stale set can only ever MISS a readable path (recall loss); it can never hold
// a path that has since become unreadable, because that change moves the fingerprint and makes the
// old set UNREACHABLE rather than wrong. A missed `generation` bump therefore costs recall, never
// confidentiality — which matters, because generation is the weaker of the two keys.
//
// NOT a cache in the ordinary sense: a miss must never fail a query. Every path returns null rather
// than throwing, and every caller treats null as "keep your existing JS filter".

import { tableExists } from "../db/introspect";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";

/** Cap on stored sets. Growth is bounded by distinct ACL fingerprints — not by generations, since a
 *  regenerated set replaces its predecessor in place — so on a single-principal deployment this
 *  never binds. The bound is still real, and eviction is where the rowid-reuse hazard lives. */
export const DEFAULT_MAX_SETS = 32;

export interface EnsureAclPathSetOpts {
  vaultId: string;
  /** THE-496 `aclFingerprint(config, grantedScopes)` for THIS caller and vault. */
  aclFingerprint: string;
  /** THE-496 `readGeneration(db, vaultId)`. 0 on a pre-migration db, which is safe: a never-bumping
   *  generation degrades this to build-once; it never widens the key. */
  generation: number;
  /** The path universe. Injected so this module never guesses which table defines it. */
  allPaths: () => string[];
  /** `readableRel` bound to this caller. MUST be passed the path exactly as the DB stores it: 35
   *  live paths contain non-ASCII, and `readableRel` NFC-normalizes internally to DECIDE, so the
   *  stored join key has to stay byte-identical to `chunks.path` or the join silently misses. */
  isReadable: (rel: string) => boolean;
  nowMs: number;
  maxSets?: number;
}

/** True when the THE-694 tables exist (a pre-migration cache.db lacks them). */
export function hasAclPathSets(db: Database): boolean {
  return tableExists(db, "acl_path_sets");
}

/**
 * Return the `set_id` of a current permitted-path set for this caller, building it if needed.
 *
 * Returns null — never throws — when the substrate cannot serve the request: tables absent, handle
 * read-only (the eval harness and `doctor --probe` open stores they must not write), or the set
 * would be empty. A failure here costs performance and exactness, never correctness.
 */
export function ensureAclPathSet(db: Database, opts: EnsureAclPathSetOpts): number | null {
  if (!hasAclPathSets(db)) return null;
  try {
    const existing = db
      .prepare(
        "SELECT set_id, generation FROM acl_path_sets WHERE acl_fingerprint = ? AND vault_id = ?",
      )
      .get(opts.aclFingerprint, opts.vaultId) as { set_id: number; generation: number } | undefined;
    // A hit must not touch the universe — enumerating and re-filtering it is the expensive half.
    if (existing && existing.generation === opts.generation) return existing.set_id;

    const universe = opts.allPaths();
    if (universe.length === 0) return null;
    const readable = universe.filter((p) => opts.isReadable(p));
    // EMPTY-SET FLOOR. A broken universe query — or a caller who genuinely reads nothing — must not
    // persist a set that silently filters every query to zero while looking healthy. Same shape as
    // this repo's rule that a gate scanning zero files reports success rather than failing.
    if (readable.length === 0) return null;

    const setId = inWriteTransaction(db, "acl_path_set", () => {
      // UPSERT, never INSERT OR REPLACE. REPLACE is DELETE + INSERT: on a UNIQUE conflict it would
      // delete the set row and insert a fresh one under a NEW set_id, stranding every member.
      db.prepare(
        `INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(acl_fingerprint, vault_id) DO UPDATE SET
           generation = excluded.generation,
           built_at   = excluded.built_at,
           path_count = excluded.path_count`,
      ).run(opts.aclFingerprint, opts.vaultId, opts.generation, opts.nowMs, readable.length);
      const row = db
        .prepare("SELECT set_id FROM acl_path_sets WHERE acl_fingerprint = ? AND vault_id = ?")
        .get(opts.aclFingerprint, opts.vaultId) as { set_id: number };
      db.prepare("DELETE FROM acl_path_members WHERE set_id = ?").run(row.set_id);
      const ins = db.prepare("INSERT INTO acl_path_members (set_id, path) VALUES (?, ?)");
      for (const p of readable) ins.run(row.set_id, p);
      return row.set_id;
    });
    // OUTSIDE the transaction above: inWriteTransaction is non-reentrant (SQLite has no nested
    // transactions), and evictAclPathSets opens its own.
    evictAclPathSets(db, opts.maxSets ?? DEFAULT_MAX_SETS);
    return setId;
  } catch {
    return null;
  }
}

/**
 * Drop all but the `maxSets` most recently built sets. Returns how many were removed.
 *
 * Deletes MEMBERS FIRST and EXPLICITLY rather than leaning on `ON DELETE CASCADE`. `foreign_keys` is
 * per-connection runtime state — every adapter sets it ON today, but a raw connection opened by a
 * script or a future harness would silently lose the cascade. That matters more here than anywhere
 * else in this codebase: eviction deletes the row holding the largest `set_id`, and without
 * AUTOINCREMENT SQLite REUSES that id for the next set, so a stranded member would be joined by a
 * DIFFERENT caller's set. Reproduced with `foreign_keys = OFF` before this was written. The cascade
 * stays in the schema as the backstop for any path that forgets.
 */
export function evictAclPathSets(db: Database, maxSets: number): number {
  if (!hasAclPathSets(db)) return 0;
  try {
    const doomed = db
      .prepare(
        "SELECT set_id FROM acl_path_sets ORDER BY built_at DESC, set_id DESC LIMIT -1 OFFSET ?",
      )
      .all(maxSets) as Array<{ set_id: number }>;
    if (doomed.length === 0) return 0;
    inWriteTransaction(db, "acl_path_set", () => {
      const delMembers = db.prepare("DELETE FROM acl_path_members WHERE set_id = ?");
      const delSet = db.prepare("DELETE FROM acl_path_sets WHERE set_id = ?");
      for (const d of doomed) {
        delMembers.run(d.set_id);
        delSet.run(d.set_id);
      }
    });
    return doomed.length;
  } catch {
    return 0;
  }
}
