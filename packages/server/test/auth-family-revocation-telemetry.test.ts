// GH #1477: reuse-driven OAuth family revocations (a replayed authorization code or refresh token
// kills the family, RFC 9700 section 4.14) were previously visible only in the process log. The
// telemetry is three parts, each tested below: the Prometheus counter and the durable event_log
// audit row the routes emit through `onFamilyRevoked` (never a code, token, verifier or hash), and
// the `auth.family-revocations` doctor check that reads those rows back over a 24h window.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAMILY_REVOKED_EVENT,
  type FamilyRevocationEvent,
  familyRevocationSink,
  readFamilyRevocations,
} from "../src/auth/family-revocation-telemetry";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  FAMILY_REVOCATION_WINDOW_HOURS,
  type FamilyRevocationsProbe,
  familyRevocationsCheck,
  probeFamilyRevocations,
} from "../src/doctor/family-revocations";
import { MetricsRecorder } from "../src/metrics/registry";
import {
  CLIENT_ID,
  CLIENT_REDIRECT,
  cleanupFlows,
  exchange,
  issue,
  Jar,
  makeFlow,
  obtainCode,
  pkce,
  refreshFields,
  revokeCall,
  tokenFields,
} from "./as-flow-harness";
import { asHttpFixture } from "./as-http-fixture";
import { ISSUER } from "./as-operator-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanupFlows();
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** Obtain a code, exchange it once (200), then replay the exchange; returns the replay response. */
async function replayFirstCode(flow: Parameters<typeof obtainCode>[0]) {
  const { verifier, challenge } = pkce();
  const { code } = await obtainCode(flow, new Jar(), challenge);
  const first = await exchange(flow, tokenFields(code, verifier));
  expect(first.res.status).toBe(200);
  return exchange(flow, tokenFields(code, verifier));
}
const event = (over: Partial<FamilyRevocationEvent> = {}): FamilyRevocationEvent => ({
  reason: "refresh_token_reuse",
  clientId: "client-1",
  accessTokens: 2,
  at: T0,
  ...over,
});

describe("familyRevocationSink: the counter and the audit row", () => {
  it("increments reliquary_tc_auth_family_revocations_total by reason", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const metrics = new MetricsRecorder();
    const sink = familyRevocationSink({ db, metrics });
    sink(event());
    sink(event({ reason: "authorization_code_reuse", clientId: "client-2", accessTokens: 1 }));
    const text = await metrics.metrics();
    expect(text).toContain(
      'reliquary_tc_auth_family_revocations_total{reason="refresh_token_reuse"} 1',
    );
    expect(text).toContain(
      'reliquary_tc_auth_family_revocations_total{reason="authorization_code_reuse"} 1',
    );
  });

  it("writes an event_log audit row with the reason and client_id and no secret material", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    familyRevocationSink({ db })(event());
    const row = db
      .prepare(
        `SELECT ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type
           FROM event_log WHERE event_type = ?`,
      )
      .get(FAMILY_REVOKED_EVENT) as Record<string, unknown>;
    expect(row).toEqual({
      ts: T0,
      vault_id: null,
      tool_name: null,
      caller: "client-1",
      duration_ms: null,
      result_size: 2,
      status: "ok",
      error_code: "refresh_token_reuse",
      args_hash: null,
      event_type: FAMILY_REVOKED_EVENT,
    });
  });

  it("a missing client id is recorded as NULL, not invented", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    familyRevocationSink({ db })(event({ clientId: null }));
    const row = db
      .prepare("SELECT caller FROM event_log WHERE event_type = ?")
      .get(FAMILY_REVOKED_EVENT) as { caller: unknown };
    expect(row.caller).toBeNull();
  });

  it("is fail-open: a broken audit store cannot break the revocation path, and the loss is counted", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const metrics = new MetricsRecorder();
    const sink = familyRevocationSink({ db, metrics });
    db.exec("DROP TABLE event_log");
    expect(() => sink(event())).not.toThrow();
    const text = await metrics.metrics();
    // The revocation itself is still counted...
    expect(text).toContain(
      'reliquary_tc_auth_family_revocations_total{reason="refresh_token_reuse"} 1',
    );
    // ...and the lost audit row has its own signal, the same one dispatch uses.
    expect(text).toContain("reliquary_tc_audit_write_failed_total");
  });
});

