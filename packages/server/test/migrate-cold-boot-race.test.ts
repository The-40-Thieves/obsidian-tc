// Cold-boot race on the shared migration runner: several MCP clients starting at once each spawn a
// stdio server against the SAME cacheDir, so N processes run `runMigrations` on the same fresh
// SQLite file concurrently. The runner used to read schema_migrations WITHOUT a lock and then
// `BEGIN` (deferred): two processes could both see a migration as pending, and the loser then either
// re-ran its DDL ("table ... already exists", a non-idempotent migration run twice) or hit
// `UNIQUE constraint failed: schema_migrations.version` on the INSERT — a boot crash observed once in
// CI's vault-leader-failover cold-boot test.
//
// Two layers: real child processes stressing each DB chain (the actual multi-client shape), and an
// in-process deterministic test of the lose-the-race path.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyConnectionPragmas } from "../src/db/apply-pragmas";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES } from "../src/db/migration-manifest";
import { AUTH_MIGRATIONS, CACHE_MIGRATIONS } from "../src/db/provision";
import { makeTempDir, rmTemp } from "./tmp";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "fixtures", "migrate-race-child.ts");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const PROCESSES = 4;
const ITERATIONS = Number(process.env.MIGRATE_RACE_ITERATIONS ?? 50);
// Overridable only to DIAGNOSE: a short budget makes a failure's `elapsedMs` say whether the busy
// handler spent the whole budget (contention) or was never invoked (a classification gap).
const BUSY_TIMEOUT_MS = Number(process.env.MIGRATE_RACE_BUSY_MS ?? 10_000);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmTemp(d);
});
function tmpDir(): string {
  const d = makeTempDir("otc-migrate-race-");
  tmpDirs.push(d);
  return d;
}

interface ChildResult {
  ok: boolean;
  applied?: string[];
  error?: string;
  /** Child wall time from barrier release to done (diagnostic only). */
  ms?: number;
}

/** Spawn `PROCESSES` children, wait until all are READY, release them together, collect results.
 *  Every child is killed in `finally` — a hung child must never outlive the test. */
async function raceOnce(chain: string, cacheDir: string): Promise<ChildResult[]> {
  const children = Array.from({ length: PROCESSES }, (_, i) =>
    spawn("bun", [CHILD, chain, cacheDir, String(BUSY_TIMEOUT_MS), String(i)], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  try {
    const outputs = children.map((c) => {
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => {
        out += d;
      });
      c.stderr.on("data", (d) => {
        err += d;
      });
      return { get: () => ({ out, err }) };
    });
    const exits = children.map(
      (c) => new Promise<void>((resolve) => c.once("close", () => resolve())),
    );
    const ready = children.map(
      (c, i) =>
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (outputs[i]?.get().out.includes("READY")) resolve();
          };
          c.stdout.on("data", check);
          c.once("close", () => reject(new Error(`child ${i} exited before READY`)));
          check();
        }),
    );
    await Promise.all(ready);
    for (const c of children) c.stdin.write("go\n");
    await Promise.all(exits);
    return outputs.map((o, i) => {
      const line = o
        .get()
        .out.split("\n")
        .find((l) => l.startsWith("{"));
      if (!line) return { ok: false, error: `child ${i} no result; stderr: ${o.get().err}` };
      return JSON.parse(line) as ChildResult;
    });
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  }
}

const CHAINS: Array<{
  chain: "cache" | "experiential" | "auth";
  file: string;
  versions: string[];
}> = [
  { chain: "cache", file: "cache.db", versions: CACHE_MIGRATIONS.map((m) => m.version) },
  {
    chain: "experiential",
    file: "experiential.db",
    versions: EXPERIENTIAL_MIGRATION_FILES.map((f) => f.slice(0, "YYYYMMDD_NNN".length)),
  },
  { chain: "auth", file: "auth.db", versions: AUTH_MIGRATIONS.map((m) => m.version) },
];

