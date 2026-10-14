import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySchemaMigration, runMigrations, type SchemaMigrationHooks } from "../src/db/migrate";
import { openDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { ensureNotesFts } from "../src/search/fts";
import {
  buildRepresentationManifest,
  representationFingerprint,
} from "../src/search/representation";
import { ensureVecChunks } from "../src/search/vec";
import { makeTempDir, rmTemp } from "./tmp";

const tmpDirs: string[] = [];
const manifest = buildRepresentationManifest(
  { provider: "test", model: "test", dimensions: 3 },
  {},
);

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmTemp(dir);
});

function tmpDir(): string {
  const dir = makeTempDir("otc-migration-peer-");
  tmpDirs.push(dir);
  return dir;
}

interface WriterCase {
  name: string;
  source: string;
  version: string;
  ddl: string;
  setup(db: Database): void;
  apply(db: Database, hooks?: SchemaMigrationHooks): unknown;
  expectedLoserResult: unknown;
  verify(db: Database): void;
}

const writers: WriterCase[] = [
  {
    name: "versioned migration runner",
    source: "db/migrate.ts",
    version: "peer_001",
    ddl: "CREATE TABLE peer_once",
    setup: (db) => runMigrations(db, []),
    apply: (db, hooks) =>
      runMigrations(
        db,
        [
          {
            version: "peer_001",
            sql: "CREATE TABLE peer_once(value INTEGER); INSERT INTO peer_once VALUES (1);",
          },
        ],
        { migrationHooks: hooks },
      ),
    expectedLoserResult: [],
    verify: (db) => {
      expect(db.prepare("SELECT count(*) AS n FROM peer_once").get()).toEqual({ n: 1 });
    },
  },
  {
    name: "notes FTS runtime migration",
    source: "search/fts.ts",
    version: "20260702_002_notes_fts",
    ddl: "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts",
    setup: (db) => {
      runMigrations(db, []);
      db.exec("CREATE TABLE notes(vault_id TEXT, path TEXT, content_hash TEXT)");
    },
    apply: (db, migrationHooks) => ensureNotesFts(db, { migrationHooks }),
    expectedLoserResult: true,
    verify: (db) => {
      expect(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'notes_fts'").get(),
      ).toEqual({ n: 1 });
    },
  },
  {
    name: "chunk FTS runtime migration",
    source: "search/chunk_fts.ts",
    version: "20260710_001_chunk_fts",
    ddl: "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts",
    setup: (db) => {
      runMigrations(db, []);
      db.exec("CREATE TABLE chunks(id TEXT)");
    },
    apply: (db, migrationHooks) => ensureChunkFts(db, { migrationHooks }),
    expectedLoserResult: true,
    verify: (db) => {
      expect(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'chunk_fts'").get(),
      ).toEqual({ n: 1 });
    },
  },
  {
    name: "vector runtime migration",
    source: "search/vec.ts",
    version: "20260519_002_vec_chunks_3",
    ddl: "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks",
    setup: (db) => runMigrations(db, []),
    apply: (db, migrationHooks) => ensureVecChunks(db, manifest, { migrationHooks }),
    expectedLoserResult: true,
    verify: (db) => {
      expect(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'vec_chunks'").get(),
      ).toEqual({ n: 1 });
    },
  },
];