describe("the issuing routes report every family revocation", () => {
  it("a replayed authorization code reports authorization_code_reuse with the code's client", async () => {
    const events: FamilyRevocationEvent[] = [];
    const flow = await makeFlow({ onFamilyRevoked: (e) => events.push(e) });
    const replay = await replayFirstCode(flow);
    expect(replay.res.status).toBe(400);
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("authorization_code_reuse");
    expect(events[0]?.clientId).toBe(CLIENT_ID);
    expect(events[0]?.accessTokens).toBeGreaterThanOrEqual(1);
  });

  it("a refresh token reused past the grace window reports refresh_token_reuse", async () => {
    const events: FamilyRevocationEvent[] = [];
    const flow = await makeFlow({ onFamilyRevoked: (e) => events.push(e) });
    const a = await issue(flow);
    const b = await exchange(flow, refreshFields(a.refresh));
    expect(b.res.status).toBe(200);
    const c = await exchange(flow, refreshFields(b.body.refresh_token as string));
    expect(c.res.status).toBe(200);
    flow.clock.t += 31_000; // past the default 30 s reuse grace
    const replay = await exchange(flow, refreshFields(a.refresh));
    expect(replay.res.status).toBe(400);
    expect(events.map((e) => e.reason)).toEqual(["refresh_token_reuse"]);
    expect(events[0]?.clientId).toBe(CLIENT_ID);
  });

  it("a token minted under a replaced server secret reports refresh_token_foreign", async () => {
    const events: FamilyRevocationEvent[] = [];
    const flow = await makeFlow({ onFamilyRevoked: (e) => events.push(e) });
    const a = await issue(flow);
    const restarted = flow.restartWith("a-different-server-secret-for-this-test");
    const res = await exchange(restarted, refreshFields(a.refresh));
    expect(res.res.status).toBe(400);
    expect(events.map((e) => e.reason)).toEqual(["refresh_token_foreign"]);
  });

  it("a client revoking its own refresh token at /oauth/revoke reports revoked_by_client", async () => {
    const events: FamilyRevocationEvent[] = [];
    const flow = await makeFlow({ onFamilyRevoked: (e) => events.push(e) });
    const a = await issue(flow);
    const { res } = await revokeCall(flow, { token: a.refresh, client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    expect(events.map((e) => e.reason)).toEqual(["revoked_by_client"]);
    expect(events[0]?.clientId).toBe(CLIENT_ID);
  });

  it("an ordinary refusal (an unknown code) revokes nothing and reports nothing", async () => {
    const events: FamilyRevocationEvent[] = [];
    const flow = await makeFlow({ onFamilyRevoked: (e) => events.push(e) });
    const { verifier } = pkce();
    const res = await exchange(flow, tokenFields("no-such-code", verifier));
    expect(res.res.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});

describe("createHttpApp wires the sink into the AS routes", () => {
  it("a code replay over the real app increments the recorder and writes the audit row", async () => {
    const metrics = new MetricsRecorder();
    const fx = await asHttpFixture({
      tempPrefix: "family-revocation-wiring-",
      as: {
        clients: [{ clientId: CLIENT_ID, name: "Test Client", redirectUris: [CLIENT_REDIRECT] }],
      },
      rotateAsKey: true,
      metrics,
    });
    dirs.push(fx.dir);
    try {
      const flow = { app: fx.handle.app, url: fx.url, issuer: ISSUER } as never;
      const replay = await replayFirstCode(flow);
      expect(replay.res.status).toBe(400);
      const text = await metrics.metrics();
      expect(text).toContain(
        'reliquary_tc_auth_family_revocations_total{reason="authorization_code_reuse"} 1',
      );
      const row = fx.cacheDb
        .prepare("SELECT caller, error_code, result_size FROM event_log WHERE event_type = ?")
        .get(FAMILY_REVOKED_EVENT) as
        | { caller: string; error_code: string; result_size: number }
        | undefined;
      expect(row).toMatchObject({ caller: CLIENT_ID, error_code: "authorization_code_reuse" });
      expect(row?.result_size).toBeGreaterThanOrEqual(1);
    } finally {
      await fx.handle.close();
    }
  });
});

describe("readFamilyRevocations: the 24h window over event_log", () => {
  it("counts by reason, reports the latest, and ignores older rows and other event types", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const sink = familyRevocationSink({ db });
    sink(event({ reason: "authorization_code_reuse", at: T0 - 60_000 }));
    sink(
      event({ reason: "refresh_token_reuse", at: T0 - 30_000, clientId: null, accessTokens: 0 }),
    );
    sink(event({ reason: "revoked_by_client", at: T0 - 25 * 3_600_000 })); // outside the window
    db.prepare(
      "INSERT INTO event_log (ts, status, event_type) VALUES (?, 'ok', 'tool_invocation')",
    ).run(T0 - 1000);
    const stats = readFamilyRevocations(db, { sinceMs: T0 - 24 * 3_600_000 });
    expect(stats.total).toBe(2);
    expect(stats.byReason).toEqual({ authorization_code_reuse: 1, refresh_token_reuse: 1 });
    expect(stats.latest).toEqual({
      ts: T0 - 30_000,
      reason: "refresh_token_reuse",
      clientId: null,
      accessTokens: 0,
    });
  });
});

describe("probeFamilyRevocations: the doctor --probe reader", () => {
  it("a missing cache.db is an empty report, not an error", async () => {
    const dir = makeTempDir("family-revocation-probe-");
    dirs.push(dir);
    const probe = await probeFamilyRevocations(dir, 1000, {
      windowHours: FAMILY_REVOCATION_WINDOW_HOURS,
      now: T0,
    });
    expect(probe).toEqual({ total: 0, byReason: {} });
  });

  it("reads back what the sink wrote", async () => {
    const dir = makeTempDir("family-revocation-probe-");
    dirs.push(dir);
    const db = await openDatabase(`${dir}/cache.db`, 1000);
    try {
      provisionCacheDb(db);
      familyRevocationSink({ db })(event({ at: T0 - 1000 }));
    } finally {
      db.close?.();
    }
    const probe = await probeFamilyRevocations(dir, 1000, {
      windowHours: FAMILY_REVOCATION_WINDOW_HOURS,
      now: T0,
    });
    expect(probe.error).toBeUndefined();
    expect(probe.total).toBe(1);
    expect(probe.latest?.reason).toBe("refresh_token_reuse");
  });

  it("a cache.db without the audit table reports an error, never a silent zero", async () => {
    const dir = makeTempDir("family-revocation-probe-");
    dirs.push(dir);
    const db = await openDatabase(`${dir}/cache.db`, 1000);
    try {
      db.exec("CREATE TABLE unrelated (id INTEGER)");
    } finally {
      db.close?.();
    }
    const probe = await probeFamilyRevocations(dir, 1000, {
      windowHours: FAMILY_REVOCATION_WINDOW_HOURS,
      now: T0,
    });
    expect(probe.total).toBe(0);
    expect(probe.error).toBeDefined();
  });
});

describe("auth.family-revocations: the doctor check", () => {
  const run = async (probe?: () => FamilyRevocationsProbe) =>
    familyRevocationsCheck({
      windowHours: FAMILY_REVOCATION_WINDOW_HOURS,
      ...(probe ? { probe } : {}),
    }).run({ serverVersion: "t" });

  it("without --probe it says so and stays ok", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("--probe");
  });

  it("an unreadable event_log is a warning, never a silent zero", async () => {
    const r = await run(() => ({ total: 0, byReason: {}, error: "no such table: event_log" }));
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("no such table");
  });

  it("no revocations in the window is ok", async () => {
    const r = await run(() => ({ total: 0, byReason: {} }));
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("no OAuth family revocations");
  });

  it("operator- and client-initiated revocations alone stay ok and are still reported", async () => {
    const r = await run(() => ({
      total: 2,
      byReason: { revoked_by_client: 2 },
      latest: { ts: T0, reason: "revoked_by_client", clientId: "client-1", accessTokens: 1 },
    }));
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("2");
    expect(JSON.stringify(r.details)).toContain("revoked_by_client");
  });

  it("a reuse-driven revocation is a warning that names the count, the latest reason and its client", async () => {
    const r = await run(() => ({
      total: 3,
      byReason: { refresh_token_reuse: 2, revoked_by_client: 1 },
      latest: { ts: T0, reason: "refresh_token_reuse", clientId: "client-1", accessTokens: 4 },
    }));
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("2");
    expect(r.issues?.join("\n")).toContain("refresh_token_reuse");
    expect(r.issues?.join("\n")).toContain("client-1");
  });
});
