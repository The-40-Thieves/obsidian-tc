// probeTelemetryState (THE-1125) — the DB-touching half doctor-telemetry.test.ts's pure check
// factory doesn't cover. Same real-file-probe shape as doctor-db-space.test.ts.
//
// Each db handle below is already closed before cleanup; `rmTemp` (test/tmp.ts) is still used
// in place of bare `rmSync` as the repo's Windows-safe retrying remove, for the same reason its
// own header gives — a handle released moments later (GC, antivirus scan) shouldn't flake CI.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeTelemetryState } from "../src/cli/commands/doctor-probes";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { getOrCreateInstallId, recordSendResult } from "../src/telemetry/state";
import { rmTemp } from "./tmp";

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
      rmTemp(cacheDir);
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
      rmTemp(cacheDir);
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
      rmTemp(cacheDir);
    }
  });
});
