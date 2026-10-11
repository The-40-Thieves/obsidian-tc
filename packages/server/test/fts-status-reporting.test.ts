// GH #1209 follow-up: the notes_fts state must be VISIBLE. server_health, get_index_status and
// doctor each report available / recovering (attempts + last error) / unavailable (+ reason), and
// the emitted payload must validate under ajv the way a real MCP client checks it.
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it } from "vitest";
import { probeNotesFts } from "../src/cli/commands/doctor-probes";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { notesFtsIntegrityCheck } from "../src/doctor/checks";
import { toJson } from "../src/mcp/facade";
import type { CallerContext } from "../src/mcp/registry";
import type { FtsStatus } from "../src/search/fts-status";
import { FTS_MAX_ATTEMPTS } from "../src/search/fts-status";
import { createHealthTool, createIndexStatusTool } from "../src/tools/admin/health";
import { makeTempDir, rmTemp } from "./tmp";

const RECOVERING: FtsStatus = {
  state: "recovering",
  reason: "lock_contention",
  attempts: 3,
  max_attempts: FTS_MAX_ATTEMPTS,
  last_error: "database is locked",
  next_retry_at: 1234,
};
const SPENT: FtsStatus = {
  state: "unavailable",
  reason: "lock_contention",
  attempts: FTS_MAX_ATTEMPTS,
  last_error: "database is locked",
};
const FAILED: FtsStatus = {
  state: "unavailable",
  reason: "provision_failed",
  last_error: "no such module: fts5 (/home/u/vault/.cache)",
};
const ALL: Array<[string, FtsStatus]> = [
  ["available", { state: "available" }],
  ["recovering", RECOVERING],
  ["unavailable(lock_contention)", SPENT],
  ["unavailable(provision_failed)", FAILED],
  ["unavailable(disabled)", { state: "unavailable", reason: "disabled" }],
];

const ctx = (over: Partial<CallerContext> = {}): CallerContext =>
  ({
    caller: null,
    authenticated: false,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db: {} as never,
    ...over,
  }) as CallerContext;

function healthTool(status: FtsStatus) {
  return createHealthTool({
    version: "t",
    vaults: ["v1"],
    startedAt: 0,
    nativeLoaded: false,
    vecEnabled: false,
    getFtsStatus: () => status,
  });
}

/** The tools here are synchronous; the registry type admits a Promise, so narrow once. */
function call<T>(tool: { handler: unknown }, c: CallerContext): T {
  return (tool.handler as (input: unknown, c: CallerContext) => unknown)({}, c) as T;
}

function validatesUnderAjv(tool: { outputSchema?: unknown }, out: unknown): boolean {
  const schema = toJson(tool.outputSchema as never);
  const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
  return validate(JSON.parse(JSON.stringify(out))).valid;
}

describe("server_health reports the notes_fts state", () => {
  it.each(ALL)("%s: fts block present, fts_enabled consistent, valid under ajv", (_n, status) => {
    const tool = healthTool(status);
    const out = call<Record<string, unknown>>(tool, ctx({ authenticated: true }));
    expect(out.fts).toMatchObject({ state: status.state });
    expect(out.fts_enabled).toBe(status.state === "available");
    expect(validatesUnderAjv(tool, out)).toBe(true);
  });

  it("recovering carries attempts, max_attempts, and (for an entitled caller) the last error", () => {
    const out = call<{ fts: Record<string, unknown> }>(
      healthTool(RECOVERING),
      ctx({ authenticated: true }),
    );
    expect(out.fts).toEqual({
      state: "recovering",
      reason: "lock_contention",
      attempts: 3,
      max_attempts: FTS_MAX_ATTEMPTS,
      next_retry_at: 1234,
      last_error: "database is locked",
    });
  });

  it("withholds last_error (may name paths) from an unauthenticated caller but keeps the state", () => {
    const out = call<{ fts: Record<string, unknown> }>(healthTool(FAILED), ctx());
    expect(out.fts).toEqual({ state: "unavailable", reason: "provision_failed" });
  });

  it("a harness without getFtsStatus keeps the old shape (no fts block)", () => {
    const tool = createHealthTool({
      version: "t",
      vaults: [],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      ftsEnabled: true,
    });
    const out = call<Record<string, unknown>>(tool, ctx());
    expect(out.fts_enabled).toBe(true);
    expect("fts" in out).toBe(false);
  });
});

describe("get_index_status reports the notes_fts state", () => {
  it.each(ALL)("%s", (_n, status) => {
    const tool = createIndexStatusTool({
      vecEnabled: false,
      getFtsStatus: () => status,
      getIndexHealth: () => ({ reconcile: "ok", reconcile_at: 1, write_failures: 0 }),
      getLastChunksUpserted: () => null,
    });
    const out = call<{ fts_enabled: boolean; fts: { state: string } }>(tool, ctx());
    expect(out.fts.state).toBe(status.state);
    expect(out.fts_enabled).toBe(status.state === "available");
    expect(validatesUnderAjv(tool, out)).toBe(true);
  });
});

describe("doctor search.notes_fts check", () => {
  const run = (view: Parameters<typeof notesFtsIntegrityCheck>[0]) =>
    notesFtsIntegrityCheck(view).run({} as never);

  it("recovering is a warning that says it is transient and names the attempt", async () => {
    const r = await run({ ftsEnabled: false, status: RECOVERING });
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/RECOVERING.*attempt 3 of 10/);
    expect(r.details?.notes_fts).toMatch(/recovering \(lock_contention/);
  });

  it("spent retries read UNAVAILABLE and still point at the lock", async () => {
    const r = await run({ ftsEnabled: false, status: SPENT });
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/UNAVAILABLE.*locked/);
  });

  it("a non-transient failure is a distinct, loud warning carrying the real error", async () => {
    const r = await run({ ftsEnabled: false, status: FAILED });
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/FAILED \(provision_failed\).*not a lock/);
    expect(r.issues?.join(" ")).toContain("no such module: fts5");
  });

  it("deliberately off and available keep their existing wording", async () => {
    const off = await run({
      ftsEnabled: false,
      status: { state: "unavailable", reason: "disabled" },
    });
    expect(off.status).toBe("ok");
    expect(off.summary).toMatch(/off/);
    const ok = await run({ ftsEnabled: true, status: { state: "available" } });
    expect(ok.status).toBe("ok");
  });
});

describe("doctor --probe against a real locked cache.db", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmTemp(d);
  });

  it("reports the lock, not 'off', then available once it is released", async () => {
    const dir = makeTempDir("otc-fts-doctor-");
    dirs.push(dir);
    const path = join(dir, "cache.db");
    const seed = await openDatabase(path);
    provisionCacheDb(seed);
    seed.close?.();
    const holder = await openDatabase(path, 1000);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const locked = await probeNotesFts(dir, 50);
      expect(locked.ftsEnabled).toBe(false);
      expect(locked.status).toMatchObject({ state: "recovering", reason: "lock_contention" });
    } finally {
      holder.exec("ROLLBACK");
      holder.close?.();
    }
    const free = await probeNotesFts(dir, 50);
    expect(free).toMatchObject({ ftsEnabled: true, status: { state: "available" } });
  });
});
