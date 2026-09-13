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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ensureNotesFts } from "../src/search/fts";
import { loadVec } from "../src/search/vec";
import { createDanglingWalDb } from "./dangling-wal-fixture";

/** Whether the `sqlite3` CLI is on PATH — used ONLY to build a fixture (never to run the code
 *  under test), for the one scenario ("logical" FTS shadow-table corruption, F1) that no JS
 *  SQLite binding here (better-sqlite3, node:sqlite, bun:sqlite — all three checked directly)
 *  will produce: every one of them refuses `DELETE FROM notes_fts_docsize` outright ("table ...
 *  may not be modified"), even with `PRAGMA defensive = OFF`. Only the sqlite3 CLI's `.dbconfig
 *  defensive off` (the actual `sqlite3_db_config` C call, not the SQL-level pragma) lifts it.
 *  Skipped, not required, so this suite still runs somewhere the CLI is absent (e.g. a bare
 *  windows-latest runner) — mirrors db-busy-timeout-config.test.ts's own
 *  `describe.skipIf(!bsqlOk)` for an environment-dependent native binding. */
// I2's fixture needs sqlite-vec loadable in THIS process to create the vec0 table at all; the CLI
// subprocess under test deliberately never loads it. Probed rather than assumed — bun:sqlite cannot
// load extensions on macOS, and a prebuild may be missing on some runner.
let vecOk = false;

let sqlite3CliOk = true;
try {
  execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
} catch {
  sqlite3CliOk = false;
}

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

