// probeTelemetryState (THE-1125) — the DB-touching half doctor-telemetry.test.ts's pure check
// factory doesn't cover. Same real-file-probe shape as doctor-db-space.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeTelemetryState } from "../src/cli/commands/doctor-probes";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { getOrCreateInstallId, recordSendResult } from "../src/telemetry/state";

describe("probeTelemetryState", () => {
  it("reports the config-only view when cache.db does not exist yet (a fresh install)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-probe-missing-"));
    try {
      const view = await probeTelemetryState(cacheDir, 5000, {
        enabled: true,
        endpointHost: "https://collector.example",
      });
      expect(view).toEqual({ enabled: true, endpoint: "https://collector.example" });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("reports the config-only view when telemetry_state has never been created (never sent)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-probe-unseeded-"));
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"), 5000);
      provisionCacheDb(db, { version: "test" });
      db.close?.();

      const view = await probeTelemetryState(cacheDir, 5000, { enabled: false });
      expect(view).toEqual({ enabled: false });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("reports installId/lastSendAt/lastError once a real send has been attempted", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-probe-real-"));
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"), 5000);
      provisionCacheDb(db, { version: "test" });
      const installId = getOrCreateInstallId(db);
      recordSendResult(db, { at: 1737936000000, error: "HTTP 503 from collector.example" });
      db.close?.();

      const view = await probeTelemetryState(cacheDir, 5000, {
        enabled: true,
        endpointHost: "https://collector.example",
      });
      expect(view.installId).toBe(installId);
      expect(view.lastSendAt).toBe(1737936000000);
      expect(view.lastError).toBe("HTTP 503 from collector.example");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
