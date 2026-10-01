// Stable vault identity (20260928_001_vault_identity.sql). See vault/identity.ts's own header for
// the full design. RED on pre-fix main: `resolveAndApplyVaultIdentity` did not exist, a renamed
// vault id's rows stayed orphaned under the old id forever, and two zero-config "main" vaults
// silently shared rows under one id with no refusal.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  queryActiveEmbeddingModels,
  resolveStickyEmbeddings,
} from "../src/embeddings/sticky-provider";
import { ensureChunkColbert } from "../src/search/chunk_colbert";
import { ensureNotesFts } from "../src/search/fts";
import {
  bumpFenceUnconditional,
  commitFence,
  readFenceGeneration,
} from "../src/search/indexing/write-fence";
import { ensureChunkSparse } from "../src/search/sparse";
import {
  CACHE_VAULT_ID_TABLES,
  EXPERIENTIAL_VAULT_ID_TABLES,
  formatVaultRenameNotice,
  normalizeRealpathForIdentity,
  resolveAndApplyVaultIdentity,
} from "../src/vault/identity";
import { canonicalizeVaultRoot } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

// Fix round (Medium 5, cross-vendor review): a controllable override for
// `canonicalizeVaultRootWithStatus`, so a realpath failure (missing dir, transient lock) can be
// injected deterministically and cross-platform — real symlink/8.3-path fixtures would either
// need elevated privileges on Windows CI or a case-insensitive volume no Linux runner has. `null`
// (the default, reset in `afterEach` below) passes through to the real implementation; every
// other test in this file never touches it.
let canonicalOverride: { root: string; canonical: boolean } | null = null;
vi.mock("../src/vault/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/registry")>();
  return {
    ...actual,
    canonicalizeVaultRootWithStatus: (path: string) =>
      canonicalOverride ?? actual.canonicalizeVaultRootWithStatus(path),
  };
});

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXPERIENTIAL_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({
  version: versionOf(f),
  sql: read(f),
}));

function stores(): { cacheDb: Database; edb: Database } {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const edb = openMemoryDb();
  runMigrations(edb, EXPERIENTIAL_CHAIN);
  return { cacheDb, edb };
}

/** A real, existing directory realpath() can resolve — resolveAndApplyVaultIdentity refuses
 *  nothing here, but canonicalizeVaultRoot needs a real path on disk. */
const tmpDirs: string[] = [];
function tmpVaultRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "vault-identity-test-"));
  tmpDirs.push(d);
  // Canonicalized the SAME way `resolveVaultIdentity` canonicalizes it (registry.ts's
  // `canonicalizeVaultRoot`, realpathSync.native under the hood) — CI's Windows runners resolve
  // `os.tmpdir()` to the short (8.3) form (`RUNNER~1`) while realpath expands it to the long form
  // (`runneradmin`); comparing a test-computed "expected" against the raw mkdtemp path diverged
  // from what the resolver actually persists to `vault_identity.root_realpath` on that platform.
  return canonicalizeVaultRoot(d);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  canonicalOverride = null;
});

