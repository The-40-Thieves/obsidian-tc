// THE-1125 — telemetry/wiring.ts: the composition root. Two acceptance-critical properties live
// here: (1) the collector is fed from the SAME MetricsRecorder.observeToolCall hook Prometheus
// uses (no second observation site), and (2) NOTHING leaves the process when telemetry is
// disabled — not at boot, not across any number of tool calls, not on a forced interval tick.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { MetricsRecorder } from "../src/metrics/registry";
import { Scheduler } from "../src/scheduler/scheduler";
import { defaultConfiguredFacadeMode, wireTelemetry } from "../src/telemetry/wiring";
import { rmTemp } from "./tmp";

function minimalTelemetryConfig(overrides: Partial<ServerConfig["telemetry"]>): ServerConfig {
  return {
    telemetry: {
      enabled: false,
      intervalMinutes: 60,
      ...overrides,
    },
    toolFacade: { mode: "triad" },
  } as unknown as ServerConfig;
}

describe("defaultConfiguredFacadeMode", () => {
  it("passes through a concrete mode", () => {
    expect(defaultConfiguredFacadeMode({ toolFacade: { mode: "domain" } })).toBe("domain");
  });
  it("collapses 'auto' to the same 'triad' fallback the resolver itself uses", () => {
    expect(defaultConfiguredFacadeMode({ toolFacade: { mode: "auto" } })).toBe("triad");
  });
});

describe("wireTelemetry — collector is fed from MetricsRecorder's ONE observeToolCall hook", () => {
  let cacheDir: string;
  // Windows refuses to delete a file with an open handle; close the db (if the test opened one)
  // before the retrying, Windows-safe `rmTemp` cleanup — see test/tmp.ts's own header.
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-wiring-"));
  });
  afterEach(() => {
    db?.close?.();
    db = undefined;
    rmTemp(cacheDir);
  });

  it("a tool call observed through MetricsRecorder.observeToolCall reaches the collector, with no second call site", async () => {
    db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    const config = minimalTelemetryConfig({});
    const telemetry = wireTelemetry({
      config,
      db,
      serverVersion: "test",
      getKnownToolNames: () => new Set(["search_text", "write_note"]),
    });
    const metrics = new MetricsRecorder({}, telemetry.observer);

    metrics.observeToolCall("v1", "search_text", "ok", 0.01, 100, {
      facadeMode: "domain",
      clientName: "claude-code",
    });
    metrics.observeToolCall("v1", "write_note", "error", 0.02, 0, { errorCode: "acl_denied" });

    const doc = telemetry.previewDocument();
    expect(doc.toolCalls).toEqual({ search_text: 1, write_note: 1 });
    expect(doc.errorCodes).toEqual({ acl_denied: 1 });
    expect(doc.clientNames).toEqual(["claude-code"]);
    expect(doc.facadeMode).toBe("domain");
  });
});

describe("wireTelemetry — nothing leaves the process when disabled (THE-1117 owner constraint)", () => {
  let cacheDir: string;
  // Windows refuses to delete a file with an open handle; close the db before the retrying,
  // Windows-safe `rmTemp` cleanup — see test/tmp.ts's own header.
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-disabled-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    db?.close?.();
    db = undefined;
    rmTemp(cacheDir);
  });

  it("registerJob registers NO scheduler job when telemetry.enabled is false", async () => {
    db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    const config = minimalTelemetryConfig({});
    const telemetry = wireTelemetry({ config, db, serverVersion: "test" });
    const scheduler = new Scheduler();
    telemetry.registerJob(scheduler);
    expect(scheduler.stats()).toEqual([]);
  });

  it("boot + 50 tool calls + a forced interval tick makes ZERO fetch calls when disabled", async () => {
    db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    const config = minimalTelemetryConfig({}); // enabled: false
    const telemetry = wireTelemetry({ config, db, serverVersion: "test" });
    const metrics = new MetricsRecorder({}, telemetry.observer);

    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const scheduler = new Scheduler();
      telemetry.registerJob(scheduler); // no-ops: enabled is false
      scheduler.start();

      for (let i = 0; i < 50; i++) {
        metrics.observeToolCall("v1", "search_text", "ok", 0.001, 10);
      }

      // Force what an interval tick would be, if one had been registered.
      await vi.advanceTimersByTimeAsync(config.telemetry.intervalMinutes * 60_000 * 10);
      await scheduler.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enabling telemetry with an endpoint DOES register a job and eventually sends", async () => {
    db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    const config = minimalTelemetryConfig({
      enabled: true,
      endpoint: "https://collector.example/ingest",
      intervalMinutes: 60,
    });
    const telemetry = wireTelemetry({ config, db, serverVersion: "test" });
    const metrics = new MetricsRecorder({}, telemetry.observer);
    metrics.observeToolCall("v1", "search_text", "ok", 0.001, 10);

    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const scheduler = new Scheduler();
      telemetry.registerJob(scheduler);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await scheduler.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
