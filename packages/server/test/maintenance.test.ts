import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMaintenanceSweep, startMaintenanceSweep } from "../src/db/maintenance";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function freshDb(): Database {
  const db = openMemoryDb();
  db.exec(schemaSql);
  return db;
}

describe("cache.db maintenance sweep (THE-292)", () => {
  it("purges expired rows, trims event_log to retention, keeps live + in-flight rows", () => {
    const db = freshDb();
    const now = 10_000_000_000;
    const idem =
      "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)";
    db.prepare(idem).run("v1", "old", "t", "h", now - 100_000, now - 90_000, "{}", 2, now - 1);
    db.prepare(idem).run("v1", "live", "t", "h", now - 100_000, now - 90_000, "{}", 2, now + 1000);
    // Crashed in-flight row: the EXPIRED-ONLY sweep must NOT reap it before expires_at —
    // dispatch-path reclaim (THE-293) owns that.
    db.prepare(idem).run("v1", "inflight", "t", "h", now - 120_000, null, null, null, now + 1000);
    const el =
      "INSERT INTO elicit_tokens (token, vault_id, tool_name, args_hash, proposed_change_json, caller, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?,?)";
    db.prepare(el).run("tok-old", "v1", "t", "h", null, "c", now - 400_000, now - 1, null);
    db.prepare(el).run("tok-live", "v1", "t", "h", null, "c", now - 400_000, now + 1000, null);
    const ev =
      "INSERT INTO event_log (ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type) VALUES (?,?,?,?,?,?,?,?,?,?)";
    db.prepare(ev).run(now - 31 * 86_400_000, "v1", "t", "c", 1, 1, "ok", null, "h", null);
    db.prepare(ev).run(now - 1 * 86_400_000, "v1", "t", "c", 1, 1, "ok", null, "h", null);

    const counts = runMaintenanceSweep(db, { now: () => now, eventLogDays: 30 });
    expect(counts).toEqual({ idempotency_keys: 1, elicit_tokens: 1, event_log: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toMatchObject({
      n: 2,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM elicit_tokens").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toMatchObject({ n: 1 });
  });

  it("startMaintenanceSweep ticks on the interval, reports counts, and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      const seen: unknown[] = [];
      const stop = startMaintenanceSweep({
        db,
        intervalMs: 1000,
        eventLogDays: 30,
        now: () => 10_000_000_000,
        onSweep: (c) => seen.push(c),
      });
      vi.advanceTimersByTime(3500);
      expect(seen).toHaveLength(3);
      stop();
      vi.advanceTimersByTime(3000);
      expect(seen).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a sweep failure to onError without escaping", () => {
    vi.useFakeTimers();
    try {
      const bad = {
        prepare() {
          throw new Error("boom");
        },
        exec() {},
      } as unknown as Database;
      const errs: unknown[] = [];
      const stop = startMaintenanceSweep({
        db: bad,
        intervalMs: 1000,
        eventLogDays: 30,
        onError: (e) => errs.push(e),
      });
      vi.advanceTimersByTime(1100);
      expect(errs).toHaveLength(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