function seedChunk(db: Database, opts: { vaultId: string; id: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES (?, ?, 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(opts.id, opts.vaultId, now, now);
}

function seedChunkEmbedding(
  db: Database,
  opts: { chunkId: string; model: string; isActive: 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, 4, ?, ?, ?)`,
  ).run(opts.chunkId, opts.model, Buffer.alloc(16), opts.isActive, Date.now());
}

function seedNote(db: Database, opts: { vaultId: string }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at)
     VALUES (?, 'a.md', 'A', '[]', NULL, 'hash', ?, 1, ?)`,
  ).run(opts.vaultId, now, now);
}

function seedAgentEpisode(edb: Database, opts: { vaultId: string; id: string }): void {
  // Minimal insert matching 20260711_002_agent_episodes.sql's NOT NULL columns.
  const now = Date.now();
  edb
    .prepare(
      `INSERT INTO agent_episodes (id, ts, vault_id, channel, episode_type, status)
       VALUES (?, ?, ?, 'dispatch', 'tool_call', 'ok')`,
    )
    .run(opts.id, now, opts.vaultId);
}

describe("resolveAndApplyVaultIdentity — fresh vault (also covers migration backfill)", () => {
  it("inserts a vault_identity row for a vault seen for the first time, no rename notice", () => {
    const { cacheDb, edb } = stores();
    const root = tmpVaultRoot();
    const notices = resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: root }]);
    expect(notices).toEqual([]);
    const row = cacheDb
      .prepare("SELECT vault_id, root_realpath FROM vault_identity WHERE vault_id = 'main'")
      .get() as { vault_id: string; root_realpath: string } | undefined;
    expect(row?.vault_id).toBe("main");
  });

  it('migration backfill: an EXISTING cache.db (data already under id "main", predating this feature, empty vault_identity table) records identity on the next boot without touching existing rows', () => {
    const { cacheDb, edb } = stores();
    const root = tmpVaultRoot();
    seedChunk(cacheDb, { vaultId: "main", id: "c1" });
    seedNote(cacheDb, { vaultId: "main" });
    // vault_identity is empty — simulates a cache.db provisioned before this migration shipped.
    expect(
      (cacheDb.prepare("SELECT COUNT(*) AS n FROM vault_identity").get() as { n: number }).n,
    ).toBe(0);

    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: root }]);

    const chunk = cacheDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as {
      vault_id: string;
    };
    expect(chunk.vault_id).toBe("main"); // untouched — nothing to re-key on a fresh backfill
    const identity = cacheDb
      .prepare("SELECT root_realpath FROM vault_identity WHERE vault_id = 'main'")
      .get() as { root_realpath: string };
    expect(identity.root_realpath).toBe(normalizeRealpathForIdentity(root));
  });
});

