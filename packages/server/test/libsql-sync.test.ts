// Multi-device index sync spike: libSQL embedded replicas against a REAL sqld. Needs the sqld
// binary (see sqld-harness.ts) and `bun` (the second "machine" runs under it); skipped without
// sqld, FAILS without it when OBSIDIAN_TC_REQUIRE_SQLD=1.
//
// What is pinned here is what the spike measured, so a libsql / sqld upgrade that changes any of it
// shows up as a red test rather than as a surprise in production:
//   - two processes with separate replica files index different vaults through one server and,
//     after sync, each sees the other's rows (nothing lost, FTS5 and vec0 included);
//   - the migration chain is safe to run from two machines at once;
//   - same-row semantics (the server serializes; an app-level read-modify-write still loses);
//   - `BEGIN EXCLUSIVE` DOES serialize across machines, but the server kills a held transaction
//     after a few seconds without telling the holder, so it cannot be the leader lock.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLibsql } from "../src/db/libsql";
import { CACHE_MIGRATIONS, provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { ftsCandidates } from "../src/search/fts";
import { buildRepresentationManifest } from "../src/search/representation";
import { semanticSearch } from "../src/search/semantic";
import { ensureVecChunks, loadVec } from "../src/search/vec";
import { type Sqld, sqldBinary, sqldRequired, startSqld } from "./sqld-harness";
import { makeTempDir, rmTemp } from "./tmp";

const sqld = sqldBinary();
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const WORKER = fileURLToPath(new URL("./libsql-sync-worker.ts", import.meta.url));

interface WorkerRun {
  events: Array<Record<string, unknown>>;
  waitFor(event: string): Promise<Record<string, unknown>>;
  done: Promise<number>;
}

function runWorker(replica: string, url: string, scenario: string, ...args: string[]): WorkerRun {
  const child: ChildProcess = spawn("bun", [WORKER, scenario, replica, url, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{ event: string; resolve: (o: Record<string, unknown>) => void }> = [];
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      const o = JSON.parse(line) as Record<string, unknown>;
      events.push(o);
      for (const w of waiters.filter((x) => x.event === o.event)) w.resolve(o);
    }
  });
  const done = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  return {
    events,
    done,
    waitFor: (event) =>
      new Promise((resolve) => {
        const hit = events.find((e) => e.event === event);
        if (hit) resolve(hit);
        else waiters.push({ event, resolve });
      }),
  };
}

const last = (r: WorkerRun): Record<string, unknown> => r.events.at(-1) ?? {};

describe("libsql sync: environment floor", () => {
  it("has sqld and bun when the run requires them", () => {
    if (sqldRequired()) {
      expect(sqld, "OBSIDIAN_TC_REQUIRE_SQLD=1 but no sqld binary was found").toBeDefined();
      expect(bunAvailable).toBe(true);
    }
  });
});

