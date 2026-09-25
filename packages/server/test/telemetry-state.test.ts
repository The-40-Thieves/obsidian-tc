// THE-1125 — telemetry_state (install id + last-send outcome), the durable half of opt-in
// telemetry. Real on-disk cache.db per test, mirroring doctor-db-space.test.ts's shape.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  getOrCreateInstallId,
  readTelemetryState,
  recordSendResult,
  resetInstallId,
} from "../src/telemetry/state";

async function withDb(fn: (db: Awaited<ReturnType<typeof openDatabase>>) => Promise<void> | void) {
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-state-"));
  try {
    const db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    await fn(db);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

describe("telemetry/state.ts", () => {
  it("readTelemetryState returns null before anything has been created", async () => {
    await withDb((db) => {
      expect(readTelemetryState(db)).toBeNull();
    });
  });

  it("getOrCreateInstallId creates a fresh UUID on first call", async () => {
    await withDb((db) => {
      const id = getOrCreateInstallId(db);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      const state = readTelemetryState(db);
      expect(state?.installId).toBe(id);
      expect(state?.lastSendAt).toBeNull();
      expect(state?.lastError).toBeNull();
    });
  });

  it("getOrCreateInstallId is idempotent — a second call returns the SAME id", async () => {
    await withDb((db) => {
      const first = getOrCreateInstallId(db);
      const second = getOrCreateInstallId(db);
      expect(second).toBe(first);
    });
  });

  it("resetInstallId rotates to a DIFFERENT id and persists it", async () => {
    await withDb((db) => {
      const original = getOrCreateInstallId(db);
      const rotated = resetInstallId(db);
      expect(rotated).not.toBe(original);
      expect(readTelemetryState(db)?.installId).toBe(rotated);
      // A further getOrCreateInstallId call must see the ROTATED id, not recreate the original.
      expect(getOrCreateInstallId(db)).toBe(rotated);
    });
  });

  it("resetInstallId works even with no prior row (seeds one)", async () => {
    await withDb((db) => {
      const id = resetInstallId(db);
      expect(readTelemetryState(db)?.installId).toBe(id);
    });
  });

  it("recordSendResult(success) sets lastSendAt and clears lastError", async () => {
    await withDb((db) => {
      getOrCreateInstallId(db);
      recordSendResult(db, { at: 1000, error: "boom" });
      expect(readTelemetryState(db)?.lastError).toBe("boom");
      recordSendResult(db, { at: 2000 });
      const state = readTelemetryState(db);
      expect(state?.lastSendAt).toBe(2000);
      expect(state?.lastError).toBeNull();
    });
  });

  it("recordSendResult(failure) never touches installId", async () => {
    await withDb((db) => {
      const id = getOrCreateInstallId(db);
      recordSendResult(db, { at: 1000, error: "HTTP 503" });
      expect(readTelemetryState(db)?.installId).toBe(id);
    });
  });

  it("recordSendResult before any install id exists still records the outcome (defensive path)", async () => {
    await withDb((db) => {
      recordSendResult(db, { at: 5000, error: "no id yet" });
      const state = readTelemetryState(db);
      expect(state?.lastSendAt).toBe(5000);
      expect(state?.lastError).toBe("no id yet");
      expect(state?.installId).toBeTruthy();
    });
  });
});
