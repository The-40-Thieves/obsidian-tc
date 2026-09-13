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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDbSpace } from "../src/cli/commands/doctor-probes";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { openDatabase } from "../src/db/open";
import { readonlyOpenFallbackable } from "../src/db/pragmas";
import { provisionCacheDb } from "../src/db/provision";
import { type DbSpaceView, dbSpaceCheck } from "../src/doctor/db-space";
import { ensureNotesFts } from "../src/search/fts";
import { createDanglingWalDb } from "./dangling-wal-fixture";

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

  // THE-1039 fix round 3 (C2) — round 2's fix above (a writable file descriptor that merely
  // avoids write pragmas) was ITSELF found unsafe: closing that connection can trigger SQLite's
  // OWN checkpoint-on-close against a DANGLING, un-checkpointed WAL (left by a writer that
  // crashed or was killed before it could checkpoint) — a physical mutation of the main file and
  // deletion of `-wal`, regardless of which pragmas this code chooses to issue. Fixed by trying
  // the native `SQLITE_OPEN_READONLY` open FIRST (a readonly connection cannot take the exclusive
  // lock a checkpoint needs, so it cannot trigger one) and falling back to round 2's approach only
  // if that throws.
  //
  // The fixture (fix round 4 / H4: extracted to `dangling-wal-fixture.ts`, so compact's own
  // inspection paths assert against the same one) spawns a real child process that opens the
  // database, disables auto-checkpointing, writes, and is then SIGKILLed before it can close (and
  // thus before it can checkpoint) — the WAL is left genuinely dangling, not merely "not yet
  // auto-checkpointed by this same process's next write" the way an in-process test could only
  // approximate.
  it("a dangling WAL (writer killed before it could checkpoint) is left byte-for-byte unchanged by a successful readonly probe", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-dangling-wal-"));
    try {
      const dbPath = await createDanglingWalDb(cacheDir);
      const hashBefore = sha256(dbPath);
      const walHashBefore = sha256(`${dbPath}-wal`);

      const view = await probeDbSpace(cacheDir, 5000);
      expect(view.status).toBe("ok");

      expect(sha256(dbPath)).toBe(hashBefore);
      expect(sha256(`${dbPath}-wal`)).toBe(walHashBefore);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 15_000);

  // C2 — the FALLBACK branch (native readonly open throwing) cannot give the same bytes-unchanged
  // guarantee: forced here via `OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK` (pragmas.ts's
  // `forceReadonlyOpenFallback`, the same test-only-escape-hatch shape as
  // `OBSIDIAN_TC_FORCE_JS_FALLBACK` elsewhere in this repo) rather than by trying to reproduce
  // C1's macOS-only native-open failure on this (Linux) sandbox. What the fallback DOES still
  // guarantee — no write-capable pragma, so `journal_mode` and every logical row are unchanged —
  // is asserted; byte-for-byte identity is deliberately NOT asserted here, since the fallback's
  // one documented residual side effect (SQLite's own checkpoint-on-close against a dangling WAL)
  // can change bytes even though this code issued no write.
  it("the forced fallback path preserves journal_mode and every row, but does not promise unchanged bytes", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-forced-fallback-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      const db = await openDatabase(dbPath); // openDatabase's own pragmas set journal_mode = WAL
      provisionCacheDb(db, { version: "test" });
      db.prepare(
        "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("v1", "k1", "t", "h", 1, 2, "{}", 2, 9_999_999_999_999);
      db.close?.();

      const priorEnv = process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK;
      process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK = "1";
      let reader: Awaited<ReturnType<typeof openDatabase>> | undefined;
      try {
        reader = await openDatabase(dbPath, 5000, { readonly: true });
        expect(reader.readonlyMode).toBe("fallback");
        expect(
          (reader.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
        ).toBe("wal");
        expect(
          (reader.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get() as { n: number }).n,
        ).toBe(1);
        reader.close?.();
        reader = undefined;

        // The probe itself (doctor's own call site) still succeeds while forced onto this path.
        const view = await probeDbSpace(cacheDir, 5000);
        expect(view.status).toBe("ok");
      } finally {
        reader?.close?.();
        if (priorEnv === undefined) delete process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK;
        else process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK = priorEnv;
      }
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // THE-1039 fix round 4 (H2) — `readonlyMode` reached no output surface, so a real fallback was
  // invisible to an operator reading the doctor row. The row now names it, with the consequence
  // (SQLite's own checkpoint-on-close against a dangling WAL) spelled out rather than implied.
  it("H2: the doctor row says so when the inspection connection fell back", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-row-fallback-"));
    const priorEnv = process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK;
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      db.close?.();

      process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK = "1";
      const view = await probeDbSpace(cacheDir, 5000);
      expect(view.status).toBe("ok");
      if (view.status !== "ok") throw new Error("unreachable");
      expect(view.state.readonlyMode).toBe("fallback");

      const check = await dbSpaceCheck(view).run(ctx);
      expect(check.summary).toContain("inspection connection was not read-only on this platform");
      expect(check.summary).toContain("may be checkpointed on close");
      expect(check.details?.readonlyMode).toBe("fallback");
    } finally {
      if (priorEnv === undefined) delete process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK;
      else process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK = priorEnv;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("H2: an ordinary (native) probe says nothing about the open mode", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-row-native-"));
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      db.close?.();

      const view = await probeDbSpace(cacheDir, 5000);
      if (view.status !== "ok") throw new Error("unreachable");
      expect(view.state.readonlyMode).toBe("native");
      const check = await dbSpaceCheck(view).run(ctx);
      expect(check.summary).not.toContain("was not read-only");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// THE-1039 fix round 4 (H1) — round 3's readonly-first open fell back on ANY native-open failure,
// so a missing file, a permissions error, or SQLite refusing the readonly open because hot-journal
// recovery is pending all silently took the writable path. node:sqlite's fallback (a plain open)
// CREATES a missing file, and the hot-journal case makes the writable open PERFORM that recovery —
// a mutation class none of the round-3 comments claimed to cover. The fallback is now narrowed to
// the one failure class it was introduced for.
describe("readonly open fallback narrowing (H1)", () => {
  it("a missing file errors and is NOT created by a fallback open", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-missing-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      await expect(openDatabase(dbPath, 5000, { readonly: true })).rejects.toThrow();
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // The node:sqlite adapter is the one where the unnarrowed fallback was a FILE-CREATING bug, not
  // merely a wrong open mode: it has no "writable but must exist" option, so its fallback is a
  // plain open, which creates the database. Exercised directly because `openDatabase` prefers
  // better-sqlite3 wherever it resolves (its own `fileMustExist: true` fallback refuses to create),
  // so the defect is invisible through the shared entry point on a dev machine or CI runner.
  it("openNodeSqlite: a missing file is never created by the fallback open", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-missing-ns-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      await expect(openNodeSqlite(dbPath, 5000, { readonly: true })).rejects.toThrow();
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // chmod has no POSIX owner/group/other meaning on win32 — see the permission-state block above.
  it.skipIf(process.platform === "win32")(
    "an unreadable file errors rather than being retried writable",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-denied-"));
      const dbPath = join(cacheDir, "cache.db");
      try {
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        db.close?.();
        chmodSync(dbPath, 0o000);

        expect(readonlyOpenFallbackable(dbPath, new Error("unable to open database file"))).toBe(
          false,
        );
        await expect(openDatabase(dbPath, 5000, { readonly: true })).rejects.toThrow();
      } finally {
        chmodSync(dbPath, 0o644);
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
  );

  it("classifies only the CANTOPEN class on a readable, writable file", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-classify-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      const db = await openDatabase(dbPath);
      provisionCacheDb(db, { version: "test" });
      db.close?.();

      expect(readonlyOpenFallbackable(dbPath, new Error("unable to open database file"))).toBe(
        true,
      );
      const coded = Object.assign(new Error("some binding wording"), { code: "SQLITE_CANTOPEN" });
      expect(readonlyOpenFallbackable(dbPath, coded)).toBe(true);
      // The hot-journal-recovery refusal: a readonly connection cannot roll back a hot journal, and
      // falling back to a writable open would PERFORM that rollback. Never fallbackable.
      expect(
        readonlyOpenFallbackable(dbPath, new Error("attempt to write a readonly database")),
      ).toBe(false);
      expect(readonlyOpenFallbackable(join(cacheDir, "nope.db"), new Error("unable to open"))).toBe(
        false,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
