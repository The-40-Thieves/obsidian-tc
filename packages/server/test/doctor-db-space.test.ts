// db.reclaimable-space (THE-1039, GH #930) — mirrors doctor-capture-location.test.ts's shape for
// the check factory (no --probe axis: this check has none, see db-space.ts's header for why), plus
// a real-file probe test for `probeDbSpace` itself — the DB-touching half nothing else here covers
// the way `doctor-capture-location.test.ts` / `doctor-note-summary-scale.test.ts` only ever
// exercise the pure check factories against a hand-built view.
import { mkdtempSync, rmSync } from "node:fs";
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
  it("is ok and says 'no store yet' with no state — a fresh install", async () => {
    const r = await run({});
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("no cache.db yet");
  });

  it("is ok when freelist bytes sit at or under the 10% floor", async () => {
    const r = await run({
      state: { fileBytes: 1_000_000, freelistBytes: 100_000, ftsData: [] },
    });
    expect(r.status).toBe("ok");
    expect(r.details?.freelistBytes).toBe("100000");
  });

  it("WARNS with the compact remedy when freelist bytes exceed the 10% floor", async () => {
    const r = await run({
      state: { fileBytes: 1_000_000, freelistBytes: 150_000, ftsData: [] },
    });
    expect(r.status).toBe("warning");
    expect(r.remediation).toBe("obsidian-tc compact");
    expect(r.summary).toContain("15.0%");
  });

  it("reports each present FTS table's row count in details", async () => {
    const r = await run({
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
      state: { fileBytes: 1_000_000, freelistBytes: 999_999, ftsData: [] },
    });
    expect(r.status).not.toBe("fail");
  });
});

describe("probeDbSpace — a real cache.db", () => {
  it("returns undefined when cache.db does not exist yet", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-dbspace-empty-"));
    try {
      expect(await probeDbSpace(cacheDir, 5000)).toBeUndefined();
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

      const state = await probeDbSpace(cacheDir, 5000);
      expect(state).toBeDefined();
      expect(state?.fileBytes).toBeGreaterThan(0);
      expect(state?.freelistBytes).toBeGreaterThanOrEqual(0);
      const notesFts = state?.ftsData.find((f) => f.table === "notes_fts");
      expect(notesFts?.dataRows).toBeGreaterThan(0);
      // chunk_fts was never provisioned in this fixture (no `chunks` table) — absent, not zero.
      expect(state?.ftsData.some((f) => f.table === "chunk_fts")).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