describe("resolveAndApplyVaultIdentity — rename (same realpath, different id)", () => {
  it("re-keys chunks/notes across cache.db AND agent_episodes on experiential.db, in one pass, with no re-embed", () => {
    const { cacheDb, edb } = stores();
    const root = tmpVaultRoot();

    // First boot under the OLD id.
    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "old-id", path: root }]);
    seedChunk(cacheDb, { vaultId: "old-id", id: "c1" });
    seedChunkEmbedding(cacheDb, { chunkId: "c1", model: "ollama:nomic-embed-text", isActive: 1 });
    seedNote(cacheDb, { vaultId: "old-id" });
    seedAgentEpisode(edb, { vaultId: "old-id", id: "e1" });

    // Second boot: SAME path, NEW id — a rename.
    const notices = resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "new-id", path: root }]);
    expect(notices).toEqual([
      { oldId: "old-id", newId: "new-id", rootRealpath: normalizeRealpathForIdentity(root) },
    ]);
    const [notice] = notices;
    expect(notice).toBeDefined();
    expect(formatVaultRenameNotice(notice as (typeof notices)[number])).toContain(
      '"old-id" was renamed to "new-id"',
    );

    // chunks + notes re-keyed on cache.db.
    expect(
      (cacheDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as any).vault_id,
    ).toBe("new-id");
    expect(
      (cacheDb.prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = 'new-id'").get() as any).n,
    ).toBe(1);
    expect(
      (cacheDb.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = 'old-id'").get() as any)
        .n,
    ).toBe(0);

    // agent_episodes re-keyed on experiential.db, same rename.
    expect(
      (edb.prepare("SELECT vault_id FROM agent_episodes WHERE id = 'e1'").get() as any).vault_id,
    ).toBe("new-id");

    // No re-embed: chunk_embeddings is untouched (keyed by chunk_id, never vault_id) — same row,
    // still active, same model, same count. "Search still returns them" reduces to: the chunk row
    // it JOINs against now carries the NEW id, so a query scoped to the new id finds it.
    const embRows = cacheDb.prepare("SELECT * FROM chunk_embeddings WHERE chunk_id = 'c1'").all();
    expect(embRows).toHaveLength(1);
    expect((embRows[0] as any).is_active).toBe(1);
    expect((embRows[0] as any).model).toBe("ollama:nomic-embed-text");
    const found = cacheDb
      .prepare(
        `SELECT e.model AS model FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE c.vault_id = 'new-id' AND e.is_active = 1`,
      )
      .all();
    expect(found).toEqual([{ model: "ollama:nomic-embed-text" }]);

    // vault_identity itself now points "new-id" at the same realpath, old-id row is gone.
    expect(
      cacheDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'old-id'").get(),
    ).toBeUndefined();
    expect(
      (
        cacheDb
          .prepare("SELECT root_realpath FROM vault_identity WHERE vault_id = 'new-id'")
          .get() as any
      ).root_realpath,
    ).toBe(normalizeRealpathForIdentity(root));
  });

  it("re-keys note_write_fence rows on rename, and a plan read AFTER the rename commits cleanly instead of being wrongly rejected as stale", () => {
    const { cacheDb, edb } = stores();
    const root = tmpVaultRoot();

    // First boot under the OLD id, then a note is indexed a few times so its fence generation is
    // non-zero — a zero generation would pass by coincidence even if the rekey silently dropped
    // the row instead of moving it.
    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "old-id", path: root }]);
    bumpFenceUnconditional(cacheDb, "old-id", "a.md", Date.now());
    bumpFenceUnconditional(cacheDb, "old-id", "a.md", Date.now());
    const preRenameGeneration = bumpFenceUnconditional(cacheDb, "old-id", "a.md", Date.now());
    expect(preRenameGeneration).toBe(3);

    // Second boot: SAME path, NEW id — a rename.
    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "new-id", path: root }]);

    // The row moved, not vanished or duplicated: old id has nothing, new id carries the SAME
    // generation the old id last committed (a reset to 0 would let a stale pre-rename write race
    // back in under the new id).
    expect(
      cacheDb.prepare("SELECT 1 FROM note_write_fence WHERE vault_id = 'old-id'").get(),
    ).toBeUndefined();
    expect(readFenceGeneration(cacheDb, "new-id", "a.md")).toBe(preRenameGeneration);

    // A plan computed AFTER the rename (reading the re-keyed generation under the new id, exactly
    // as note-plan.ts's computeNotePlan does at plan time) must commit cleanly — this is the
    // failure mode a broken/omitted rekey produces: the plan's baseline (read under the new id)
    // would disagree with whatever commitFence sees, and a legitimate write would be dropped as
    // stale immediately after every rename.
    const planned = readFenceGeneration(cacheDb, "new-id", "a.md");
    const result = commitFence(cacheDb, "new-id", "a.md", planned, Date.now());
    expect(result).toEqual({ ok: true, generation: preRenameGeneration + 1 });
  });

  it("sticky-provider resolution no longer reports ambiguous-orphaned-index after a rename — queryActiveEmbeddingModels finds the rows directly under the new id", () => {
    const { cacheDb, edb } = stores();
    const root = tmpVaultRoot();
    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "old-id", path: root }]);
    seedChunk(cacheDb, { vaultId: "old-id", id: "c1" });
    seedChunkEmbedding(cacheDb, { chunkId: "c1", model: "ollama:nomic-embed-text", isActive: 1 });

    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "new-id", path: root }]);

    // Pre-fix behaviour (no rekey): this would be [] and the caller would fall through to
    // hasOrphanedActiveEmbeddings/queryOrphanedActiveEmbeddingModels -> "ambiguous-orphaned-index".
    const active = queryActiveEmbeddingModels(cacheDb, ["new-id"]);
    expect(active).toEqual([{ model: "ollama:nomic-embed-text", dimensions: 4 }]);

    const resolution = resolveStickyEmbeddings({
      providerExplicit: false,
      onProviderChange: "keep",
      configured: { provider: "local", model: "nomic-embed-text-v1.5", dimensions: 768 },
      activeModels: active,
    });
    // Resolved directly from activeModels — never touches the orphaned/ambiguous branch at all.
    expect(resolution.source).toBe("kept-from-index");
    expect(resolution.provider).toBe("ollama");
  });

  it("crash window: if the experiential re-key fails after cache.db's already committed, vault_identity still shows the OLD id, and a later boot completes the rename (retry-safe, not a half-renamed state)", () => {
    const { cacheDb, edb } = stores();
    const root = tmpVaultRoot();

    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "old-id", path: root }]);
    seedChunk(cacheDb, { vaultId: "old-id", id: "c1" });
    const now = Date.now();
    edb
      .prepare(
        "INSERT INTO preference_profile (vault_id, scope_caller, key, value, weight, version, updated_at) VALUES ('old-id', '', 'k', 'v', 1.0, 1, ?)",
      )
      .run(now);
    // A stale row already sitting under the NEW id — the realistic trigger identity.ts's own
    // rekeyVaultIdInDb doc comment names ("a stale, never-cleaned-up row already sitting under
    // newId from before this feature existed"). Its PRIMARY KEY is (vault_id, scope_caller, key),
    // so re-keying old-id -> new-id collides and the experiential.db transaction rolls back —
    // simulating "the experiential re-key fails" without mocking anything.
    edb
      .prepare(
        "INSERT INTO preference_profile (vault_id, scope_caller, key, value, weight, version, updated_at) VALUES ('new-id', '', 'k', 'stale', 1.0, 1, ?)",
      )
      .run(now);

    expect(() =>
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "new-id", path: root }]),
    ).toThrow();

    // cache.db already committed its rekey (a separate, earlier transaction) before the
    // experiential one threw.
    expect(
      (cacheDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as any).vault_id,
    ).toBe("new-id");
    // vault_identity was NEVER reached (it is updated only after BOTH stores' rekeys commit) —
    // still shows the OLD id, not a half-updated "new-id with orphaned experiential rows" state
    // the pre-fix doc comment described.
    expect(
      cacheDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'old-id'").get(),
    ).toBeDefined();
    expect(
      cacheDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'new-id'").get(),
    ).toBeUndefined();
    // experiential.db's rekey rolled back — the "old-id" row is still there, untouched.
    expect(
      edb
        .prepare("SELECT value FROM preference_profile WHERE vault_id = 'old-id' AND key = 'k'")
        .get(),
    ).toEqual({ value: "v" });

    // Clear the blocker (an operator/maintenance-sweep action, out of scope here) and retry the
    // SAME boot-time call — the next boot, exactly as documented.
    edb.prepare("DELETE FROM preference_profile WHERE vault_id = 'new-id'").run();
    const notices = resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "new-id", path: root }]);
    expect(notices).toEqual([
      { oldId: "old-id", newId: "new-id", rootRealpath: normalizeRealpathForIdentity(root) },
    ]);
    // cache.db's re-key is idempotent (already under new-id, so the retry's UPDATE touches zero
    // rows) — still correct, not duplicated or reverted.
    expect(
      (cacheDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as any).vault_id,
    ).toBe("new-id");
    // experiential.db's rekey now completes.
    expect(
      (edb.prepare("SELECT vault_id FROM preference_profile WHERE key = 'k'").get() as any)
        .vault_id,
    ).toBe("new-id");
    // vault_identity finally moves to the new id.
    expect(
      cacheDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'old-id'").get(),
    ).toBeUndefined();
    expect(
      cacheDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'new-id'").get(),
    ).toBeDefined();
  });
});