function countDdl(db: Database, ddl: string, onRun: () => void): Database {
  return {
    exec: (sql) => {
      if (sql.includes(ddl)) onRun();
      db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
    prepareCached: db.prepareCached
      ? (sql) => db.prepareCached?.(sql) as ReturnType<Database["prepare"]>
      : undefined,
    loadExtension: db.loadExtension ? (path) => db.loadExtension?.(path) : undefined,
    inTransaction: db.inTransaction ? () => db.inTransaction?.() ?? false : undefined,
    readonlyMode: db.readonlyMode,
  };
}

describe("schema migration peer races", () => {
  it.each(writers)(
    "$name skips a version a peer recorded after its pending read",
    async (writer) => {
      const path = join(tmpDir(), "cache.db");
      const a = await openDatabase(path, 5000);
      const b = await openDatabase(path, 5000);
      writer.setup(a);
      let peerApplied = false;
      let ddlRuns = 0;
      const countedA = countDdl(a, writer.ddl, () => {
        ddlRuns += 1;
      });
      const countedB = countDdl(b, writer.ddl, () => {
        ddlRuns += 1;
      });

      try {
        expect(
          writer.apply(countedB, {
            afterPendingCheck: (version) => {
              if (version !== writer.version) return;
              peerApplied = true;
              writer.apply(countedA);
            },
          }),
        ).toEqual(writer.expectedLoserResult);
        expect(peerApplied).toBe(true);
        expect(ddlRuns).toBe(1);
        expect(
          b
            .prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = ?")
            .get(writer.version),
        ).toEqual({ n: 1 });
        writer.verify(b);
      } finally {
        a.close?.();
        b.close?.();
      }
    },
  );

  it("still rejects a different checksum for an already-recorded version", async () => {
    const path = join(tmpDir(), "checksum.db");
    const a = await openDatabase(path, 5000);
    const b = await openDatabase(path, 5000);
    try {
      runMigrations(a, [{ version: "peer_001", sql: "CREATE TABLE original(value INTEGER);" }]);
      expect(() =>
        runMigrations(b, [{ version: "peer_001", sql: "CREATE TABLE edited(value TEXT);" }]),
      ).toThrow("migration peer_001 checksum mismatch");
    } finally {
      a.close?.();
      b.close?.();
    }
  });

  it.each(writers)("$name keeps checksum mismatches fatal", async (writer) => {
    const path = join(tmpDir(), "checksum-writer.db");
    const db = await openDatabase(path, 5000);
    try {
      writer.setup(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, 0, 'peer', 0, 'different')",
      ).run(writer.version);
      expect(() => writer.apply(db)).toThrow(`migration ${writer.version} checksum mismatch`);
    } finally {
      db.close?.();
    }
  });

  it.each(writers)("$source routes its writer through the shared helper", ({ source }) => {
    const text = readFileSync(join(__dirname, "..", "src", source), "utf8");
    expect(text).toContain("applySchemaMigration(");
  });

  it("keeps the vec rebuild marker advisory when a later rebuild's counts differ", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const db = await openDatabase(join(tmpDir(), "vec-marker.db"), 5000);
    try {
      runMigrations(db, []);
      expect(ensureVecChunks(db, manifest)).toBe(true);
      // A legacy upgrade that skipped 5 vectors recorded its counts in the marker's checksum.
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, 0, 'peer', 0, ?)",
      ).run("20260712_004_vec_chunks_aux_3", "vec0:partition+aux:3:skipped5");
      // A same-dimension model swap rebuilds again, with no skipped vectors this time.
      const swapped = buildRepresentationManifest(
        { provider: "test", model: "swapped", dimensions: 3 },
        {},
      );
      expect(ensureVecChunks(db, swapped)).toBe(true);
      expect(
        db.prepare("SELECT fingerprint FROM vec_index_fingerprint WHERE id = 1").get(),
      ).toEqual({ fingerprint: representationFingerprint(swapped) });
      expect(
        db
          .prepare("SELECT checksum FROM schema_migrations WHERE version = ?")
          .get("20260712_004_vec_chunks_aux_3"),
      ).toEqual({ checksum: "vec0:partition+aux:3:skipped5" });
    } finally {
      stderr.mockRestore();
      db.close?.();
    }
  });

  it("never lets a failing ROLLBACK replace the error that aborted the migration", async () => {
    const db = await openDatabase(join(tmpDir(), "rollback.db"), 5000);
    try {
      runMigrations(db, []);
      expect(() =>
        applySchemaMigration(
          db,
          {
            version: "rollback_001",
            checksum: "x",
            obsidianTcVersion: "t",
            appliedAt: () => 0,
            durationMs: () => 0,
          },
          () => {
            // SQLite has already rolled back (BUSY/FULL/IOERR class), so the helper's own
            // ROLLBACK finds no transaction and throws "cannot rollback".
            db.exec("ROLLBACK");
            throw new Error("original failure");
          },
        ),
      ).toThrow("original failure");
    } finally {
      db.close?.();
    }
  });

  it("keeps a SQLITE_BUSY from the FTS DDL transient, not terminal", async () => {
    const db = await openDatabase(join(tmpDir(), "busy.db"), 5000);
    try {
      writers[1]?.setup(db);
      let busy = true;
      const wrapped: Database = {
        ...countDdl(db, "", () => {}),
        exec: (sql) => {
          if (busy && sql.includes("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts")) {
            // The DDL needs more than the reserved lock; SQLite rolls back before reporting BUSY.
            db.exec("ROLLBACK");
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          }
          db.exec(sql);
        },
      };
      expect(ensureNotesFts(wrapped, { now: () => 0 })).toBe(false);
      busy = false;
      expect(ensureNotesFts(wrapped, { now: () => 3_600_000 })).toBe(true);
    } finally {
      db.close?.();
    }
  });

  it("holds the bootstrap barrier around index schema provisioning only", () => {
    const read = (file: string): string =>
      readFileSync(join(__dirname, "..", "src", "runtime", file), "utf8");
    const core = read("runtime-core-wiring.ts");
    expect(core).toContain("guardSchema: (fn) => withBootstrapBarrier(deps.cacheDir");
    expect(core).not.toMatch(/withBootstrapBarrier\(deps\.cacheDir, \(\) =>\s*wireIndexResources/);
    const wiring = read("indexing-wiring.ts");
    const guard = wiring.indexOf("deps.guardSchema(provision)");
    expect(guard).toBeGreaterThan(wiring.indexOf("await createEmbeddingProviderAsync"));
    expect(wiring.indexOf("ensureVecChunks(deps.db")).toBeLessThan(guard);
  });

  it("keeps every schema_migrations INSERT in the shared helper", () => {
    const root = join(__dirname, "..", "src");
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
      });
    const writers = sourceFiles(root).filter(
      (file) =>
        !file.endsWith("db/migrations-embedded.ts") &&
        readFileSync(file, "utf8").includes("INSERT INTO schema_migrations"),
    );
    expect(writers.length).toBeGreaterThan(0);
    expect(writers).toEqual([join(root, "db", "migrate.ts")]);
  });
});
