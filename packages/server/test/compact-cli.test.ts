// THE-1039 (GH #930) — `obsidian-tc compact` end to end.
//
// SUBPROCESS, not an import — same rationale as session-rerun-sandbox-e2e.test.ts's own header:
// `run_compact` calls `process.exit` on a busy/integrity failure, and `main()` does too on a usage
// error, so importing either directly risks corrupting this test run's own exit code. Spawning the
// real CLI is also the only way to observe the actual operator-facing surface.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ensureNotesFts } from "../src/search/fts";

/** Whether the `sqlite3` CLI is on PATH — used ONLY to build a fixture (never to run the code
 *  under test), for the one scenario ("logical" FTS shadow-table corruption, F1) that no JS
 *  SQLite binding here (better-sqlite3, node:sqlite, bun:sqlite — all three checked directly)
 *  will produce: every one of them refuses `DELETE FROM notes_fts_docsize` outright ("table ...
 *  may not be modified"), even with `PRAGMA defensive = OFF`. Only the sqlite3 CLI's `.dbconfig
 *  defensive off` (the actual `sqlite3_db_config` C call, not the SQL-level pragma) lifts it.
 *  Skipped, not required, so this suite still runs somewhere the CLI is absent (e.g. a bare
 *  windows-latest runner) — mirrors db-busy-timeout-config.test.ts's own
 *  `describe.skipIf(!bsqlOk)` for an environment-dependent native binding. */
let sqlite3CliOk = true;
try {
  execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
} catch {
  sqlite3CliOk = false;
}

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A real cache.db with notes_fts written across many separate transactions — same shape as
 *  maintenance.test.ts's own THE-1039 fixture — so FTS5's own 'optimize' (and the VACUUM after
 *  it) has real, measurable segment/freelist bloat to reclaim. Closes the handle before returning
 *  so the CLI subprocess is the only writer. */
async function seedInflatedCacheDb(cacheDir: string): Promise<void> {
  const db = await openDatabase(join(cacheDir, "cache.db"));
  provisionCacheDb(db, { version: "test" });
  expect(ensureNotesFts(db)).toBe(true);
  const ins = db.prepare(
    "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('v1', ?, ?, ?)",
  );
  for (let i = 0; i < 300; i++) {
    ins.run(
      `note-${i}.md`,
      `Note number ${i}`,
      `content for note number ${i} — repeated filler text so the index has real bytes to merge and vacuum away. `.repeat(
        20,
      ),
    );
  }
  db.close?.();
}

function setupConfig(): { cacheDir: string; configPath: string } {
  const vaultDir = mkdtempSync(join(tmpdir(), "obtc-compact-vault-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-compact-cache-"));
  const confDir = mkdtempSync(join(tmpdir(), "obtc-compact-conf-"));
  dirs.push(vaultDir, cacheDir, confDir);
  writeFileSync(join(vaultDir, "a.md"), "hello");
  const configPath = join(confDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }));
  return { cacheDir, configPath };
}