beforeAll(async () => {
  const probeDir = mkdtempSync(join(tmpdir(), "obtc-compact-vecprobe-"));
  try {
    const db = await openDatabase(join(probeDir, "probe.db"));
    vecOk = loadVec(db);
    db.close?.();
  } catch {
    vecOk = false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

// I3: the SPAWN timeout must sit BELOW the per-test budget, or a slow spawn is killed by vitest
// first and the failure arrives as a bare "test timed out" with no stdout/stderr to read — which is
// exactly what windows-latest showed before a rerun passed. With this ordering the spawn dies first
// and its output reaches the assertion message. The budget itself follows
// perf-isolate-integration.test.ts's win32 pattern: that runner is slow enough to need the headroom.
const SPAWN_TIMEOUT_MS = 20_000;
const TEST_BUDGET_MS = process.platform === "win32" ? 60_000 : 30_000;

function runCli(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1", ...env },
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
  it(
    "shrinks cache.db in place: FTS5 optimize + VACUUM reclaim real bytes",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const dbPath = join(cacheDir, "cache.db");
      const beforeBytes = statSync(dbPath).size;

      const r = runCli([
        "compact",
        "--config",
        configPath,
        "--json",
        join(cacheDir, "report.json"),
      ]);
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
    },
    TEST_BUDGET_MS,
  );

  it(
    "--into copies via VACUUM INTO, verifies the copy, and leaves the live file byte-for-byte untouched",
    async () => {
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
    },
    TEST_BUDGET_MS,
  );

  it(
    "--dry-run reports sizes and changes nothing",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const dbPath = join(cacheDir, "cache.db");
      const hashBefore = sha256(dbPath);

      const r = runCli(["compact", "--config", configPath, "--dry-run"]);
      expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
      expect(sha256(dbPath)).toBe(hashBefore);
      expect(r.stdout).toContain("notes_fts_data");
    },
    TEST_BUDGET_MS,
  );

  // THE-1039 fix round 1 (F1) — cross-vendor review reproduced: `--into` printed "verified copy"
  // and the `mv` UNCONDITIONALLY, before checking whether verification actually passed.
  describe.skipIf(!sqlite3CliOk)(
    "F1 — a copy that FAILS verification is never recommended for install",
    () => {
      it(
        "exits 1, says FAILED verification, and never prints an install recommendation",
        async () => {
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
        },
        TEST_BUDGET_MS,
      );
    },
  );

  // THE-1039 fix round 3 (E1, Greptile, T-Rex-verified) — a step AFTER `VACUUM INTO` has already
  // created `destPath` throwing used to report only the LIVE database's path; the copy actually
  // left on disk was invisible from both stdout and --json, so an operator had no way to find it.
  //
  // Fix round 4 (M1): the failure injection is now `OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE`
  // (compact.ts's `forcedPostCopyFailure`), not sqlite3-CLI corruption of the source. The old
  // fixture dropped `notes_fts_config` and relied on `VACUUM INTO` still producing a copy that
  // `'optimize'` then choked on — a premise that does NOT hold on macOS's SQLite build, where
  // `build-test (macos-latest)` failed `existsSync(destPath)`: no copy was created at all, so the
  // step that was supposed to throw AFTER the copy existed never ran. The hook throws from exactly
  // that position on every SQLite build, needs no external binary, and needs no skipIf.
  describe("E1 — a failure AFTER VACUUM INTO names the retained copy on both stdout and --json", () => {
    it(
      "exits 1, keeps the copy, and reports destination + retainedCopy",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-e1-"));
        dirs.push(destDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(
          ["compact", "--config", configPath, "--into", destDir, "--json", jsonPath],
          {
            OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE: "1",
          },
        );

        expect(r.code).toBe(1);
        const destPath = join(destDir, "cache.db");
        // The copy is still on disk — VACUUM INTO ran before the throwing step.
        expect(existsSync(destPath)).toBe(true);
        expect(r.stderr).toContain(destPath);
        expect(r.stderr).toMatch(/incomplete copy remains/);
        expect(r.stderr).toMatch(/inspect or remove it before retrying/);

        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          error?: string;
          destination?: string;
          retainedCopy?: boolean;
        }>;
        const cacheReport = report.find((x) => x.db === "cache.db");
        expect(cacheReport?.error).toMatch(/OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE/);
        expect(cacheReport?.destination).toBe(destPath);
        expect(cacheReport?.retainedCopy).toBe(true);
      },
      TEST_BUDGET_MS,
    );

    // Fix round 4 — `busyReason(e)` used to be classified BEFORE `CompactIntoFailedError`, so a
    // SQLITE_BUSY raised by a copy-side step (the copy's own VACUUM contending with anything
    // holding the destination directory's database open) became a bare `CompactBusyError` and lost
    // `destPath` — the one failure shape E1's reporting did not reach. Classification now keys on
    // "does the destination exist", not on the error code, and the busy WORDING is preserved as
    // the wrapped cause.
    it(
      "a SQLITE_BUSY raised after the copy exists still names the copy, and still says busy",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-e1-busy-"));
        dirs.push(destDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(
          ["compact", "--config", configPath, "--into", destDir, "--json", jsonPath],
          {
            OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE: "busy",
          },
        );

        expect(r.code).toBe(1);
        const destPath = join(destDir, "cache.db");
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
        expect(cacheReport?.destination).toBe(destPath);
        expect(cacheReport?.retainedCopy).toBe(true);
        expect(cacheReport?.error).toMatch(/busy/);
        expect(cacheReport?.error).toMatch(/after creating/);
      },
      TEST_BUDGET_MS,
    );
  });

  // THE-1039 fix round 1 (A4).
  it(
    "--into a directory that already has this database's file name: a plain-language error, exit 1, not a raw fatal:",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-collide-"));
      dirs.push(destDir);
      writeFileSync(join(destDir, "cache.db"), "not a real database");

      const r = runCli(["compact", "--config", configPath, "--into", destDir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("already exists");
      expect(r.stderr).not.toContain("fatal:");
    },
    TEST_BUDGET_MS,
  );

  // THE-1039 fix round 1 (A1) — incident: cache.db compacted successfully, then experiential.db
  // hit SQLITE_BUSY and `process.exit(1)` fired from inside the loop BEFORE the report/--json for
  // the already-succeeded cache.db was ever written.
  it(
    "A1: one db ok + one db busy — BOTH are reported (stdout and --json), exit 1",
    async () => {
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
    },
    TEST_BUDGET_MS,
  );

  // THE-1039 fix round 1 (F3 + A2) — VACUUM's freed pages can sit entirely in the `-wal` sidecar
  // until checkpointed; measuring `afterBytes` before closing (or checkpointing) the connection
  // reported ZERO bytes reclaimed on a WAL database whose main file had not shrunk yet, even
  // though the true on-disk footprint (main + -wal) had. Reproduces the reviewer's own numbers
  // (100 ~4 KB rows, then emptied): before this fix the main file alone stayed flat across
  // compact; after it, the reported reclaim is positive and matches the real post-exit size.
  it(
    "F3/A2: measures the true on-disk footprint (main + -wal), not the pre-checkpoint main file alone",
    async () => {
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
    },
    TEST_BUDGET_MS,
  );

  // Fix round 2 addendum — `run_compact`'s catch now wraps ANY per-database failure into a report
  // row, not only a classified `CompactError` (busy / destination-exists). A genuinely unexpected
  // error mid-VACUUM (here: a physically corrupted experiential.db, "database disk image is
  // malformed" — not busy, not a destination collision) must not erase cache.db's own success.
  it(
    "a non-CompactError failure (corrupted experiential.db) is reported, not a crash that erases cache.db's success",
    async () => {
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
    },
    TEST_BUDGET_MS,
  );

  // THE-1039 fix round 4 (H2) — `Database.readonlyMode` existed but no caller READ it, so a real
  // (unforced) fallback in the field was silent: the operator saw a normal `--dry-run`/`--into`
  // report with no hint that the inspection connection had not actually been read-only, and so no
  // hint that SQLite's own checkpoint-on-close could have touched a dangling WAL.
  describe("H2 — a fallback inspection connection is reported, not silent", () => {
    it(
      "--dry-run says so on stdout and carries readonlyMode in --json when forced onto the fallback",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(["compact", "--config", configPath, "--dry-run", "--json", jsonPath], {
          OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK: "1",
        });

        expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/inspection connection was not read-only on this platform/);
        expect(r.stdout).toMatch(/may be checkpointed on close/);

        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          readonlyMode?: string;
        }>;
        expect(report.find((x) => x.db === "cache.db")?.readonlyMode).toBe("fallback");
      },
      TEST_BUDGET_MS,
    );

    // Fix round 5: this asserts the mode is REPORTED and that the notice tracks it — NOT that this
    // platform takes the native path. Round 4 pinned `"native"` here, which pins the SQLite build
    // rather than this code: `build-test (macos-latest)`'s bun:sqlite fails the native readonly open
    // (that is the whole reason a fallback exists), so "native" is false there and the honest value
    // is "fallback". The fallback wording itself is pinned deterministically by the test above.
    it(
      "reports which open mode the ordinary path used, and prints the notice only for fallback",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(["compact", "--config", configPath, "--dry-run", "--json", jsonPath]);

        expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          readonlyMode?: string;
        }>;
        const mode = report.find((x) => x.db === "cache.db")?.readonlyMode;
        expect(["native", "fallback"]).toContain(mode);
        expect(/was not read-only/.test(r.stdout)).toBe(mode === "fallback");
      },
      TEST_BUDGET_MS,
    );
  });

  // I2 (final review) — a table whose `COUNT(*)` FAILS used to come back `-1` from both connections,
  // and `-1 === -1` read as a match, so on any semantic-search store `vec_chunks` (uncountable here:
  // `compact` never loads sqlite-vec, so the vec0 module is absent) was silently unverified while the
  // report said "verified copy". `VACUUM INTO` does copy vec0 content correctly with the module
  // absent — measured — so this is a VERIFICATION gap, not corruption.
  //
  // The fixture needs the module to CREATE the table, which is why it is gated on `loadVec`
  // succeeding in this process rather than assumed (bun:sqlite cannot load extensions on macOS).
  describe("I2 — a table that cannot be counted is not silently 'verified'", () => {
    // `ctx.skip()` rather than `describe.skipIf`: the probe is async (it opens a database) and
    // skipIf is evaluated at COLLECTION time, before any beforeAll runs — it would skip always.
    it(
      "--into reports it as not comparable instead of matching -1 against -1",
      async (ctx) => {
        if (!vecOk) ctx.skip();
        const { cacheDir, configPath } = setupConfig();
        const dbPath = join(cacheDir, "cache.db");
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        expect(loadVec(db)).toBe(true);
        db.exec("CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[4])");
        db.exec("INSERT INTO vec_chunks(rowid, embedding) VALUES (1, '[1,2,3,4]')");
        db.close?.();

        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-vec-"));
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

        // The copy is byte-complete and installable; what the command cannot do is PROVE that one
        // table's row count. That is "partial" — exit 0, the mv recommended, the table named — and
        // it must never print the bare words "verified copy".
        expect(r.code, `compact --into exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        expect(existsSync(join(destDir, "cache.db"))).toBe(true);
        expect(r.stdout).not.toContain("verified copy");
        expect(r.stdout).toMatch(
          /copy verified EXCEPT vec_chunks \(not comparable: no such module: vec0\)/,
        );
        expect(r.stdout).toMatch(/copied page-for-page by VACUUM INTO but not row-counted/);
        expect(r.stdout).toMatch(/to install it: mv /);
        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          verification?: string;
          notComparable?: { table: string; reason: string }[];
          integrityOk: boolean;
        }>;
        const cacheReport = report.find((x) => x.db === "cache.db");
        expect(cacheReport?.verification).toBe("partial");
        expect(cacheReport?.integrityOk).toBe(true);
        expect(cacheReport?.notComparable).toEqual([
          { table: "vec_chunks", reason: "no such module: vec0" },
        ]);
      },
      TEST_BUDGET_MS,
    );
  });

  // I2 ruling — the THIRD outcome: a genuine count divergence between copy and live is still a
  // FAILURE (exit 1, never installable), as distinct from "not comparable" above. `VACUUM INTO` is
  // faithful by construction, so the only deterministic way to produce one is the test-only hook
  // deleting a row from the COPY before verification.
  it(
    "a real row-count mismatch is 'failed', not 'partial': exit 1, no install recommendation",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-mismatch-"));
      dirs.push(destDir);
      const jsonPath = join(cacheDir, "report.json");
      const r = runCli(["compact", "--config", configPath, "--into", destDir, "--json", jsonPath], {
        OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE: "delete:notes_fts",
      });

      expect(r.code).toBe(1);
      expect(r.stdout).toContain("FAILED verification");
      expect(r.stdout).not.toContain("to install it:");
      expect(r.stdout).not.toContain("verified copy");
      expect(r.stderr).toMatch(/row-count mismatch: notes_fts: live=300 copy=299/);

      const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
        db: string;
        verification?: string;
        integrityOk: boolean;
      }>;
      const cacheReport = report.find((x) => x.db === "cache.db");
      expect(cacheReport?.verification).toBe("failed");
      expect(cacheReport?.integrityOk).toBe(false);
    },
    TEST_BUDGET_MS,
  );

  // Post-wave ruling — "not comparable" is ONLY the unavailable-module class. Any other COUNT(*)
  // failure (a busy live table, a missing one) is a real mismatch: an unchecked table must never
  // reach an install recommendation. `count-error:<table>` drops it from the copy, so the count
  // throws "no such table" — the same non-module class a SQLITE_BUSY count would land in.
  it(
    "a non-module count error is 'failed', not 'partial'",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-counterr-"));
      dirs.push(destDir);
      const jsonPath = join(cacheDir, "report.json");
      const r = runCli(["compact", "--config", configPath, "--into", destDir, "--json", jsonPath], {
        OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE: "count-error:idempotency_keys",
      });

      expect(r.code).toBe(1);
      expect(r.stdout).toContain("FAILED verification");
      expect(r.stdout).not.toContain("to install it:");
      expect(r.stdout).not.toContain("verified copy");
      expect(r.stderr).toMatch(
        /count failed on copy: no such table: (main\.)?idempotency_keys|no such table: idempotency_keys/,
      );

      const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
        db: string;
        verification?: string;
        notComparable?: unknown[];
      }>;
      const cacheReport = report.find((x) => x.db === "cache.db");
      expect(cacheReport?.verification).toBe("failed");
      expect(cacheReport?.notComparable).toBeUndefined();
    },
    TEST_BUDGET_MS,
  );

  // M6 (final review) — `PRAGMA wal_checkpoint(TRUNCATE)` RETURNS `(busy, log, checkpointed)`; it
  // does not throw. A reader holding a read transaction blocks the truncation (measured: busy=1
  // while the VACUUM itself still succeeds), so `-wal` survives and `afterBytes` counts it. That was
  // invisible. Reported now — and deliberately NOT a verification failure or an exit-code change,
  // since nothing is wrong with the database; less was reclaimed than the numbers imply.
  it(
    "M6: a checkpoint blocked by another connection's read is reported, exit code unchanged",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const dbPath = join(cacheDir, "cache.db");
      const reader = await openDatabase(dbPath);
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) AS n FROM notes_fts").get(); // a real read snapshot, held open
      try {
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(["compact", "--config", configPath, "--json", jsonPath]);

        expect(r.code, `compact exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/WAL checkpoint was blocked by another connection/);
        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          checkpointBlocked?: string;
          integrityOk: boolean;
        }>;
        const cacheReport = report.find((x) => x.db === "cache.db");
        expect(cacheReport?.checkpointBlocked).toMatch(/after-size includes the -wal/);
        expect(cacheReport?.integrityOk).toBe(true);
      } finally {
        reader.exec("ROLLBACK");
        reader.close?.();
      }
    },
    TEST_BUDGET_MS,
  );

  // J1 (pre-merge, P1) — `--json <path>` wrote wherever it was pointed, with no check that the path
  // aliases a database: `--json <cacheDir>/cache.db` TRUNCATED the database it had just inspected,
  // and `--json <into>/cache.db` replaced the verified copy with JSON after printing the mv for it.
  // Refused before anything is opened, so a mistyped path changes nothing.
  describe("J1 — --json may not alias a database this command manages", () => {
    it(
      "--dry-run --json <cacheDir>/cache.db refuses, and the database is untouched",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const dbPath = join(cacheDir, "cache.db");
        const hashBefore = sha256(dbPath);

        const r = runCli(["compact", "--config", configPath, "--dry-run", "--json", dbPath]);

        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/--json .*would overwrite/);
        expect(r.stderr).not.toContain("fatal:");
        expect(sha256(dbPath)).toBe(hashBefore);
      },
      TEST_BUDGET_MS,
    );

    it(
      "--into <dir> --json <dir>/cache.db refuses before the copy is made",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const dbPath = join(cacheDir, "cache.db");
        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-json-alias-"));
        dirs.push(destDir);
        const hashBefore = sha256(dbPath);

        const r = runCli([
          "compact",
          "--config",
          configPath,
          "--into",
          destDir,
          "--json",
          join(destDir, "cache.db"),
        ]);

        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/--json .*would overwrite/);
        expect(sha256(dbPath)).toBe(hashBefore);
        // Refused BEFORE the copy: no half-made destination left behind either.
        expect(existsSync(join(destDir, "cache.db"))).toBe(false);
      },
      TEST_BUDGET_MS,
    );

    it(
      "a -wal sidecar of a managed database is refused too",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const r = runCli([
          "compact",
          "--config",
          configPath,
          "--dry-run",
          "--json",
          join(cacheDir, "cache.db-wal"),
        ]);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/--json .*would overwrite/);
      },
      TEST_BUDGET_MS,
    );
  });

  // J2 (pre-merge, P2) — only the BUSY branch carried the partial `ftsOptimized` out; any other
  // failure after `'optimize'` committed its merge rethrew bare, so the report read
  // `ftsOptimized: []` while `notes_fts_data` had demonstrably shrunk (Codex measured 17 -> 3 rows
  // with an empty list and exit 1). The in-place hook forces a non-busy failure at that point.
  it(
    "J2: a non-busy failure after the merge still reports the tables it optimized",
    async () => {
      const { cacheDir, configPath } = setupConfig();
      await seedInflatedCacheDb(cacheDir);
      const dbPath = join(cacheDir, "cache.db");
      const countDataRows = async (): Promise<number> => {
        const db = await openDatabase(dbPath, 5000, { readonly: true });
        try {
          return (db.prepare("SELECT COUNT(*) AS n FROM notes_fts_data").get() as { n: number }).n;
        } finally {
          db.close?.();
        }
      };
      const before = await countDataRows();

      const jsonPath = join(cacheDir, "report.json");
      const r = runCli(["compact", "--config", configPath, "--json", jsonPath], {
        OBSIDIAN_TC_FORCE_COMPACT_POST_OPTIMIZE_THROW: "1",
      });

      expect(r.code).toBe(1);
      // The merge really did commit — this is the write the empty list was hiding.
      expect(await countDataRows()).toBeLessThan(before);

      const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
        db: string;
        error?: string;
        ftsOptimized: string[];
      }>;
      const cacheReport = report.find((x) => x.db === "cache.db");
      expect(cacheReport?.error).toMatch(/OBSIDIAN_TC_FORCE_COMPACT_POST_OPTIMIZE_THROW/);
      expect(cacheReport?.ftsOptimized).toEqual(["notes_fts"]);
    },
    TEST_BUDGET_MS,
  );

  // THE-1039 breaker ruling (#2) — the CLI-level proof that a native readonly failure reaches the
  // fallback and the command still works. `OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW=1` throws at the
  // probe step inside the adapter, where macOS's deferred "unable to open database file" lands, so
  // this runs the real attempt -> refusal check -> writable-open path on Linux. Rounds 4 and 5 had
  // no test that could do this: FORCE_FALLBACK skips the native attempt instead of failing it.
  describe("a native readonly failure reaches the fallback and the command still succeeds", () => {
    it(
      "--dry-run: exit 0, readonlyMode fallback, and the notice",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(["compact", "--config", configPath, "--dry-run", "--json", jsonPath], {
          OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW: "1",
        });

        expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/inspection connection was not read-only on this platform/);
        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          readonlyMode?: string;
        }>;
        expect(report.find((x) => x.db === "cache.db")?.readonlyMode).toBe("fallback");
      },
      TEST_BUDGET_MS,
    );

    it(
      "--into: exit 0, a verified copy, and readonlyMode fallback on the source read",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-throw-into-"));
        dirs.push(destDir);
        const jsonPath = join(cacheDir, "report.json");
        const r = runCli(
          ["compact", "--config", configPath, "--into", destDir, "--json", jsonPath],
          {
            OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW: "1",
          },
        );

        expect(r.code, `compact --into exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        expect(existsSync(join(destDir, "cache.db"))).toBe(true);
        expect(r.stdout).toMatch(/verified copy at/);
        expect(r.stdout).toMatch(/inspection connection was not read-only on this platform/);
        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          readonlyMode?: string;
        }>;
        expect(report.find((x) => x.db === "cache.db")?.readonlyMode).toBe("fallback");
      },
      TEST_BUDGET_MS,
    );

    it(
      "doctor: the db.reclaimable-space row reports the fallback",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        await seedInflatedCacheDb(cacheDir);
        const r = runCli(["doctor", "--config", configPath], {
          OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW: "1",
        });

        // I1: the one-line row carries the WORD; the consequence sentence moved into details.
        expect(r.stdout + r.stderr).toMatch(/db\.reclaimable-space/);
        expect(r.stdout + r.stderr).toMatch(/readonlyMode=fallback/);
      },
      TEST_BUDGET_MS,
    );
  });

  // THE-1039 fix round 4 (H4) — round 3's dangling-WAL byte-for-byte assertion covered doctor's
  // `probeDbSpace` only. `compact --dry-run` and `--into`'s SOURCE read are the other two
  // inspection call sites with the same contract, exercised here against the same fixture helper
  // (`dangling-wal-fixture.ts`) rather than a second hand-built copy of it.
  //
  // The byte assertions are conditional on the run's own reported `readonlyMode` (H2): bytes are
  // only guaranteed unchanged on the NATIVE readonly path. On a build whose native readonly open
  // throws (C1's macOS/WAL case) the command correctly falls back, and the fallback's one
  // documented residual — SQLite's checkpoint-on-close — can legitimately change those bytes. The
  // test then asserts the fallback was REPORTED instead, so neither outcome passes silently.
  describe("H4 — a dangling WAL survives an inspection byte-for-byte on the native readonly path", () => {
    const walSize = (dbPath: string): number =>
      existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;

    it(
      "--dry-run leaves the main file and -wal untouched",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        const dbPath = await createDanglingWalDb(cacheDir);
        const hashBefore = sha256(dbPath);
        const walBefore = walSize(dbPath);
        const jsonPath = join(cacheDir, "report.json");

        const r = runCli(["compact", "--config", configPath, "--dry-run", "--json", jsonPath]);
        expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);

        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          readonlyMode?: string;
        }>;
        const mode = report.find((x) => x.db === "cache.db")?.readonlyMode;
        if (mode === "native") {
          expect(sha256(dbPath)).toBe(hashBefore);
          expect(walSize(dbPath)).toBe(walBefore);
        } else {
          expect(r.stdout).toMatch(/was not read-only on this platform/);
        }
      },
      TEST_BUDGET_MS,
    );

    it(
      "--into reads the source without touching the main file or -wal",
      async () => {
        const { cacheDir, configPath } = setupConfig();
        const dbPath = await createDanglingWalDb(cacheDir);
        const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-dangling-into-"));
        dirs.push(destDir);
        const hashBefore = sha256(dbPath);
        const walBefore = walSize(dbPath);
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
        expect(r.code, `compact --into exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
        // The copy carries the WAL's un-checkpointed rows — a snapshot of the live state, not of the
        // main file alone.
        expect(existsSync(join(destDir, "cache.db"))).toBe(true);

        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
          db: string;
          readonlyMode?: string;
        }>;
        const mode = report.find((x) => x.db === "cache.db")?.readonlyMode;
        if (mode === "native") {
          expect(sha256(dbPath)).toBe(hashBefore);
          expect(walSize(dbPath)).toBe(walBefore);
        } else {
          expect(r.stdout).toMatch(/was not read-only on this platform/);
        }
      },
      TEST_BUDGET_MS,
    );
  });
});
