// THE-1125 — sendTelemetry: the one network call opt-in telemetry ever makes. Real cache.db per
// test (mkdtempSync, mirroring doctor-db-space.test.ts), spied `fetch`.
//
// CI fix (windows-latest, build-test): `rmSync` used to run while the SQLite handle was still
// open — Windows refuses to delete a file with an open handle (EPERM), unlike POSIX, which lets
// you unlink one happily. `db` is now closed BEFORE cleanup, and cleanup itself uses `rmTemp`
// (test/tmp.ts) — Node's own EBUSY/EPERM retry, the repo's existing backstop for a handle that
// takes a moment longer to release (see that file's own header for the full incident shape).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { TelemetryCollector } from "../src/telemetry/collector";
import { redactEndpoint } from "../src/telemetry/redact-endpoint";
import { sendTelemetry } from "../src/telemetry/sender";
import { readTelemetryState } from "../src/telemetry/state";
import { rmTemp } from "./tmp";

async function withDb(fn: (db: Awaited<ReturnType<typeof openDatabase>>) => Promise<void> | void) {
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-telemetry-sender-"));
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(join(cacheDir, "cache.db"), 5000);
    provisionCacheDb(db, { version: "test" });
    await fn(db);
  } finally {
    db?.close?.();
    rmTemp(cacheDir);
  }
}

const ENDPOINT = "https://user:pw@collector.example/ingest?key=abc";

