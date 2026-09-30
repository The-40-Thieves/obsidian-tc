// Shared-on-one-host backend. N stdio MCP clients each spawn their own server process against one
// cacheDir; without this every process rate-limits in isolation and the effective limit is N times
// the configured one.
//
// Its own file (`<cacheDir>/ratelimit.db`), never cache.db: a bucket update is a write transaction
// per governed call, and buckets are ephemeral — putting them in cache.db would queue every tool
// call behind the indexer's long write transactions (and grow cache.db's WAL with churn nobody needs
// to keep). A dedicated file keeps that contention to the limiter's own tiny transactions.
//
// Atomicity: one BEGIN IMMEDIATE transaction per consume. IMMEDIATE takes the write lock up front,
// so two processes can never read the same tokens and both spend them, and `busy_timeout` (config
// `db.busyTimeoutMs`, applied by openDatabase) governs how long a contended update waits before it
// throws SQLITE_BUSY, which the limiter's failure policy then handles.
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { openConfiguredDatabase } from "../db/open";
import { inWriteTransaction } from "../db/txn";
import { cachedPrepare, type Database, type Statement } from "../db/types";
import { type BucketSpec, fullRefillMs, type RateLimitBackend } from "./backend";
import { type BucketState, type TokenBucketResult, takeFromBucket } from "./bucket";

export const RATELIMIT_DB_FILENAME = "ratelimit.db";

/** A bucket idle this long past its full-refill time is dropped; never less than a minute. */
const MIN_TTL_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  last_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
) WITHOUT ROWID`;

interface BucketRow {
  tokens: number;
  last_ms: number;
}

export interface SqliteBackendOptions {
  /** Minimum gap between expired-bucket sweeps (default 60_000). */
  sweepIntervalMs?: number;
}

export class SqliteBackend implements RateLimitBackend {
  readonly kind = "sqlite" as const;
  private readonly sweepIntervalMs: number;
  private lastSweepMs: number | null = null;
  private closed = false;

  /** Takes an OPEN connection (see openSqliteBackend); creates the table if absent. */
  constructor(
    private readonly db: Database,
    opts: SqliteBackendOptions = {},
  ) {
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    db.exec(SCHEMA);
  }

  async consume(
    key: string,
    spec: BucketSpec,
    n: number,
    nowMs: number,
  ): Promise<TokenBucketResult> {
    if (this.closed) throw new Error("rate-limit sqlite backend is closed");
    const db = this.db;
    return inWriteTransaction(db, "rate_limit", () => {
      const row = cachedPrepare(
        db,
        "SELECT tokens, last_ms FROM rate_limit_buckets WHERE key = ?",
      ).get(key) as BucketRow | undefined;
      const state: BucketState = row
        ? { tokens: Number(row.tokens), lastMs: Number(row.last_ms) }
        : { tokens: spec.capacity, lastMs: null };
      const res = takeFromBucket(state, spec, n, nowMs);
      const expiresMs = nowMs + Math.max(2 * fullRefillMs(spec), MIN_TTL_MS);
      cachedPrepare(
        db,
        `INSERT INTO rate_limit_buckets (key, tokens, last_ms, expires_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, last_ms = excluded.last_ms,
           expires_ms = excluded.expires_ms`,
      ).run(key, state.tokens, state.lastMs, expiresMs);
      this.sweep(nowMs);
      return res;
    });
  }

  /** Drop buckets whose expiry passed (idle long enough to be guaranteed full). Runs inside the
   *  caller's write transaction, at most once per sweepIntervalMs per process. */
  private sweep(nowMs: number): void {
    if (this.lastSweepMs !== null && nowMs - this.lastSweepMs < this.sweepIntervalMs) return;
    this.lastSweepMs = nowMs;
    const del: Statement = cachedPrepare(
      this.db,
      "DELETE FROM rate_limit_buckets WHERE expires_ms <= ?",
    );
    del.run(nowMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close?.();
  }
}

/** Open (creating if needed) `<cacheDir>/ratelimit.db` through the repo's one config-scoped seam, so
 *  `db.busyTimeoutMs` applies — the same runtime split as cache.db (bun:sqlite / better-sqlite3 /
 *  node:sqlite). */
export async function openSqliteBackend(
  cfg: Pick<ServerConfig, "cacheDir" | "db">,
  opts: SqliteBackendOptions = {},
): Promise<SqliteBackend> {
  const db = await openConfiguredDatabase(cfg, RATELIMIT_DB_FILENAME);
  try {
    return new SqliteBackend(db, opts);
  } catch (e) {
    db.close?.();
    throw e;
  }
}

/** The on-disk path, for docs/doctor/tests. */
export function ratelimitDbPath(cacheDir: string): string {
  return join(cacheDir, RATELIMIT_DB_FILENAME);
}
