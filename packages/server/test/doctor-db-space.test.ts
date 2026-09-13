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
import { readonlyFallbackRefusal, readonlyOpenFallbackable } from "../src/db/pragmas";
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

  // Fix round 5: asserts the open mode is REPORTED and that the notice tracks it, not that this
  // platform takes the native path. Which path an ordinary probe gets is a property of the SQLite
  // build (`build-test (macos-latest)`'s bun:sqlite fails the native readonly open where Linux's
  // succeeds), so pinning "native" here pins the platform, not this code. The fallback WORDING is
  // pinned deterministically by the forced-fallback test above.
  it("H2: an ordinary probe reports its open mode, and the notice tracks it", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-row-native-"));
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      db.close?.();

      const view = await probeDbSpace(cacheDir, 5000);
      if (view.status !== "ok") throw new Error("unreachable");
      expect(["native", "fallback"]).toContain(view.state.readonlyMode);
      const check = await dbSpaceCheck(view).run(ctx);
      expect(check.summary.includes("was not read-only")).toBe(
        view.state.readonlyMode === "fallback",
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// THE-1039 breaker ruling — the fallback condition is THE PATH, and nothing about the error.
//
// Round 3 fell back on ANY native-open failure, which let node:sqlite's plain-open fallback CREATE a
// missing database. Rounds 4 and 5 fixed that by also matching the error's shape (code/errno/text),
// and both broke `build-test (macos-latest)`, because the real macOS error is not observable from
// this sandbox. The condition is now round 3's — readonly threw, so try writable — plus the one
// guard it was missing: the target must be an existing regular file.
describe("readonly open fallback condition (breaker ruling)", () => {
  const withDb = async (
    fn: (dbPath: string, dir: string) => void | Promise<void>,
  ): Promise<void> => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-cond-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      const db = await openDatabase(dbPath);
      provisionCacheDb(db, { version: "test" });
      db.close?.();
      await fn(dbPath, cacheDir);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  };

  it("an existing regular file is fallbackable, whatever the error was", async () => {
    await withDb((dbPath) => {
      expect(readonlyOpenFallbackable(dbPath)).toBe(true);
      expect(readonlyFallbackRefusal(dbPath)).toBeUndefined();
    });
  });

  it("a missing file is refused, and names why", async () => {
    await withDb((dbPath) => {
      const missing = `${dbPath}.nope`;
      expect(readonlyOpenFallbackable(missing)).toBe(false);
      expect(readonlyFallbackRefusal(missing)).toMatch(/ENOENT/);
    });
  });

  it("a directory is refused", async () => {
    await withDb((_dbPath, dir) => {
      expect(readonlyOpenFallbackable(dir)).toBe(false);
      expect(readonlyFallbackRefusal(dir)).toMatch(/not a regular file/);
    });
  });

  it("a missing file errors and is NOT created by a fallback open", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-missing-"));
    try {
      const dbPath = join(cacheDir, "cache.db");
      await expect(openDatabase(dbPath, 5000, { readonly: true })).rejects.toThrow(
        /fallback refused because/,
      );
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // The node:sqlite adapter is the one where an unguarded fallback was a FILE-CREATING bug, not
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

  // A permissions-denied file now FALLS THROUGH to the writable open, per the ruling, and that open
  // fails with SQLite's own error — louder than a refusal invented here. What must not happen is a
  // bare error with no indication of which of the two opens failed: that silence is exactly what
  // rounds 4 and 5 printed on macOS.
  it.skipIf(process.platform === "win32")(
    "an unreadable file reaches the fallback open and reports that it failed too",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-denied-"));
      const dbPath = join(cacheDir, "cache.db");
      try {
        const db = await openDatabase(dbPath);
        provisionCacheDb(db, { version: "test" });
        db.close?.();
        chmodSync(dbPath, 0o000);

        await expect(openDatabase(dbPath, 5000, { readonly: true })).rejects.toThrow(
          /fallback open also failed/,
        );
        await expect(openDatabase(dbPath, 5000, { readonly: true })).rejects.toThrow(/sidecars/);
      } finally {
        chmodSync(dbPath, 0o644);
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
  );
});

// THE-1039 breaker ruling (#2) — bun:sqlite's readonly constructor is LAZY: it succeeds and the
// failure surfaces on the first statement, so a wrapper guarding only construction hands back a
// handle that fails later, outside it. That is why rounds 4 and 5 printed a raw SQLite message with
// none of their own diagnostics. `OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW` makes the native attempt
// throw where macOS does (at the probe, after construction) so the real attempt -> refusal check ->
// writable-open path runs on a platform whose native open succeeds — the gap the existing
// FORCE_FALLBACK hook cannot reach, because it skips the native attempt entirely.
describe("OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW — the real fallback path, on any platform", () => {
  const withForcedThrow = async (mode: string, fn: () => Promise<void>): Promise<void> => {
    const prior = process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW;
    process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW = mode;
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW;
      else process.env.OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW = prior;
    }
  };

  for (const mode of ["1", "construct"]) {
    it(`a native readonly failure at the ${mode === "1" ? "probe" : "construction"} step falls back and reads`, async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "obtc-ro-throw-"));
      try {
        const db = await openDatabase(join(cacheDir, "cache.db"));
        provisionCacheDb(db, { version: "test" });
        db.close?.();

        await withForcedThrow(mode, async () => {
          const reader = await openDatabase(join(cacheDir, "cache.db"), 5000, { readonly: true });
          try {
            expect(reader.readonlyMode).toBe("fallback");
            // The fallback handle is configured AND probed, so it has proven it can read.
            expect(
              (reader.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
                .journal_mode,
            ).toBe("wal");
          } finally {
            reader.close?.();
          }

          const view = await probeDbSpace(cacheDir, 5000);
          expect(view.status).toBe("ok");
          if (view.status !== "ok") throw new Error("unreachable");
          expect(view.state.readonlyMode).toBe("fallback");
          const check = await dbSpaceCheck(view).run(ctx);
          expect(check.summary).toContain(
            "inspection connection was not read-only on this platform",
          );
        });
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  }
});