describe("sendTelemetry", () => {
  it("on success: resets the collector, records lastSendAt, returns ok:true", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(
        () => new Set(["search_text"]),
        () => 1000,
      );
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
      const collector = new TelemetryCollector(
        () => new Set(["search_text"]),
        () => 1000,
      );
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
      const collector = new TelemetryCollector(
        () => new Set(["search_text"]),
        () => 1000,
      );
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
      const collector = new TelemetryCollector(undefined, () => 1000);
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
      const collector = new TelemetryCollector(undefined, () => 1000);
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
        const collector = new TelemetryCollector(undefined, () => 1000);
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
      const collector = new TelemetryCollector(undefined, () => 1000);
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
      const collector = new TelemetryCollector(undefined, () => 1000);
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

  // Security review (grok HIGH-2): a response body is never read, but it MUST be actively
  // cancelled — an unconsumed body can hold the underlying connection open indefinitely even
  // after `fetch()` itself has resolved with a Response.
  it("cancels the response body and resolves promptly even when it never ends", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(undefined, () => 1000);
      let cancelCalled = false;
      const neverEndingBody = new ReadableStream({
        start() {
          /* never enqueues, never closes — a body that streams forever */
        },
        cancel() {
          cancelCalled = true;
        },
      });
      const fetchImpl = (async () =>
        new Response(neverEndingBody, { status: 200 })) as typeof fetch;

      const start = Date.now();
      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
      });
      const elapsedMs = Date.now() - start;

      expect(result.ok).toBe(true);
      expect(cancelCalled).toBe(true);
      // Resolves promptly (cancel() on a controller-based stream is near-instant) — nowhere near
      // the 10s send timeout, proving the send did not have to wait out the whole body.
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  it("passes an AbortSignal to fetch that bounds the whole send, not merely the header wait", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(undefined, () => 1000);
      let sawSignal: AbortSignal | undefined;
      const fetchImpl = (async (_url, init) => {
        sawSignal = (init as RequestInit).signal ?? undefined;
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

      expect(sawSignal).toBeInstanceOf(AbortSignal);
      expect(sawSignal?.aborted).toBe(false);
    });
  });

  // Security review (in-pool HIGH-A): a document-build failure must reset the collector (so a
  // poisoned entry cannot wedge every future tick into the same failure) and must never persist
  // the raw failure text — a fixed short code only.
  it("on a document-build failure: resets the collector and records a FIXED short code, never a raw message", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(undefined, () => 1000);
      collector.recordToolCall("search_text");
      // Force a build failure without depending on any particular invalid-input shape: an
      // installId that is not a UUID (state.ts's own invariant, simulated here by corrupting the
      // row directly) makes buildTelemetryDocument's own `.parse()` throw.
      db.prepare(
        "INSERT INTO telemetry_state (id, install_id, last_send_at, last_error, created_at) VALUES (1, 'not-a-uuid', NULL, NULL, 0)",
      ).run();
      const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;

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
      expect(result.error).toBe("document_build_failed");
      expect(readTelemetryState(db)?.lastError).toBe("document_build_failed");
      // Reset happened — the poisoned window is cleared, so the NEXT tick starts clean rather
      // than repeating the same failure forever.
      expect(collector.snapshot().toolCalls).toEqual({});
    });
  });

  it("3 ticks after a poisoned entry still attempt 3 sends (never gets stuck)", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(undefined, () => 1000);
      db.prepare(
        "INSERT INTO telemetry_state (id, install_id, last_send_at, last_error, created_at) VALUES (1, 'not-a-uuid', NULL, NULL, 0)",
      ).run();
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      const send = () =>
        sendTelemetry({
          db,
          collector,
          endpoint: ENDPOINT,
          serverVersion: "test",
          facadeMode: "triad",
          now: () => 2000,
          fetchImpl,
        });

      // First tick fails closed on the poisoned row and clears it (reset persists nothing that
      // re-triggers the same failure).
      const first = await send();
      expect(first.ok).toBe(false);
      db.prepare("UPDATE telemetry_state SET install_id = ? WHERE id = 1").run(
        "3b9e1a2c-4b1e-4a2f-9c3d-1e2f3a4b5c6d",
      );
      const second = await send();
      const third = await send();
      expect(second.ok).toBe(true);
      expect(third.ok).toBe(true);
      expect(calls).toBe(2); // the poisoned first tick never reached fetch at all
    });
  });

  // Security review (in-pool LOW-G): authTokenEnv is CONFIGURED but the env var is unset — refuse
  // rather than send unauthenticated.
  it("refuses to send when authTokenEnv is set but the env var resolves to nothing", async () => {
    await withDb(async (db) => {
      const collector = new TelemetryCollector(undefined, () => 1000);
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      const warnings: string[] = [];

      const result = await sendTelemetry({
        db,
        collector,
        endpoint: ENDPOINT,
        authTokenEnv: "OBTC_TEST_TELEMETRY_TOKEN_DEFINITELY_UNSET",
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 2000,
        fetchImpl,
        onWarn: (m) => warnings.push(m),
      });

      expect(calls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("auth_token_env_unset");
      expect(warnings.join("\n")).toContain("OBTC_TEST_TELEMETRY_TOKEN_DEFINITELY_UNSET");
      expect(readTelemetryState(db)?.lastError).toBe("auth_token_env_unset");
    });
  });

  // Security review (grok LOW-4): scrubEndpointFromMessage protected the endpoint, but not a
  // bearer token an error message might also echo back.
  it("scrubs the bearer token value out of a logged/persisted transport-error message", async () => {
    process.env.OBTC_TEST_SCRUB_TOKEN = "super-secret-token-value";
    try {
      await withDb(async (db) => {
        const collector = new TelemetryCollector(undefined, () => 1000);
        const fetchImpl = (async () => {
          throw new TypeError(
            "fetch failed: Authorization: Bearer super-secret-token-value was rejected",
          );
        }) as typeof fetch;
        const warnings: string[] = [];

        const result = await sendTelemetry({
          db,
          collector,
          endpoint: ENDPOINT,
          authTokenEnv: "OBTC_TEST_SCRUB_TOKEN",
          serverVersion: "test",
          facadeMode: "triad",
          now: () => 2000,
          fetchImpl,
          onWarn: (m) => warnings.push(m),
        });

        expect(result.ok).toBe(false);
        expect(result.error).not.toContain("super-secret-token-value");
        expect(warnings.join("\n")).not.toContain("super-secret-token-value");
        expect(readTelemetryState(db)?.lastError).not.toContain("super-secret-token-value");
      });
    } finally {
      delete process.env.OBTC_TEST_SCRUB_TOKEN;
    }
  });
});