describe("THE-1039 (GH #930) — obsidian-tc compact (end to end)", () => {
  it("shrinks cache.db in place: FTS5 optimize + VACUUM reclaim real bytes", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const dbPath = join(cacheDir, "cache.db");
    const beforeBytes = statSync(dbPath).size;

    const r = runCli(["compact", "--config", configPath, "--json", join(cacheDir, "report.json")]);
    expect(r.code, `compact exited ${r.code}, stderr: ${r.stderr}`).toBe(0);

    const afterBytes = statSync(dbPath).size;
    expect(afterBytes).toBeLessThan(beforeBytes);
    expect(r.stdout).toContain("cache.db");

    const report = JSON.parse(readFileSync(join(cacheDir, "report.json"), "utf8")) as Array<{
      db: string;
      ftsOptimized: string[];
      integrityOk: boolean;
    }>;
    const cacheReport = report.find((x) => x.db === "cache.db");
    expect(cacheReport?.ftsOptimized).toEqual(["notes_fts"]);
    expect(cacheReport?.integrityOk).toBe(true);
  }, 30_000);

  it("--into copies via VACUUM INTO, verifies the copy, and leaves the live file byte-for-byte untouched", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const dbPath = join(cacheDir, "cache.db");
    const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-into-"));
    dirs.push(destDir);
    const hashBefore = sha256(dbPath);

    const r = runCli(["compact", "--config", configPath, "--into", destDir]);
    expect(r.code, `compact --into exited ${r.code}, stderr: ${r.stderr}`).toBe(0);

    // THE property this test exists to prove: the LIVE file is untouched.
    expect(sha256(dbPath)).toBe(hashBefore);

    const copyPath = join(destDir, "cache.db");
    expect(existsSync(copyPath)).toBe(true);
    expect(statSync(copyPath).size).toBeLessThan(statSync(dbPath).size);
    // The exact `mv` an operator would run to install the verified copy.
    expect(r.stdout).toMatch(/mv '.*cache\.db' '.*cache\.db'/);
  }, 30_000);

  it("--dry-run reports sizes and changes nothing", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const dbPath = join(cacheDir, "cache.db");
    const hashBefore = sha256(dbPath);

    const r = runCli(["compact", "--config", configPath, "--dry-run"]);
    expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
    expect(sha256(dbPath)).toBe(hashBefore);
    expect(r.stdout).toContain("notes_fts_data");
  }, 30_000);

  // THE-1039 fix round 1 (F1) — cross-vendor review reproduced: `--into` printed "verified copy"
  // and the `mv` UNCONDITIONALLY, before checking whether verification actually passed.
  describe.skipIf(!sqlite3CliOk)(
    "F1 — a copy that FAILS verification is never recommended for install",
    () => {
      it("exits 1, says FAILED verification, and never prints an install recommendation", async () => {
        const { cacheDir, configPath } = setupConfig();
        const dbPath = join(cacheDir, "cache.db");
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        expect(ensureNotesFts(db)).toBe(true);
        db.exec(
          "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('v1', 'a.md', 'A', 'hello world')",
        );
        db.close?.();
        // The exact reviewer probe: a LOGICAL corruption (an emptied FTS5 shadow table) that
        // `VACUUM INTO` can still copy byte-for-byte (it is a structurally valid, if semantically
        // wrong, table) but that the FTS integrity-check catches on the copy afterward.
        execFileSync("sqlite3", [
          dbPath,
          ".dbconfig defensive off",
          "DELETE FROM notes_fts_docsize;",
        ]);

        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-f1-"));
        dirs.push(destDir);
        const r = runCli(["compact", "--config", configPath, "--into", destDir]);

        expect(r.code, `expected a verification failure to exit non-zero`).toBe(1);
        expect(r.stdout).toContain("FAILED verification");
        expect(r.stdout).not.toContain("to install it:");
        expect(r.stdout).not.toContain("verified copy at");
        expect(r.stderr).toMatch(/integrity-check/);
        // Left in place for inspection — not deleted, not silently discarded.
        expect(existsSync(join(destDir, "cache.db"))).toBe(true);
      }, 30_000);
    },
  );

  // THE-1039 fix round 3 (E1, Greptile, T-Rex-verified) — a step AFTER `VACUUM INTO` has already
  // created `destPath` throwing used to report only the LIVE database's path; the copy actually
  // left on disk was invisible from both stdout and --json, so an operator had no way to find it.
  describe.skipIf(!sqlite3CliOk)(
    "E1 — a failure AFTER VACUUM INTO names the retained copy on both stdout and --json",
    () => {
      it("reports destination + retainedCopy when optimizing the copy throws", async () => {
        const { cacheDir, configPath } = setupConfig();
        const dbPath = join(cacheDir, "cache.db");
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        expect(ensureNotesFts(db)).toBe(true);
        db.exec(
          "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('v1', 'a.md', 'A', 'hello world')",
        );
        db.close?.();
        // `VACUUM INTO` is a page-level snapshot copy — it still succeeds on a source whose FTS5
        // shadow schema is this badly broken (dropping the `_config` table, not merely emptying
        // it as F1's fixture does). The resulting COPY is what then throws when `'optimize'` tries
        // to instantiate the fts5 virtual table module against it — "vtable constructor failed" —
        // a genuine step failure AFTER `destPath` already exists, unlike F1's fixture (which
        // copies fine AND optimizes fine; only the integrity-check catches it afterward).
        execFileSync("sqlite3", [
          dbPath,
          ".dbconfig defensive off",
          "DROP TABLE notes_fts_config;",
        ]);

        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-e1-"));
        dirs.push(destDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli([
          "compact",
          "--config",
          configPath,
          "--into",
          destDir,
          "--json",
          jsonPath,
        ]);

        expect(r.code).toBe(1);
        const destPath = join(destDir, "cache.db");
        // The copy is still on disk — VACUUM INTO ran before the throwing step.
        expect(existsSync(destPath)).toBe(true);
        expect(r.stderr).toContain(destPath);
        expect(r.stderr).toMatch(/incomplete copy remains/);

        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          error?: string;
          destination?: string;
          retainedCopy?: boolean;
        }>;
        const cacheReport = report.find((x) => x.db === "cache.db");
        expect(cacheReport?.error).toMatch(/vtable constructor failed/);
        expect(cacheReport?.destination).toBe(destPath);
        expect(cacheReport?.retainedCopy).toBe(true);
      }, 30_000);
    },
  );

  // THE-1039 fix round 1 (A4).
  it("--into a directory that already has this database's file name: a plain-language error, exit 1, not a raw fatal:", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-collide-"));
    dirs.push(destDir);
    writeFileSync(join(destDir, "cache.db"), "not a real database");

    const r = runCli(["compact", "--config", configPath, "--into", destDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(r.stderr).not.toContain("fatal:");
  }, 30_000);

  // THE-1039 fix round 1 (A1) — incident: cache.db compacted successfully, then experiential.db
  // hit SQLITE_BUSY and `process.exit(1)` fired from inside the loop BEFORE the report/--json for
  // the already-succeeded cache.db was ever written.
  it("A1: one db ok + one db busy — BOTH are reported (stdout and --json), exit 1", async () => {
    const { cacheDir } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    // A short busyTimeoutMs so the busy connection below only needs to be held briefly.
    const confDir = mkdtempSync(join(tmpdir(), "obtc-compact-busy-conf-"));
    dirs.push(confDir);
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        cacheDir,
        vaults: [{ id: "main", path: cacheDir }],
        db: { busyTimeoutMs: 200 },
      }),
    );
    const expPath = join(cacheDir, "experiential.db");
    const edb = await openDatabase(expPath);
    edb.exec("CREATE TABLE IF NOT EXISTS t(x)");
    edb.close?.();

    // Hold an exclusive-lock-forcing write transaction open on experiential.db for the duration
    // of the compact call, so its own VACUUM cannot acquire the lock it needs and times out busy.
    const holder = await openDatabase(expPath);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO t VALUES (1)");
    try {
      const jsonPath = join(cacheDir, "report.json");
      const r = runCli(["compact", "--config", configPath, "--json", jsonPath]);

      expect(r.code).toBe(1);
      // cache.db's own success is STILL reported.
      expect(r.stdout).toMatch(/cache\.db:.* reclaimed/);
      expect(r.stderr).toMatch(/experiential\.db.*busy/);

      const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
        db: string;
        integrityOk: boolean;
        error?: string;
      }>;
      expect(report.map((r2) => r2.db).sort()).toEqual(["cache.db", "experiential.db"]);
      const cacheReport = report.find((r2) => r2.db === "cache.db");
      const expReport = report.find((r2) => r2.db === "experiential.db");
      expect(cacheReport?.integrityOk).toBe(true);
      expect(expReport?.integrityOk).toBe(false);
      expect(expReport?.error).toMatch(/busy/);
    } finally {
      holder.exec("ROLLBACK");
      holder.close?.();
    }
  }, 30_000);

  // THE-1039 fix round 1 (F3 + A2) — VACUUM's freed pages can sit entirely in the `-wal` sidecar
  // until checkpointed; measuring `afterBytes` before closing (or checkpointing) the connection
  // reported ZERO bytes reclaimed on a WAL database whose main file had not shrunk yet, even
  // though the true on-disk footprint (main + -wal) had. Reproduces the reviewer's own numbers
  // (100 ~4 KB rows, then emptied): before this fix the main file alone stayed flat across
  // compact; after it, the reported reclaim is positive and matches the real post-exit size.
  it("F3/A2: measures the true on-disk footprint (main + -wal), not the pre-checkpoint main file alone", async () => {
    const { cacheDir, configPath } = setupConfig();
    const dbPath = join(cacheDir, "cache.db");
    const db = await openDatabase(dbPath);
    provisionCacheDb(db, { version: "test" });
    const ins = db.prepare(
      "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const blob = "x".repeat(4000);
    for (let i = 0; i < 100; i++) {
      ins.run("v1", `k${i}`, "t", "h", 1, 2, blob, blob.length, 9_999_999_999_999);
    }
    db.exec("DELETE FROM idempotency_keys");
    db.close?.();

    const jsonPath = join(cacheDir, "report.json");
    const r = runCli(["compact", "--config", configPath, "--json", jsonPath]);
    expect(r.code, `compact exited ${r.code}, stderr: ${r.stderr}`).toBe(0);

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
      db: string;
      beforeBytes: number;
      afterBytes: number;
      reclaimedBytes: number;
    }>;
    const cacheReport = report.find((x) => x.db === "cache.db");
    expect(cacheReport?.reclaimedBytes).toBeGreaterThan(0);
    // The reported afterBytes must match what is ACTUALLY on disk once the process has fully
    // exited (main file only at that point — our own checkpoint(TRUNCATE) already emptied -wal).
    expect(cacheReport?.afterBytes).toBe(statSync(dbPath).size);
  }, 30_000);

  // Fix round 2 addendum — `run_compact`'s catch now wraps ANY per-database failure into a report
  // row, not only a classified `CompactError` (busy / destination-exists). A genuinely unexpected
  // error mid-VACUUM (here: a physically corrupted experiential.db, "database disk image is
  // malformed" — not busy, not a destination collision) must not erase cache.db's own success.
  it("a non-CompactError failure (corrupted experiential.db) is reported, not a crash that erases cache.db's success", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const expPath = join(cacheDir, "experiential.db");
    const edb = await openDatabase(expPath);
    edb.exec("CREATE TABLE t(x)");
    edb.exec("INSERT INTO t VALUES (1),(2),(3)");
    edb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    edb.close?.();
    // Truncate to a physically malformed (not merely busy/missing) file — VACUUM on this throws a
    // plain "database disk image is malformed" Error, never classified as a CompactError.
    const size = statSync(expPath).size;
    const fd = openSync(expPath, "r+");
    ftruncateSync(fd, Math.floor(size * 0.5));
    closeSync(fd);

    const jsonPath = join(cacheDir, "report.json");
    const r = runCli(["compact", "--config", configPath, "--json", jsonPath]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/cache\.db:.* reclaimed/);
    expect(r.stderr).toMatch(/experiential\.db:.*malformed/);

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
      db: string;
      integrityOk: boolean;
      error?: string;
    }>;
    const cacheReport = report.find((x) => x.db === "cache.db");
    const expReport = report.find((x) => x.db === "experiential.db");
    expect(cacheReport?.integrityOk).toBe(true);
    expect(expReport?.integrityOk).toBe(false);
    expect(expReport?.error).toMatch(/malformed/);
  }, 30_000);
});