describe.skipIf(!bunAvailable)("migration runner: concurrent cold boot across processes", () => {
  for (const { chain, file, versions } of CHAINS) {
    it(`${chain}: ${PROCESSES} processes x ${ITERATIONS} fresh cacheDirs, zero failures, each migration applied exactly once`, async () => {
      const failures: string[] = [];
      let slowestMs = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const cacheDir = tmpDir();
        const results = await raceOnce(chain, cacheDir);
        for (const r of results) slowestMs = Math.max(slowestMs, r.ms ?? 0);
        const bad = results.filter((r) => !r.ok);
        if (bad.length > 0) {
          // One entry per failed child: each carries its process index, phase, SQLite codes, time
          // since the barrier and stack, and `ok` siblings' times show who else was busy.
          for (const b of bad) failures.push(`iteration ${i} cacheDir=${cacheDir}: ${b.error}`);
          failures.push(
            `iteration ${i} ms since barrier per child: ${results.map((r) => r.ms ?? "?").join(" ")}`,
          );
          continue;
        }
        const applied = results.flatMap((r) => r.applied ?? []).sort();
        if (JSON.stringify(applied) !== JSON.stringify([...versions].sort())) {
          failures.push(
            `iteration ${i}: applied ${applied.length} != ${versions.length} once each`,
          );
          continue;
        }
        const db = new DatabaseSync(join(cacheDir, file));
        // A SUPERSET check, not `=== versions.length`: 20260519_001_initial.sql also self-records
        // a legacy `20260519_001_initial` row, so cache.db legitimately holds one extra row.
        const rows = (
          db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]
        ).map((r) => r.version);
        db.close();
        const missing = versions.filter((v) => !rows.includes(v));
        if (missing.length > 0) failures.push(`iteration ${i}: rows missing ${missing.join(",")}`);
      }
      // The FULL list goes in the message (vitest truncates a long array diff, which hid the cause
      // of a Windows merge-queue failure) and to stderr, which CI logs keep verbatim. The count is
      // in the message too: a flake rate is the evidence, not just pass/fail.
      process.stderr.write(`\n[${chain}] slowest child: ${slowestMs} ms\n`);
      const report = failures.join("\n---\n");
      if (failures.length > 0) process.stderr.write(`\n[${chain}] failures:\n${report}\n`);
      expect(
        failures.length,
        `${failures.length} failure entries over ${ITERATIONS} iterations:\n${report}`,
      ).toBe(0);
    }, 600_000);
  }
});