describe.skipIf(!sqld || !bunAvailable)("libsql embedded replicas vs one sqld", () => {
  const dir = makeTempDir("otc-libsql-sync-");
  const servers: Sqld[] = [];
  let plain: Sqld; // stock sqld: FTS5 yes, vec0 no
  let withVec: Sqld; // sqld with sqlite-vec trusted: what a vec0 write forwarded to the server needs
  const handles: Database[] = [];

  async function replica(server: Sqld, name: string, syncIntervalMs?: number): Promise<Database> {
    const db = await openLibsql(join(dir, `${name}.db`), undefined, {
      sync: { url: server.url, ...(syncIntervalMs ? { syncIntervalMs } : {}) },
    });
    handles.push(db);
    return db;
  }

  beforeAll(async () => {
    const bin = sqld as string;
    mkdirSync(join(dir, "plain"));
    mkdirSync(join(dir, "vec"));
    plain = await startSqld(bin, join(dir, "plain"));
    withVec = await startSqld(bin, join(dir, "vec"), { withVec: true });
    servers.push(plain, withVec);
  }, 30_000);

  afterAll(async () => {
    for (const h of handles) h.close?.();
    for (const s of servers) await s.stop();
    rmTemp(dir);
  }, 30_000);

  it("the migration chain runs from two machines at once and lands exactly once", async () => {
    const a = runWorker(join(dir, "ma.db"), plain.url, "migrate");
    const b = runWorker(join(dir, "mb.db"), plain.url, "migrate");
    expect(await Promise.all([a.done, b.done])).toEqual([0, 0]);
    // What the chain records on a plain local database: the reference for the server's table.
    const local = await openLibsql(":memory:");
    provisionCacheDb(local);
    const recorded = (d: Database): unknown[] =>
      d.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
    const expected = recorded(local);
    expect(expected.length).toBeGreaterThanOrEqual(CACHE_MIGRATIONS.length);
    local.close?.();

    // A third machine that only pulls sees every migration once, with the same checksums.
    const c = await replica(plain, "mc");
    c.sync?.();
    expect(recorded(c)).toEqual(expected);
    // And a late machine that runs the chain finds nothing left to apply (checksums hold over a replica).
    expect(provisionCacheDb(c)).toEqual([]);
    console.log(
      "[libsql-sync] migrations applied per racing machine:",
      [last(a), last(b)].map((e) => e.applied),
    );
  }, 60_000);

  it("two processes index different vaults through one server and each sees the other", async () => {
    // One machine bootstraps the schema first (migrations + the vec0 table); the two writers then
    // race on data only. Racing the bootstrap too is NOT safe: ensureVecChunks is check-then-insert
    // on schema_migrations, and when two first boots interleave the loser dies on the server's
    // UNIQUE(version) (seen in a spike run: "UNIQUE constraint failed: schema_migrations.version").
    // The migration chain itself has no such window (previous test).
    const boot = await replica(withVec, "ib0");
    provisionCacheDb(boot);
    ensureVecChunks(
      boot,
      buildRepresentationManifest(fakeEmbeddingProvider({ dimensions: 32 }), {}),
    );
    const a = runWorker(join(dir, "ia.db"), withVec.url, "index", "alpha", "3");
    const b = runWorker(join(dir, "ib.db"), withVec.url, "index", "beta", "3");
    expect(await Promise.all([a.done, b.done])).toEqual([0, 0]);
    expect(last(a).vec).toBe(true);
    expect(last(b).vec).toBe(true);

    // A third machine that only pulls: everything both writers did is there, nothing lost.
    const c = await replica(withVec, "ic");
    c.sync?.();
    const perVault = c
      .prepare("SELECT vault_id, count(*) AS n FROM chunks GROUP BY vault_id ORDER BY vault_id")
      .all();
    expect(perVault).toEqual([
      { vault_id: "alpha", n: 3 },
      { vault_id: "beta", n: 3 },
    ]);
    // FTS5 (note text synced and searchable locally) and vec0 (KNN served from the local replica).
    expect(ftsCandidates(c, "alpha", "markeralpha2", 5)?.map((r) => r.path)).toEqual([
      "notes/alpha-2.md",
    ]);
    expect(ftsCandidates(c, "beta", "markerbeta0", 5)?.map((r) => r.path)).toEqual([
      "notes/beta-0.md",
    ]);
    expect(loadVec(c)).toBe(true);
    const [q] = await fakeEmbeddingProvider({ dimensions: 32 }).embed(["the quick brown fox"]);
    const hits = semanticSearch(c, "beta", q ?? [], { k: 3, returnContent: false });
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.path.startsWith("notes/beta-"))).toBe(true);
  }, 90_000);

  describe("same-row semantics (the server serializes; the app still has to)", () => {
    it("atomic increments from two replicas never lose an update", async () => {
      const a = await replica(plain, "sa");
      const b = await replica(plain, "sb");
      a.exec("CREATE TABLE ctr(id INTEGER PRIMARY KEY, n INTEGER)");
      a.exec("INSERT INTO ctr VALUES (1, 0)");
      b.sync?.();
      for (let i = 0; i < 15; i++) {
        a.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
        b.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
      }
      b.sync?.();
      expect(b.prepare("SELECT n FROM ctr WHERE id = 1").get()).toEqual({ n: 30 });
    });

    it("a read-modify-write in application code DOES lose an update (same as any database)", async () => {
      const a = await replica(plain, "ra");
      const b = await replica(plain, "rb");
      a.exec("CREATE TABLE rmw(id INTEGER PRIMARY KEY, n INTEGER)");
      a.exec("INSERT INTO rmw VALUES (1, 0)");
      b.sync?.();
      const read = (d: Database): number =>
        (d.prepare("SELECT n FROM rmw").get() as { n: number }).n;
      const [na, nb] = [read(a), read(b)]; // both machines read 0
      a.prepare("UPDATE rmw SET n = ?").run(na + 1);
      b.prepare("UPDATE rmw SET n = ?").run(nb + 1);
      a.sync?.();
      expect(read(a)).toBe(1); // two increments, one survives: the later write wins
    });

    it("a duplicate primary key is rejected by the SERVER even when the replica is stale", async () => {
      const a = await replica(plain, "da");
      const b = await replica(plain, "db");
      a.exec("CREATE TABLE uq(id TEXT PRIMARY KEY, who TEXT)");
      b.sync?.(); // b has the table, not the row
      a.prepare("INSERT INTO uq VALUES ('k', 'a')").run();
      expect(b.prepare("SELECT who FROM uq WHERE id = 'k'").get()).toBeUndefined(); // stale, as designed
      expect(() => b.prepare("INSERT INTO uq VALUES ('k', 'b')").run()).toThrow(
        /UNIQUE|constraint/i,
      );
      b.prepare("INSERT OR REPLACE INTO uq VALUES ('k', 'b')").run(); // upsert: last server-side write wins
      a.sync?.();
      expect(a.prepare("SELECT who FROM uq WHERE id = 'k'").get()).toEqual({ who: "b" });
    });

    it("another machine's write is visible after sync(), and by itself with syncIntervalMs", async () => {
      const writer = await replica(plain, "wa");
      writer.exec("CREATE TABLE vis(x INTEGER)");
      const manual = await replica(plain, "wb");
      const timed = await replica(plain, "wc", 100);
      writer.prepare("INSERT INTO vis VALUES (1)").run();
      expect(manual.prepare("SELECT count(*) AS n FROM vis").get()).toEqual({ n: 0 });
      manual.sync?.();
      expect(manual.prepare("SELECT count(*) AS n FROM vis").get()).toEqual({ n: 1 });
      const deadline = Date.now() + 5000;
      let n = 0;
      while (n === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        n = (timed.prepare("SELECT count(*) AS n FROM vis").get() as { n: number }).n;
      }
      expect(n).toBe(1);
    });

    it("a follower (readonly + sync) reads the replica file, cannot write, and sees the leader's later writes", async () => {
      const leader = await replica(plain, "fl");
      leader.exec("CREATE TABLE fo(x INTEGER)");
      leader.prepare("INSERT INTO fo VALUES (1)").run();
      const follower = await openLibsql(join(dir, "fl.db"), undefined, {
        readonly: true,
        sync: { url: plain.url },
      });
      handles.push(follower);
      expect(follower.sync).toBeUndefined(); // only the leader talks to the server
      expect(follower.prepare("SELECT count(*) AS n FROM fo").get()).toEqual({ n: 1 });
      expect(() => follower.prepare("INSERT INTO fo VALUES (2)").run()).toThrow(/readonly/i);
      leader.prepare("INSERT INTO fo VALUES (3)").run();
      expect(follower.prepare("SELECT count(*) AS n FROM fo").get()).toEqual({ n: 2 });
    });
  });

  describe("the leader lock over replicas", () => {
    it("BEGIN EXCLUSIVE serializes across machines through the server", async () => {
      const holder = runWorker(join(dir, "ha.db"), plain.url, "hold", "2000");
      await holder.waitFor("acquired");
      const b = await replica(plain, "hb");
      const t0 = Date.now();
      b.exec("BEGIN EXCLUSIVE");
      const waited = Date.now() - t0;
      b.exec("ROLLBACK");
      expect(await holder.done).toBe(0);
      expect(last(holder).event).toBe("released");
      expect(waited).toBeGreaterThan(800); // blocked behind the other machine's lock
      expect(waited).toBeLessThan(4500);
    }, 30_000);

    it("...but a lock held past the server's transaction timeout is taken away silently", async () => {
      const holder = runWorker(join(dir, "ta.db"), plain.url, "hold", "9000");
      const got = await holder.waitFor("acquired");
      const b = await replica(plain, "tb");
      const t0 = Date.now();
      b.exec("BEGIN EXCLUSIVE");
      const waited = Date.now() - t0;
      b.exec("ROLLBACK");
      // B got the lock while A still believed it held it (A sleeps 9 s)...
      expect(Date.now() - Number(got.at)).toBeLessThan(9000);
      expect(waited).toBeGreaterThan(2000);
      // ...and A learns only when it tries to commit.
      expect(await holder.done).toBe(0);
      expect(last(holder).event).toBe("lost");
      expect(String(last(holder).message)).toMatch(/timed-out|timeout/i);
    }, 40_000);

    it("a lease row claimed with one conditional upsert is arbitrated by the server and expires", async () => {
      const a = await replica(plain, "la");
      const b = await replica(plain, "lb");
      a.exec(
        "CREATE TABLE lease(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
      b.sync?.();
      const claim = (d: Database, who: string, now: number, ttl: number): boolean =>
        d
          .prepare(
            `INSERT INTO lease(name, holder, expires_at) VALUES ('index', ?, ?)
             ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
             WHERE lease.expires_at <= ? OR lease.holder = excluded.holder`,
          )
          .run(who, now + ttl, now).changes === 1;
      expect(claim(a, "A", 1000, 500)).toBe(true);
      expect(claim(b, "B", 1100, 500)).toBe(false); // held by A until 1500
      expect(claim(a, "A", 1200, 500)).toBe(true); // A renews
      expect(claim(b, "B", 1600, 500)).toBe(false); // the renewal runs to 1700
      expect(claim(b, "B", 1701, 500)).toBe(true); // A stopped renewing: B takes over
      expect(claim(a, "A", 1702, 500)).toBe(false);
    });
  });
});
