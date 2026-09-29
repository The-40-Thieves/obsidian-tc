// Stable vault identity (20260928_001_vault_identity.sql). `chunks.vault_id` (and every other
// vault_id-keyed table) keys on `config.vaults[].id`, a mutable string with no path identity
// behind it — renaming that id orphans the old id's rows, and the zero-config path always assigns
// id "main" with a shared default cacheDir, so two different vaults opened that way silently
// share rows under one id. See the migration's own header and GH #995's sticky-provider resolver
// (embeddings/sticky-provider.ts) for the stop-gap this table replaces.
//
// Boot-time resolver: compare each configured vault's CANONICAL root (reusing
// `canonicalizeVaultRootWithStatus`, so this can never disagree with VaultRegistry) against
// `vault_identity`:
//   - unknown id, unknown path  -> fresh vault. Insert its identity row.
//   - known id, SAME path       -> no-op (already recorded).
//   - known id, DIFFERENT path  -> a different vault reusing this id (incl. zero-config "main").
//     ISOLATED: refused with a clear error rather than served or silently overwritten (see
//     `resolveVaultIdentity` for why isolate beats namespacing).
//   - unknown id, KNOWN path (under a different id) -> a rename. Every vault_id-keyed row, across
//     BOTH cache.db and experiential.db, is re-keyed old id -> new id (each store its own
//     transaction — see `resolveAndApplyVaultIdentity`), and the identity row is updated in place.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { CASE_INSENSITIVE_FS } from "../acl";
import { tableExists } from "../db/introspect";
import { inTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { canonicalizeVaultRootWithStatus } from "./registry";

/**
 * `vault_identity` lives in cache.db, so every table it re-keys there needs a literal `vault_id`
 * column and no ON DELETE/UPDATE CASCADE relationship can do this for us (nothing FKs on vault_id
 * — chunk_embeddings/chunk_retrievals/chunk_fts key off `chunk_id`/`rowid`, which never change on
 * a rename, so they follow their parent `chunks` row for free and are deliberately NOT listed).
 *
 * Derived from `migration-manifest.ts`'s `CACHE_MIGRATION_FILES` chain by reading every
 * `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN vault_id` across it (2026-09-28) — `test/
 * vault-identity.test.ts`'s inventory suite guards this against drift. `vec_chunks`/`notes_fts`/
 * `chunk_sparse` are runtime-provisioned (created `IF NOT EXISTS` on first use, not by a
 * migration), re-keyed conditionally on `tableExists`, appended after the migration-declared set.
 * Deliberately EXCLUDES `vault_identity` itself (its own PK, updated directly by
 * `resolveVaultIdentity`) and `chunk_colbert` (also runtime-provisioned/`vault_id`-bearing, but
 * `loadChunkColbert` looks up rows by `chunk_id` only — a stale value there is never consulted).
 */
export const CACHE_VAULT_ID_TABLES: readonly string[] = [
  "acl_path_sets",
  "capture_queue",
  "chunks",
  "cluster_summaries",
  "cluster_summary_members",
  "contradictions",
  "elicit_tokens",
  "event_log",
  "idempotency_keys",
  "jobs",
  "memory_entities",
  "note_snapshots",
  "note_summaries",
  "note_write_fence",
  "notes",
  "snapshot_blobs",
  "syntheses",
  "vault_context_watermark",
  "vault_edges",
  "vault_generation",
  "workspace_sessions",
  // Runtime-provisioned, not migration-declared — see the doc comment above.
  "vec_chunks",
  "notes_fts",
  "chunk_sparse",
];

/**
 * The experiential.db counterpart — every `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN vault_id`
 * across `migration-manifest.ts`'s `EXPERIENTIAL_MIGRATION_FILES` chain (2026-09-28).
 * `chunk_retrievals` deliberately has NO vault_id (20260805_001's own migration header: a citation
 * pass genuinely does not know which vault it stamped) and so is absent here for the same reason
 * chunk_embeddings is absent from `CACHE_VAULT_ID_TABLES` — nothing to re-key.
 */
export const EXPERIENTIAL_VAULT_ID_TABLES: readonly string[] = [
  "agent_episodes",
  "gap_reports",
  "goals",
  "note_quality",
  "preference_deltas",
  "preference_profile",
  "retrieval_policy",
  "score_calibration",
];

/**
 * Normalize a realpath for IDENTITY COMPARISON (never display, never opening a file) on a
 * case-insensitive filesystem, so `/Vault` and `/vault` resolve to the SAME `vault_identity` row
 * instead of two different vaults, or worse, an id collision refusal against itself. Reuses
 * `acl.ts`'s `CASE_INSENSITIVE_FS` (win32/darwin) rather than re-deriving the platform check, and
 * lowercases (not a locale-aware fold) matching NTFS/APFS's ASCII-range case-insensitivity — same
 * strategy `acl.ts` already applies to path globs.
 *
 * Not chosen: `dev`+`ino` (stat identity) instead of a path string. It sidesteps case-folding, but
 * `root_realpath` also needs to be a portable value an operator can read in a boot-error message —
 * a `(dev, ino)` pair means nothing to a person deciding which colliding vault to rename, and
 * inode numbers are not stable across a restore/remount the way a path is already assumed to be.
 */
export function normalizeRealpathForIdentity(
  realpath: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS,
): string {
  return caseInsensitive ? realpath.toLowerCase() : realpath;
}

interface VaultIdentityRow {
  vault_id: string;
  root_realpath: string;
  root_canonical: 0 | 1;
}

/** One vault this resolver renamed at boot — the shape `formatVaultRenameNotice` prints and
 *  `emitBootNotices` (boot-notices.ts) surfaces alongside the other boot-time notices. */
export interface VaultRenameNotice {
  oldId: string;
  newId: string;
  rootRealpath: string;
}

/**
 * `vec_chunks.vault_id` is declared `partition key` (search/vec.ts's `ensureVecChunks` DDL) —
 * sqlite-vec rejects an `UPDATE` that changes a partition-key value, aborting the whole cache.db
 * re-key the moment a real (already-indexed) vault hit it. No UPDATE workaround exists, so this
 * reads every row already under `oldId` (unchanged bytes, no re-embed), deletes them, and
 * re-inserts under `newId` — reading FROM `vec_chunks` itself, not re-derived from
 * `chunk_embeddings ⨝ chunks` (`ensureVecChunks`'s own rebuild shape, for a different reason: a
 * fingerprint change). Runs inside the same transaction as the rest of `rekeyVaultIdInDb`'s loop.
 */
function rekeyVecChunksPartition(db: Database, oldId: string, newId: string): void {
  const rows = db
    .prepare("SELECT chunk_id, path, model, embedding FROM vec_chunks WHERE vault_id = ?")
    .all(oldId) as Array<{ chunk_id: string; path: string; model: string; embedding: Buffer }>;
  if (rows.length === 0) return;
  db.prepare("DELETE FROM vec_chunks WHERE vault_id = ?").run(oldId);
  const insert = db.prepare(
    "INSERT INTO vec_chunks (chunk_id, vault_id, path, model, embedding) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) insert.run(row.chunk_id, newId, row.path, row.model, row.embedding);
}

/**
 * Re-key every `vault_id` value from `oldId` to `newId` across `tables` on `db`, in one
 * transaction — a constraint violation on ANY table (e.g. a stale, never-cleaned-up row already
 * sitting under `newId` from before this feature existed) rolls back the whole rename rather than
 * leaving some tables renamed and others not. `tableExists` guards each table because
 * `vec_chunks`/`notes_fts` may not have been provisioned yet on a vault that has never indexed.
 * `vec_chunks` is special-cased to `rekeyVecChunksPartition` (see its own header for why).
 */
function rekeyVaultIdInDb(
  db: Database,
  oldId: string,
  newId: string,
  tables: readonly string[],
): void {
  inTransaction(db, () => {
    for (const table of tables) {
      if (!tableExists(db, table)) continue;
      if (table === "vec_chunks") {
        rekeyVecChunksPartition(db, oldId, newId);
        continue;
      }
      db.prepare(`UPDATE ${table} SET vault_id = ? WHERE vault_id = ?`).run(newId, oldId);
    }
  });
}

/**
 * Resolve ONE configured vault's identity against `vault_identity` (cache.db) and apply the
 * result: insert a fresh row, no-op when already consistent, re-key `oldId` -> `id` across BOTH
 * stores on a rename, or throw on a collision. Returns the rename notice, undefined for insert/
 * no-op.
 *
 * Why isolate (fail closed) rather than namespace a same-id/different-path collision: silently
 * picking a DIFFERENT effective id for the second vault (e.g. suffixing it) would let both boot,
 * but that id is also every tool call's `vault` argument and every ACL path-set key — a caller
 * configured `id: "main"` silently rebound to `"main-2"` has no way to discover that short of a
 * boot log, and every integration hardcoding `vault: "main"` breaks with no config change made.
 * Refusing to boot that ONE vault with an error naming both paths matches the fail-closed posture
 * `applyStickyEmbeddings` already takes for an unmappable stored provider — surface the ambiguity
 * rather than guess through it. Other configured vaults are unaffected.
 */
function resolveVaultIdentity(
  db: Database,
  experientialDb: Database,
  vault: { id: string; path: string },
  now: number,
): VaultRenameNotice | undefined {
  const { root, canonical } = canonicalizeVaultRootWithStatus(vault.path);
  const normalized = normalizeRealpathForIdentity(root);

  const rowById = db
    .prepare(
      "SELECT vault_id, root_realpath, root_canonical FROM vault_identity WHERE vault_id = ?",
    )
    .get(vault.id) as VaultIdentityRow | undefined;

  if (rowById !== undefined) {
    if (rowById.root_realpath === normalized) {
      // Consistent — but still upgrade a PROVISIONAL row (migration header) if this boot's
      // realpath happened to match the stored lexical fallback byte-for-byte.
      if (rowById.root_canonical === 0 && canonical) {
        db.prepare(
          "UPDATE vault_identity SET root_canonical = 1, updated_at = ? WHERE vault_id = ?",
        ).run(now, vault.id);
      }
      return undefined;
    }
    if (rowById.root_canonical === 0 && canonical) {
      // PROVISIONAL row (realpath failed a prior boot), now genuinely resolved to a DIFFERENT
      // string (8.3 -> long name, `/var` -> `/private/var`, `\\?\C:\...` vs `C:\...`, a subst
      // drive). Same id -> in-place upgrade, not a collision; no re-key needed. (A real collision
      // with another vault's canonical value still hits the UNIQUE index below.)
      db.prepare(
        "UPDATE vault_identity SET root_realpath = ?, root_canonical = 1, updated_at = ? WHERE vault_id = ?",
      ).run(normalized, now, vault.id);
      return undefined;
    }
    throw err.conflict(
      `vault id "${vault.id}" is already recorded against a different path — refusing to share ` +
        "or overwrite its index rows with a different vault.",
      {
        vaultId: vault.id,
        recordedPath: rowById.root_realpath,
        configuredPath: normalized,
        hint:
          vault.id === "main"
            ? 'Both vaults are using the default zero-config id "main". Give each vault an ' +
              "explicit, distinct `id` in config.vaults (and, if they still share a cacheDir, a " +
              "distinct `cacheDir` too)."
            : `Give this vault a different \`id\` in config.vaults, or move it back to ` +
              `"${rowById.root_realpath}" if that path is correct.`,
      },
    );
  }

  const rowByPath = db
    .prepare(
      "SELECT vault_id, root_realpath, root_canonical FROM vault_identity WHERE root_realpath = ?",
    )
    .get(normalized) as VaultIdentityRow | undefined;

  if (rowByPath !== undefined && rowByPath.vault_id !== vault.id) {
    // Rename: rowByPath.vault_id (the OLD id) -> vault.id (the NEW id). Re-key both stores first —
    // if either transaction fails, vault_identity itself is untouched and the next boot retries
    // the same rename from scratch rather than resuming from a half-renamed state.
    const oldId = rowByPath.vault_id;
    rekeyVaultIdInDb(db, oldId, vault.id, CACHE_VAULT_ID_TABLES);
    rekeyVaultIdInDb(experientialDb, oldId, vault.id, EXPERIENTIAL_VAULT_ID_TABLES);
    db.prepare(
      "UPDATE vault_identity SET vault_id = ?, root_canonical = ?, updated_at = ? WHERE vault_id = ?",
    ).run(vault.id, canonical ? 1 : rowByPath.root_canonical, now, oldId);
    return { oldId, newId: vault.id, rootRealpath: normalized };
  }

  // Fresh vault (rowByPath.vault_id === vault.id is impossible — that case already returned above).
  db.prepare(
    "INSERT INTO vault_identity (vault_id, root_realpath, root_canonical, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(vault.id, normalized, canonical ? 1 : 0, now, now);
  return undefined;
}

/**
 * Boot-time entry point: resolve every configured vault's identity against `vault_identity`,
 * re-keying renamed vaults and refusing colliding ones. Must run AFTER cache.db's migrations
 * applied and BEFORE anything reads vault-scoped rows (sticky-provider resolution, the index
 * coordinator, ACL path sets) — stores.ts's `wireStores` calls this between provisioning both
 * databases and the experiential-db open/close decision, inside the cross-process bootstrap
 * barrier (`withBootstrapBarrier`) that already serializes migrations, so two racing processes can
 * never rekey the same rename concurrently.
 *
 * Not a single cross-database transaction: cache.db and experiential.db are physically separate
 * files by design, so "one transaction" per rename means one PER STORE, back to back —
 * `vault_identity` itself is updated LAST, only after BOTH commit (`resolveVaultIdentity`, below).
 * That makes a crash between the two RETRY-SAFE: `vault_identity` stays on the OLD id (never
 * reached), so the next boot's `rowByPath` lookup re-enters the SAME rename branch — cache.db's
 * rekey no-ops (already done), experiential.db's completes, `vault_identity` writes once both
 * finish. No two-phase commit needed. cache.db renames first (authored state); experiential.db is
 * derived telemetry the maintenance sweep already treats as resettable.
 */
export function resolveAndApplyVaultIdentity(
  db: Database,
  experientialDb: Database,
  vaults: readonly { id: string; path: string }[],
): VaultRenameNotice[] {
  const now = Date.now();
  const notices: VaultRenameNotice[] = [];
  for (const vault of vaults) {
    const notice = resolveVaultIdentity(db, experientialDb, vault, now);
    if (notice) notices.push(notice);
  }
  return notices;
}

/** Pure formatter for a rename notice — printed to stderr at boot, same "pure formatter, tested
 *  without a real db" shape as `formatStickyEmbeddingsNotice` (embeddings/sticky-provider.ts) and
 *  `formatStaleExplicitSessionNotice` (boot-notices.ts). */
export function formatVaultRenameNotice(notice: VaultRenameNotice): string {
  return (
    `vault identity: vault "${notice.oldId}" was renamed to "${notice.newId}" (root: ` +
    `${notice.rootRealpath}) — every index row (chunks, embeddings, notes, edges, sessions, and ` +
    `every other vault-scoped table) was re-keyed from the old id to the new one. No re-embed and ` +
    `no data loss; this vault's search index continues to serve its existing rows under the new id.\n`
  );
}
