// db.reclaimable-space (THE-1039, GH #930) — mirrors doctor-capture-location.test.ts's shape for
// the check factory (no --probe axis: this check has none, see db-space.ts's header for why), plus
// a real-file probe test for `probeDbSpace` itself — the DB-touching half nothing else here covers
// the way `doctor-capture-location.test.ts` / `doctor-note-summary-scale.test.ts` only ever
// exercise the pure check factories against a hand-built view.
//
// THE-1039 fix round 1 (F2 + A3): `probeDbSpace` now opens `readonly: true` (must not flip a
// DELETE-mode database into WAL as a side effect of inspecting it) and reports a three-way
// `DbSpaceView` — "missing" / "unopenable" / "ok" — rather than collapsing every failure into the
// same `undefined` a fresh install also produces (a Greptile-flagged + T-Rex-verified finding: a
// read-only cache.db was misreported as "no cache.db yet").
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDbSpace } from "../src/cli/commands/doctor-probes";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { type DbSpaceView, dbSpaceCheck } from "../src/doctor/db-space";
import { ensureNotesFts } from "../src/search/fts";

const ctx = { serverVersion: "test" };
const run = (view: DbSpaceView) => dbSpaceCheck(view).run(ctx);

describe("db.reclaimable-space — check factory", () => {
  it("is ok and says 'no store yet' when missing — a fresh install", async () => {
    const r = await run({ status: "missing" });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("no cache.db yet");
  });

  it("WARNS (never fails) and names the reason when the store exists but could not be opened", async () => {
    const r = await run({ status: "unopenable", reason: "EACCES: permission denied" });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("EACCES: permission denied");
    expect(r.remediation).toBeTruthy();
  });

  it("is ok when freelist bytes sit at or under the 10% floor", async () => {
    const r = await run({
      status: "ok",
      state: { fileBytes: 1_000_000, freelistBytes: 100_000, ftsData: [] },
    });
    expect(r.status).toBe("ok");
    expect(r.details?.freelistBytes).toBe("100000");
  });

  it("WARNS with the compact remedy when freelist bytes exceed the 10% floor", async () => {
    const r = await run({
      status: "ok",
      state: { fileBytes: 1_000_000, freelistBytes: 150_000, ftsData: [] },
    });
    expect(r.status).toBe("warning");
    expect(r.remediation).toBe("obsidian-tc compact");
    expect(r.summary).toContain("15.0%");
  });

  it("reports each present FTS table's row count in details", async () => {
    const r = await run({
      status: "ok",
      state: {
        fileBytes: 1_000_000,
        freelistBytes: 0,
        ftsData: [
          { table: "notes_fts", dataRows: 40_675 },
          { table: "chunk_fts", dataRows: 8_200 },
        ],
      },
    });
    expect(r.details?.ftsData).toEqual(["notes_fts_data=40675 rows", "chunk_fts_data=8200 rows"]);
  });

  it("never returns fail — reclaimable space breaks no request outright", async () => {
    const r = await run({
      status: "ok",
      state: { fileBytes: 1_000_000, freelistBytes: 999_999, ftsData: [] },
    });
    expect(r.status).not.toBe("fail");
  });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("probeDbSpace — a real cache.db", () => {
  it("reports 'missing' when cache.db does not exist yet", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-empty-"));
    try {
      expect(await probeDbSpace(cacheDir, 5000)).toEqual({ status: "missing" });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("reads file size, freelist bytes, and notes_fts's <t>_data row count off a real file", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-real-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      const db = await openDatabase(dbPath);
      provisionCacheDb(db, { version: "test" });
      expect(ensureNotesFts(db)).toBe(true);
      const ins = db.prepare(
        "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('v1', ?, ?, ?)",
      );
      for (let i = 0; i < 10; i++) ins.run(`note-${i}.md`, `Note ${i}`, `content ${i}`);
      db.close?.();

      const view = await probeDbSpace(cacheDir, 5000);
      expect(view.status).toBe("ok");
      if (view.status !== "ok") throw new Error("unreachable");
      expect(view.state.fileBytes).toBeGreaterThan(0);
      expect(view.state.freelistBytes).toBeGreaterThanOrEqual(0);
      const notesFts = view.state.ftsData.find((f) => f.table === "notes_fts");
      expect(notesFts?.dataRows).toBeGreaterThan(0);
      // chunk_fts was never provisioned in this fixture (no `chunks` table) — absent, not zero.
      expect(view.state.ftsData.some((f) => f.table === "chunk_fts")).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // A3, combined with F2: file permission bits have TWO distinct effects once the opener is
  // `readonly: true`, and both are worth asserting so a future change to either fix cannot
  // silently swap them.
  //
  // chmod 0444 (world-readable, nobody-writable) — before F2, the WRITER opener this probe used
  // needed write access and failed, collapsing into the same `undefined` as "file does not exist"
  // (the original Greptile/T-Rex finding). AFTER F2, `readonly: true` needs only READ access, so
  // this now succeeds and reports real numbers — asserted here so this fix is not silently
  // reverted by a future change back to a writable opener.
  //
  // chmod 0000 (no permission bits at all) — genuinely unreadable regardless of opener, so this is
  // the case that still exercises the "unopenable" branch post-F2.
  //
  // Both are skipped on win32: chmod has no POSIX owner/group/other meaning there, so neither
  // reproduces the intended permission state — asserting a platform-dependent guess about what
  // chmod does on Windows would be worse than not testing it at all.
  describe.skipIf(process.platform === "win32")("file permission states", () => {
    it("chmod 0444 (readable, not writable) is 'ok' now that the opener is readonly", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-ro444-"));
      try {
        const dbPath = join(cacheDir, "cache.db");
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        db.close?.();
        chmodSync(dbPath, 0o444);

        const view = await probeDbSpace(cacheDir, 5000);
        expect(view.status).toBe("ok");
      } finally {
        chmodSync(join(cacheDir, "cache.db"), 0o644);
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it("chmod 0000 (unreadable) reports 'unopenable' with a reason, distinct from 'missing'", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-ro000-"));
      try {
        const dbPath = join(cacheDir, "cache.db");
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        db.close?.();
        chmodSync(dbPath, 0o000);

        const view = await probeDbSpace(cacheDir, 5000);
        expect(view.status).toBe("unopenable");
        if (view.status === "unopenable") expect(view.reason.length).toBeGreaterThan(0);

        const check = await dbSpaceCheck(view).run(ctx);
        expect(check.status).toBe("warning");
        expect(check.status).not.toBe("ok");
      } finally {
        chmodSync(join(cacheDir, "cache.db"), 0o644);
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  });

  // F2: the opener must be readonly, so an inspection of a still-DELETE-mode database changes
  // neither its bytes nor its journal mode.
  it("never mutates a DELETE-mode database's bytes or journal mode", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-delete-mode-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      // Built via BARE node:sqlite (not this repo's openDatabase, which always sets WAL) so the
      // fixture genuinely starts in SQLite's default DELETE journal mode.
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(dbPath);
      raw.exec("CREATE TABLE t(x)");
      raw.close();

      const journalMode = (): string => {
        const reader = new DatabaseSync(dbPath);
        try {
          return (reader.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
            .journal_mode;
        } finally {
          reader.close();
        }
      };

      const hashBefore = sha256(dbPath);
      expect(journalMode()).toBe("delete");

      await probeDbSpace(cacheDir, 5000);

      expect(sha256(dbPath)).toBe(hashBefore);
      expect(journalMode()).toBe("delete");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // THE-1039 fix round 2 (C1) — the DELETE-mode test above never reproduced the macOS CI failure
  // (a bare node:sqlite fixture with no WAL has no `-shm` complexity at all). Every REAL cache.db
  // is WAL-mode (every writer here applies `journal_mode = WAL` — db/pragmas.ts's
  // `connectionPragmas`), so this fixture is built via this repo's own `openDatabase` (not bare
  // node:sqlite) specifically to be WAL-mode, matching what `probeDbSpace` actually reads in
  // production. `build-test (macos-latest)` failed opening a WAL fixture like this one with
  // `{ readonly: true }` ("unable to open database file") while Linux/Windows passed unchanged —
  // fixed by opening a normal read-write file descriptor and never issuing a write statement (see
  // bun-sqlite.ts's comment for the full incident); this test pins that fix.
  it("reads a WAL-mode fixture successfully and still mutates neither its bytes nor journal mode", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-wal-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      const db = await openDatabase(dbPath); // openDatabase's own pragmas set journal_mode = WAL
      provisionCacheDb(db, { version: "test" });
      db.prepare(
        "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("v1", "k1", "t", "h", 1, 2, "{}", 2, 9_999_999_999_999);
      db.close?.();

      const { DatabaseSync } = await import("node:sqlite");
      const journalMode = (): string => {
        const reader = new DatabaseSync(dbPath);
        try {
          return (reader.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
            .journal_mode;
        } finally {
          reader.close();
        }
      };
      const hashBefore = sha256(dbPath);
      expect(journalMode()).toBe("wal");

      const view = await probeDbSpace(cacheDir, 5000);
      expect(view.status).toBe("ok");

      expect(sha256(dbPath)).toBe(hashBefore);
      expect(journalMode()).toBe("wal");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