describe("resolveAndApplyVaultIdentity — collision (same id, different realpath)", () => {
  it("refuses the second vault, naming both paths, and touches NO rows from the first vault", () => {
    const { cacheDb, edb } = stores();
    const rootA = tmpVaultRoot();
    const rootB = tmpVaultRoot();

    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: rootA }]);
    seedChunk(cacheDb, { vaultId: "main", id: "c1" });

    expect(() =>
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: rootB }]),
    ).toThrowError(/already recorded against a different path/);

    // Vault A's rows are completely untouched.
    expect(
      (cacheDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as any).vault_id,
    ).toBe("main");
    expect(
      (
        cacheDb
          .prepare("SELECT root_realpath FROM vault_identity WHERE vault_id = 'main'")
          .get() as any
      ).root_realpath,
    ).toBe(normalizeRealpathForIdentity(rootA));
  });

  it('zero-config collision: two vaults both defaulting to id "main" with different paths are isolated the same way, with a hint naming the zero-config cause', () => {
    const { cacheDb, edb } = stores();
    const rootA = tmpVaultRoot();
    const rootB = tmpVaultRoot();
    resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: rootA }]);
    let caught: unknown;
    try {
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: rootB }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { details?: { hint?: string } }).details?.hint).toContain(
      'zero-config id "main"',
    );
  });
});