describe("migration runner: losing the race", () => {
  it("re-reads under the write lock and skips a migration another connection applied first", () => {
    const dir = tmpDir();
    const path = join(dir, "race.db");
    const a = new DatabaseSync(path);
    const b = new DatabaseSync(path);
    for (const d of [a, b]) d.exec("PRAGMA busy_timeout = 5000");
    // NOT idempotent: `CREATE TABLE` without IF NOT EXISTS throws if it runs a second time.
    const migs = [
      { version: "20260101_001", sql: "CREATE TABLE t1(x); INSERT INTO t1 VALUES (1);" },
      { version: "20260101_002", sql: "CREATE TABLE t2(x);" },
    ];
    // Connection `a` passes the unlocked "is it applied?" read for 001, and only THEN does `b`
    // apply the same migration — exactly the window two booting processes hit.
    let raced = false;
    const racing = new Proxy(a, {
      get(target, prop) {
        if (prop !== "prepare") {
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (sql: string) => {
          const st = target.prepare(sql);
          if (!sql.startsWith("SELECT checksum FROM schema_migrations")) return st;
          return {
            ...st,
            run: st.run.bind(st),
            all: st.all.bind(st),
            get: (...p: unknown[]) => {
              const row = st.get(...p);
              if (!raced) {
                raced = true;
                expect(runMigrations(b, [migs[0] as (typeof migs)[number]])).toEqual([
                  "20260101_001",
                ]);
              }
              return row;
            },
          };
        };
      },
    });
    const applied = runMigrations(racing as never, migs);
    expect(raced).toBe(true);
    // 001 was applied by `b`, so `a` reports only what IT applied, and never re-ran the INSERT.
    expect(applied).toEqual(["20260101_002"]);
    expect(a.prepare("SELECT count(*) c FROM t1").get()).toEqual({ c: 1 });
    expect(a.prepare("SELECT count(*) c FROM schema_migrations").get()).toEqual({ c: 2 });
    a.close();
    b.close();
  });

  it("still rejects a checksum mismatch discovered only after the lock is taken", () => {
    const dir = tmpDir();
    const path = join(dir, "drift.db");
    const a = new DatabaseSync(path);
    const b = new DatabaseSync(path);
    let raced = false;
    const racing = new Proxy(a, {
      get(target, prop) {
        if (prop !== "prepare") {
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (sql: string) => {
          const st = target.prepare(sql);
          if (!sql.startsWith("SELECT checksum FROM schema_migrations")) return st;
          return {
            ...st,
            run: st.run.bind(st),
            all: st.all.bind(st),
            get: (...p: unknown[]) => {
              const row = st.get(...p);
              if (!raced) {
                raced = true;
                runMigrations(b, [{ version: "20260101_001", sql: "CREATE TABLE t1(x, y);" }]);
              }
              return row;
            },
          };
        };
      },
    });
    expect(() =>
      runMigrations(racing as never, [{ version: "20260101_001", sql: "CREATE TABLE t1(x);" }]),
    ).toThrow(/checksum mismatch/);
    a.close();
    b.close();
  });
});

describe("applyConnectionPragmas: busy retry on a cold open", () => {
  const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

  it("retries a pragma that fails SQLITE_BUSY, in order, until it succeeds", () => {
    const seen: string[] = [];
    let walFailures = 2;
    applyConnectionPragmas((p) => {
      if (p === "journal_mode = WAL" && walFailures-- > 0) throw busy();
      seen.push(p);
    }, 5000); // stall-ok: busy_timeout argument, not a test budget
    expect(seen[0]).toBe("busy_timeout = 5000");
    expect(seen).toContain("journal_mode = WAL");
    expect(seen.indexOf("foreign_keys = ON")).toBeLessThan(seen.indexOf("journal_mode = WAL"));
  });

  // The extended code CI reported, verbatim: bun:sqlite on windows-latest, `PRAGMA journal_mode = WAL`
  // on a fresh db that a sibling process had already converted and mapped:
  // `code=SQLITE_IOERR_TRUNCATE errno=1546 ... pragma=journal_mode = WAL` (15 of 14,400 stress iterations).
  const truncate = () =>
    Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_TRUNCATE", errno: 1546 });

  it("on Windows, retries the transient SQLITE_IOERR_TRUNCATE a sibling's file mapping causes", () => {
    const seen: string[] = [];
    let walFailures = 2;
    applyConnectionPragmas(
      (p) => {
        if (p === "journal_mode = WAL" && walFailures-- > 0) throw truncate();
        seen.push(p);
      },
      5000,
      "win32",
    );
    expect(seen).toContain("journal_mode = WAL");
    expect(seen).toContain("mmap_size = 268435456");
  });

  it("recognises the error by its numeric code alone (node:sqlite reports `errcode`)", () => {
    let failures = 1;
    const seen: string[] = [];
    applyConnectionPragmas(
      (p) => {
        if (p === "journal_mode = WAL" && failures-- > 0) {
          throw Object.assign(new Error("disk I/O error"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 1546,
          });
        }
        seen.push(p);
      },
      5000,
      "win32",
    );
    expect(seen).toContain("journal_mode = WAL");
  });

  it("does NOT retry it off Windows (there it is a real disk fault), nor any other IOERR", () => {
    let calls = 0;
    expect(() =>
      applyConnectionPragmas(
        () => {
          calls++;
          throw truncate();
        },
        5000,
        "linux",
      ),
    ).toThrow("disk I/O error");
    expect(calls).toBe(1);
    calls = 0;
    expect(() =>
      applyConnectionPragmas(
        () => {
          calls++;
          throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_WRITE" });
        },
        5000,
        "win32",
      ),
    ).toThrow("disk I/O error");
    expect(calls).toBe(1);
  });

  it("rethrows the truncate error once the budget is spent, naming the pragma that failed", () => {
    let err: unknown;
    try {
      applyConnectionPragmas(
        (p) => {
          if (p === "journal_mode = WAL") throw truncate();
        },
        30,
        "win32",
      );
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe("SQLITE_IOERR_TRUNCATE");
    expect((err as { pragma?: string }).pragma).toBe("journal_mode = WAL");
  });

  it("rethrows a non-busy error immediately and a busy one once the budget is spent", () => {
    let calls = 0;
    expect(
      () =>
        applyConnectionPragmas(() => {
          calls++;
          throw new Error("disk I/O error");
        }, 5000), // stall-ok: busy_timeout argument, not a test budget
    ).toThrow("disk I/O error");
    expect(calls).toBe(1);
    expect(() =>
      applyConnectionPragmas(() => {
        throw busy();
      }, 30),
    ).toThrow("database is locked");
  });
});
