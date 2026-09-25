// THE-1125 — sendTelemetry: the one network call opt-in telemetry ever makes. Real cache.db per
// test (mkdtempSync, mirroring doctor-db-space.test.ts), spied `fetch`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { TelemetryCollector } from "../src/telemetry/collector";
import { redactEndpoint } from "../src/telemetry/redact-endpoint";
import { sendTelemetry } from "../src/telemetry/sender";
import { readTelemetryState } from "../src/telemetry/state";

async function withDb(fn: (db: Awaited<ReturnType<typeof openDatabase>>) => Promise<void> | void) {
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-sender-"));
  try {
    const db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    await fn(db);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

const ENDPOINT = "https://user:pw@collector.example/ingest?key=abc";

describe("sendTelemetry", () => {
  it("on success: resets the collector, records lastSendAt, returns ok:true", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      collector.recordToolCall("search_text");
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });

      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
      expect(collector.snapshot().toolCalls).toEqual({}); // reset on success
      expect(readTelemetryState(db)?.lastSendAt).toBe(2000);
      expect(readTelemetryState(db)?.lastError).toBeNull();
    });
  });

  it("on HTTP failure: keeps the collector's counters (cumulative, not lossy) and records lastError", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      collector.recordToolCall("search_text");
      const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;

      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      expect(collector.snapshot().toolCalls).toEqual({ search_text: 1 }); // NOT reset
      expect(readTelemetryState(db)?.lastError).toContain("HTTP 503");
    });
  });

  it("on transport error: never throws, keeps counters, records a scrubbed lastError", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      collector.recordToolCall("search_text");
      const fetchImpl = (async () => {
        throw new TypeError(`fetch failed: request to ${ENDPOINT} failed`);
      }) as typeof fetch;

      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      expect(collector.snapshot().toolCalls).toEqual({ search_text: 1 });
      const state = readTelemetryState(db);
      expect(state?.lastError).not.toContain("user:pw");
      expect(state?.lastError).not.toContain("key=abc");
    });
  });

  // Security-review follow-up: a redirect must never be auto-followed (it would re-send the
  // bearer token and the document to an unaudited host) — one request only, treated as a failure.
  it("never follows a redirect: a spied fetch returning 302 (opaqueredirect-shaped) sends exactly ONE request and is recorded as failed", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      let calls = 0;
      const fetchImpl = (async (_url, init) => {
        calls++;
        expect((init as RequestInit).redirect).toBe("manual");
        // Mimic a spec-compliant runtime's manual-redirect response shape.
        return { type: "opaqueredirect", ok: false, status: 0 } as unknown as Response;
      }) as typeof fetch;

      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });

      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("redirect refused");
      expect(readTelemetryState(db)?.lastError).toContain("redirect refused");
    });
  });

  it("also treats a raw 3xx status (a test double not shaped like opaqueredirect) as a redirect failure", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/steal" },
        });
      }) as typeof fetch;

      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });

      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("redirect refused");
      // The Location header value (an attacker-controlled string) never appears in the recorded error.
      expect(result.error).not.toContain("attacker.example");
    });
  });

  it("sends an Authorization: Bearer header when authTokenEnv resolves, and NEVER logs/persists it", async () => {
    process.env.OBTC_TEST_TELEMETRY_TOKEN = "super-secret-token-value";
    try {
      await withDb(async (db) => {
        const collector = new TelemetryCollector(() => 1000);
        let seenAuth: string | undefined;
        const fetchImpl = (async (_url, init) => {
          seenAuth = (init as RequestInit).headers
            ? ((init as RequestInit).headers as Record<string, string>).authorization
            : undefined;
          return new Response(null, { status: 503 }); // fail, so an error gets persisted/logged
        }) as typeof fetch;
        const warnings: string[] = [];

        const result = await sendTelemetry({
          db,
          collector,
          endpoint: ENDPOINT,
          authTokenEnv: "OBTC_TEST_TELEMETRY_TOKEN",
          serverVersion: "test",
          facadeMode: "triad",
          now: () => 2000,
          fetchImpl,
          onWarn: (m) => warnings.push(m),
        });

        expect(seenAuth).toBe("Bearer super-secret-token-value");
        expect(result.ok).toBe(false);
        // The bearer value must never appear in a log line or the persisted error.
        expect(warnings.join("\n")).not.toContain("super-secret-token-value");
        expect(readTelemetryState(db)?.lastError).not.toContain("super-secret-token-value");
      });
    } finally {
      delete process.env.OBTC_TEST_TELEMETRY_TOKEN;
    }
  });

  it("with no authTokenEnv configured, sends no Authorization header", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      let sawAuthHeader = false;
      const fetchImpl = (async (_url, init) => {
        sawAuthHeader = "authorization" in ((init as RequestInit).headers as object);
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });

      expect(sawAuthHeader).toBe(false);
    });
  });

  it("logged/persisted errors always use the redacted endpoint form, never the raw URL", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(() => 1000);
      const warnings: string[] = [];
      const fetchImpl = (async () => new Response(null, { status: 500 })) as typeof fetch;

      await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
        onWarn: (m) => warnings.push(m),
      });

      expect(warnings.join("\n")).toContain(redactEndpoint(ENDPOINT));
      expect(warnings.join("\n")).not.toContain("user:pw");
      expect(warnings.join("\n")).not.toContain("key=abc");
      expect(readTelemetryState(db)?.lastError).not.toContain("user:pw");
    });
  });
});
