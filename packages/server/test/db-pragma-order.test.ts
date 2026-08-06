// THE-745 / #719: SQLite's busy handler is per-connection state installed BY the `busy_timeout`
// pragma. Until that statement runs, the connection has no handler at all and contention returns
// SQLITE_BUSY immediately rather than retrying — so any pragma applied BEFORE it is unprotected.
//
// These tests contend two REAL connections against one file rather than asserting on the pragma
// list, because the settled state is identical under both orderings: `PRAGMA busy_timeout` reads
// back 5000 either way, which is why db-baseline.test.ts passed throughout. The defect lives on
// the TIME axis, so that is the axis asserted here.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from "../src/db/pragmas";
import { rmTemp } from "./tmp";

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
  close(): void;
}

/** Short enough to keep the suite fast, long enough that a fail-fast is unambiguous. */
const BUSY_MS = 400;

async function rawOpen(path: string): Promise<RawDb> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (p: string) => RawDb;
  };
  return new DatabaseSync(path);
}

/**
 * The pre-fix order, DERIVED from the shipped list rather than copied, so it cannot drift into
 * asserting against a stale literal. Kept only as the control below.
 */
function orderBeforeFix(busyTimeoutMs: number): string[] {
  const timeout = `busy_timeout = ${busyTimeoutMs}`;
  return [...connectionPragmas(busyTimeoutMs).filter((p) => p !== timeout), timeout];
}

/**
 * Apply `pragmas` to a fresh connection while a reader holds a SHARED lock on a database that is
 * still in the default journal mode, and report how long that took.
 *
 * The seed is deliberately NOT in WAL. Converting a database INTO WAL needs an EXCLUSIVE lock, and
 * that is the only window in which this ordering is observable — an already-WAL database makes
 * `journal_mode = WAL` a no-op that never contends. The window is therefore a first boot against a
 * fresh cacheDir, a wiped cache, or several servers racing to create one, which is exactly the
 * report in #719 and exactly why a long-running deployment never reproduces it.
 */
async function timeApply(pragmas: string[]): Promise<{ ms: number; threw: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "pragma-order-"));
  try {
    const path = join(dir, "cache.db");
    const seed = await rawOpen(path);
    seed.exec("CREATE TABLE t(v TEXT)");
    seed.close();

    const holder = await rawOpen(path);
    holder.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    holder.exec("BEGIN");
    holder.prepare("SELECT count(*) AS n FROM t").get(); // materialise the read lock

    const db = await rawOpen(path);
    const started = performance.now();
    let threw = false;
    try {
      for (const p of pragmas) db.exec(`PRAGMA ${p}`);
    } catch {
      threw = true;
    }
    const ms = performance.now() - started;

    db.close();
    holder.exec("ROLLBACK");
    holder.close();
    return { ms, threw };
  } finally {
    rmTemp(dir);
  }
}

describe("THE-745 — busy_timeout is installed before anything that can contend", () => {
  it("blocks for the timeout when the WAL conversion is contended, instead of failing instantly", async () => {
    const { ms, threw } = await timeApply(connectionPragmas(BUSY_MS));
    // The holder never releases, so this still ends in SQLITE_BUSY. That is not the claim.
    expect(threw).toBe(true);
    // The claim: it WAITED. The floor sits well under BUSY_MS because SQLite's busy handler is not
    // a precise sleep, and far above anything an absent handler could produce.
    expect(ms).toBeGreaterThan(BUSY_MS * 0.5);
  });

  it("CONTROL: the pre-fix order fails fast, which is what makes the assertion above meaningful", async () => {
    const { ms, threw } = await timeApply(orderBeforeFix(BUSY_MS));
    expect(threw).toBe(true);
    // ~0.3 ms when measured. A generous ceiling still separates it from a real wait by 4x.
    expect(ms).toBeLessThan(BUSY_MS * 0.25);
  });

  it("keeps busy_timeout first in the list every adapter applies", () => {
    const pragmas = connectionPragmas();
    expect(pragmas[0]).toBe(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    expect(pragmas.findIndex((p) => p.startsWith("journal_mode"))).toBeGreaterThan(0);
  });
});