describe("resolveVaultIdentity — provisional identity (realpath-failed lexical fallback is never persisted as authoritative)", () => {
  it("upgrades a provisional row in place when a later boot's realpath succeeds with a DIFFERENT string, instead of refusing the vault against itself", () => {
    const { cacheDb, edb } = stores();
    const configuredPath = "/some/vault/path";

    // First boot: realpath() fails (missing dir, transient lock, ...) — the lexical fallback is
    // recorded, but only as PROVISIONAL.
    canonicalOverride = { root: "/some/vault/path", canonical: false };
    expect(
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "v1", path: configuredPath }]),
    ).toEqual([]);
    const provisional = cacheDb
      .prepare("SELECT root_realpath, root_canonical FROM vault_identity WHERE vault_id = 'v1'")
      .get() as { root_realpath: string; root_canonical: number };
    expect(provisional).toEqual({ root_realpath: "/some/vault/path", root_canonical: 0 });
    seedChunk(cacheDb, { vaultId: "v1", id: "c1" });

    // Second boot: realpath() now succeeds, and — as the migration header names as the realistic
    // trigger (8.3 -> long name, `/var` -> `/private/var`, `\\?\C:\...` vs `C:\...`, a subst
    // drive) — produces a DIFFERENT string for the exact same vault. Pre-fix, this reads as "known
    // id, different path" and throws a collision the vault could never recover from.
    canonicalOverride = { root: "/private/some/vault/path", canonical: true };
    const notices = resolveAndApplyVaultIdentity(cacheDb, edb, [
      { id: "v1", path: configuredPath },
    ]);

    // Not a rename (same id throughout) — no notice, no re-key.
    expect(notices).toEqual([]);
    expect(
      (cacheDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as any).vault_id,
    ).toBe("v1");

    // The row is upgraded IN PLACE: new (canonical) path, no longer provisional.
    const upgraded = cacheDb
      .prepare("SELECT root_realpath, root_canonical FROM vault_identity WHERE vault_id = 'v1'")
      .get() as { root_realpath: string; root_canonical: number };
    expect(upgraded).toEqual({ root_realpath: "/private/some/vault/path", root_canonical: 1 });

    // A third boot at the now-canonical path is a plain no-op — already recorded, consistent.
    const thirdBoot = resolveAndApplyVaultIdentity(cacheDb, edb, [
      { id: "v1", path: configuredPath },
    ]);
    expect(thirdBoot).toEqual([]);
    expect(
      cacheDb.prepare("SELECT root_canonical FROM vault_identity WHERE vault_id = 'v1'").get(),
    ).toEqual({ root_canonical: 1 });
  });

  it("a provisional row does NOT collide with itself while still provisional (same lexical string, still unresolved)", () => {
    const { cacheDb, edb } = stores();
    canonicalOverride = { root: "/some/vault/path", canonical: false };
    expect(
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "v1", path: "/some/vault/path" }]),
    ).toEqual([]);
    // Same boot conditions again (realpath still failing) — same string, plain no-op, still
    // provisional (nothing to upgrade FROM canonical=false TO canonical=false).
    expect(
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "v1", path: "/some/vault/path" }]),
    ).toEqual([]);
    expect(
      cacheDb.prepare("SELECT root_canonical FROM vault_identity WHERE vault_id = 'v1'").get(),
    ).toEqual({ root_canonical: 0 });
  });
});

