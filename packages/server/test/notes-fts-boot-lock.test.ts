// GH #1209 pattern 2: several stdio servers cold-booting on ONE cacheDir stepped ~3 s apart. The
// serializer was ensureNotesFts's divergence repair, not the migration lock: on a CONSISTENT index
// it still ran a DELETE and an UPDATE (each takes SQLite's write lock even when it changes no row),
// and the UPDATE's correlated NOT EXISTS over the FTS5 table was a full FTS scan per note (O(n^2)).
// The first process held the lock for the whole scan; every sibling waited out busy_timeout, then
// ensureNotesFts swallowed the SQLITE_BUSY and returned false (FTS silently off for that process).
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ensureNotesFts, upsertNoteRow } from "../src/search/fts";
import { makeTempDir, rmTemp } from "./tmp";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

const rec = (p: string) => ({
  path: p,
  title: p,
  tagsJson: "[]",
  frontmatterJson: "{}",
  contentHash: "hash-1",
  mtime: 1,
  size: 1,
  ftsContent: `body text of ${p}`,
  fenceGeneration: 0,
  fenceCheckRequired: false,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** A cache.db on disk holding `n` notes whose notes_fts rows are all present (a warm index). */
async function seedConsistentCache(n: number): Promise<string> {
  const dir = makeTempDir("otc-fts-boot-");
  dirs.push(dir);
  const path = join(dir, "cache.db");
  const db = await openDatabase(path);
  provisionCacheDb(db);
  // The first boot's provisioning (creates notes_fts, records its pseudo-migration row). Done while
  // the tables are empty so seeding stays cheap; every later connection is a warm boot.
  expect(ensureNotesFts(db)).toBe(true);
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) upsertNoteRow(db, "main", rec(`n${i}.md`), true, 1);
  db.exec("COMMIT");
  db.close?.();
  return path;
}

describe("ensureNotesFts on a consistent index (GH #1209)", () => {
  it("returns true and never needs the write lock while another process holds it", async () => {
    const path = await seedConsistentCache(20);
    const holder = await openDatabase(path);
    holder.exec("BEGIN IMMEDIATE"); // a sibling mid-boot, holding SQLite's single write lock
    try {
      const db = await openDatabase(path, 200); // busy_timeout 200 ms: a write attempt fails fast
      // RED on main: the repair's DELETE/UPDATE need the lock, throw SQLITE_BUSY, and the swallowed
      // error makes ensureNotesFts report FTS unavailable for this whole process.
      expect(ensureNotesFts(db)).toBe(true);
      db.close?.();
    } finally {
      holder.exec("ROLLBACK");
      holder.close?.();
    }
  });

  it("still repairs a diverged index (the write path is only skipped when nothing diverges)", async () => {
    const path = await seedConsistentCache(5);
    const db = await openDatabase(path);
    db.prepare(
      "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('main', 'ghost.md', 't', 'c')",
    ).run();
    db.prepare("DELETE FROM notes_fts WHERE path = 'n0.md'").run();
    expect(ensureNotesFts(db)).toBe(true);
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) AS n FROM notes_fts WHERE path = 'ghost.md'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM notes WHERE content_hash = ''")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM notes")).toBe(5);
    db.close?.();
  });

  it("differential: resets and prunes exactly the rows the pre-change statements did", async () => {
    // Same divergence in two copies: every 3rd note loses its FTS row, three FTS rows have no note.
    const diverge = async (): Promise<ReturnType<typeof openDatabase>> => {
      const db = await openDatabase(await seedConsistentCache(60));
      for (let i = 0; i < 60; i += 3)
        db.prepare("DELETE FROM notes_fts WHERE path = ?").run(`n${i}.md`);
      for (const g of ["g1.md", "g2.md", "g3.md"]) {
        db.prepare(
          "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('main', ?, 't', 'c')",
        ).run(g);
      }
      return db;
    };
    const oldWay = await diverge();
    oldWay.exec(
      "DELETE FROM notes_fts WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = notes_fts.vault_id AND n.path = notes_fts.path)",
    );
    oldWay.exec(
      "UPDATE notes SET content_hash = '' WHERE NOT EXISTS (SELECT 1 FROM notes_fts f WHERE f.vault_id = notes.vault_id AND f.path = notes.path)",
    );
    const newWay = await diverge();
    expect(ensureNotesFts(newWay)).toBe(true);
    const paths = (db: Awaited<ReturnType<typeof diverge>>, sql: string): string[] =>
      (db.prepare(sql).all() as { path: string }[]).map((r) => r.path).sort();
    const stale = "SELECT path FROM notes WHERE content_hash = ''";
    const fts = "SELECT path FROM notes_fts";
    expect(paths(newWay, stale)).toHaveLength(20); // existence floor: the reset really happened
    expect(paths(newWay, stale)).toEqual(paths(oldWay, stale));
    expect(paths(newWay, fts)).toEqual(paths(oldWay, fts));
    oldWay.close?.();
    newWay.close?.();
  });

  it("scales with the corpus, not its square (loose bound: 10000 notes well under 5 s)", async () => {
    const path = await seedConsistentCache(10_000);
    const db = await openDatabase(path);
    const t0 = performance.now();
    expect(ensureNotesFts(db)).toBe(true);
    // RED on main: 10000 full FTS scans, tens of seconds. The bound is two orders above the fix.
    expect(performance.now() - t0).toBeLessThan(5_000);
    db.close?.();
  }, 120_000);

  it.skipIf(!bunAvailable)(
    "4 processes opening one warm cacheDir together all get FTS (GH #1209 cold-boot serialization)",
    async () => {
      const path = await seedConsistentCache(6000);
      const script = `
        import { openDatabase } from ${JSON.stringify(join(SRC, "db/open.ts"))};
        import { ensureNotesFts } from ${JSON.stringify(join(SRC, "search/fts.ts"))};
        const t0 = performance.now();
        const db = await openDatabase(process.argv[1], 1000);
        const hasFts = ensureNotesFts(db);
        console.log(JSON.stringify({ hasFts, ms: Math.round(performance.now() - t0) }));
      `;
      const run = (): Promise<{ hasFts: boolean; ms: number }> =>
        new Promise((resolve, reject) => {
          const child = spawn("bun", ["-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stdout.on("data", (d: Buffer) => {
            out += d.toString("utf8");
          });
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(`child exit ${code}`)),
          );
        });
      const results = await Promise.all([run(), run(), run(), run()]);
      expect(results).toHaveLength(4); // existence floor: all four reported
      // RED on main: the first holder keeps the lock for the whole O(n^2) scan, the other three
      // wait out the 1 s busy_timeout and come back with hasFts=false.
      expect(results.map((r) => r.hasFts)).toEqual([true, true, true, true]);
      // Loose spread bound only; the assertion above is the deterministic one.
      expect(Math.max(...results.map((r) => r.ms))).toBeLessThan(20_000);
    },
    180_000,
  );
});