describe("normalizeRealpathForIdentity — Windows/macOS case-insensitive volumes (injected platform)", () => {
  it("lowercases when caseInsensitive is true (win32/darwin)", () => {
    expect(normalizeRealpathForIdentity("C:\\Users\\Alice\\Vault", true)).toBe(
      "c:\\users\\alice\\vault",
    );
    expect(normalizeRealpathForIdentity("/Users/Alice/Vault", true)).toBe("/users/alice/vault");
  });

  it("leaves case untouched when caseInsensitive is false (linux, ext4/most other posix)", () => {
    expect(normalizeRealpathForIdentity("/home/Alice/Vault", false)).toBe("/home/Alice/Vault");
  });

  it("two differently-cased configured paths for the SAME case-insensitive volume resolve to the same identity key", () => {
    const a = normalizeRealpathForIdentity("/Users/Alice/Vault", true);
    const b = normalizeRealpathForIdentity("/users/alice/vault", true);
    expect(a).toBe(b);
  });
});

describe("CACHE_VAULT_ID_TABLES / EXPERIENTIAL_VAULT_ID_TABLES — inventory matches the live schema", () => {
  function tablesWithVaultIdColumn(db: Database): string[] {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const out: string[] = [];
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      if (cols.some((c) => c.name === "vault_id")) out.push(name);
    }
    return out.sort();
  }

  it("CACHE_VAULT_ID_TABLES (minus vec_chunks, which node:sqlite cannot provision — see vec-vault-rename.test.ts in bun-smoke/) matches every cache.db table with a vault_id column, excluding vault_identity and the deliberately-unlisted chunk_colbert", () => {
    const { cacheDb } = stores();
    // Provision every OTHER runtime-provisioned vault_id-keyed table this suite knows about —
    // review finding (GH #1014 fix round, Medium 2): a fresh `stores()` db alone never creates
    // notes_fts/chunk_sparse/chunk_colbert (they're created on first use, not by a migration), so
    // comparing against an unprovisioned db can never catch a NEW runtime table that forgot to
    // register here. `ensureChunkColbert` is called too, but its result is filtered back out
    // below — it is a KNOWN, DOCUMENTED exclusion (identity.ts's own header), not an oversight;
    // provisioning it here means a bare `PRAGMA table_info` miss can't be confused with "nobody
    // remembered to provision it in this test".
    ensureNotesFts(cacheDb);
    ensureChunkSparse(cacheDb);
    ensureChunkColbert(cacheDb);
    const migrationDeclared = CACHE_VAULT_ID_TABLES.filter((t) => t !== "vec_chunks");
    // vault_identity's OWN `vault_id` column is handled by a dedicated UPDATE in
    // resolveVaultIdentity (not the generic rekeyVaultIdInDb loop) — it is the table BEING
    // consulted to decide a rename, not one re-keyed generically by it — so it is deliberately
    // absent from CACHE_VAULT_ID_TABLES and excluded from this comparison too.
    // write_provenance* carry the vault id inside signed bytes: re-keying them would invalidate
    // every signature, so a rename deliberately leaves them under the old id (identity.ts header).
    const liveTables = tablesWithVaultIdColumn(cacheDb).filter(
      (t) =>
        t !== "vault_identity" &&
        t !== "chunk_colbert" &&
        t !== "write_provenance" &&
        t !== "write_provenance_heads",
    );
    expect([...migrationDeclared].sort()).toEqual(liveTables);
  });

  it("EXPERIENTIAL_VAULT_ID_TABLES matches every experiential.db table with a vault_id column", () => {
    const { edb } = stores();
    expect([...EXPERIENTIAL_VAULT_ID_TABLES].sort()).toEqual(tablesWithVaultIdColumn(edb));
  });
});
