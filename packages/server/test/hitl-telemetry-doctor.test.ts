import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "../src/capability";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  HEADLESS_MIN_TOKEN_APPROVALS,
  hitlConfirmationsCheck,
  probeHitlConfirmations,
} from "../src/doctor/hitl-confirmations";
import { assembleDoctorReport } from "../src/doctor/run";
import {
  type HitlOutcome,
  type HitlSource,
  readHitlConfirmationStats,
  recordHitlOutcome,
} from "../src/hitl-telemetry";
import type { CallerContext } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const NOW = 50_000_000_000;
const TTL_MS = 300_000;
const ctxOf = (db: unknown, client = "claude-code") =>
  ({
    db,
    vaultId: "v1",
    caller: "stdio",
    clientInfo: { name: client },
  }) as unknown as CallerContext;

function rec(
  db: unknown,
  tool: string,
  outcome: HitlOutcome,
  source: HitlSource,
  n = 1,
  opts: { client?: string; at?: number; hash?: string } = {},
) {
  for (let i = 0; i < n; i++) {
    recordHitlOutcome(
      ctxOf(db, opts.client),
      { tool, argsHash: opts.hash ?? `${tool}-${outcome}-${i}`, outcome, source },
      () => opts.at ?? NOW - 1000,
    );
  }
}

function seeded() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  rec(db, "write_note", "accept", "form", 6);
  rec(db, "write_note", "decline", "form", 2);
  rec(db, "write_note", "cancel", "request_state", 1);
  rec(db, "delete_note", "accept", "token", 6, { client: "headless-agent" });
  rec(db, "delete_note", "accept", "form", 1);
  rec(db, "move_note", "accept", "token", HEADLESS_MIN_TOKEN_APPROVALS - 1);
  return db;
}

const stats = (db: unknown) =>
  readHitlConfirmationStats(db as never, { sinceMs: 0, nowMs: NOW, ttlMs: TTL_MS });
const run = (probe?: () => { tools: ReturnType<typeof stats>; error?: string }) =>
  hitlConfirmationsCheck({ windowDays: 7, ...(probe ? { probe } : {}) }).run({
    serverVersion: "test",
  });

describe("hitl.confirmations", () => {
  it("shows per-tool counts and acceptance rate", async () => {
    const r = await run(() => ({ tools: stats(seeded()) }));
    expect(r.details).toMatchObject({
      window: "7d",
      confirmations: "20",
      "tool.write_note": "accept=6 decline=2 cancel=1 timeout=0 acceptRate=67% tokenApprovals=0",
      "tool.delete_note": "accept=7 decline=0 cancel=0 timeout=0 acceptRate=100% tokenApprovals=6",
      "tool.move_note": "accept=4 decline=0 cancel=0 timeout=0 acceptRate=100% tokenApprovals=4",
    });
    // 17 of 20 outcomes were accepts
    expect(r.details?.acceptRate).toBe("85%");
  });

  it("flags a tool mostly approved by headless token, naming the client, and only that tool", async () => {
    const r = await run(() => ({ tools: stats(seeded()) }));
    expect(r.status).toBe("warning");
    expect(r.issues).toHaveLength(1);
    expect(r.issues?.[0]).toContain("delete_note");
    expect(r.issues?.[0]).toContain("headless-agent x6");
    // move_note is all-token but below the count floor; write_note has no tokens.
    expect(r.issues?.join(" ")).not.toContain("move_note");
    expect(r.remediation).toContain("never changes a confirmation requirement");
  });

  it("does not flag many token approvals that are a small share of the accepts", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    rec(db, "write_note", "accept", "token", 6);
    rec(db, "write_note", "accept", "form", 30);
    const r = await run(() => ({ tools: stats(db) }));
    expect(r.status).toBe("ok");
  });

  it("counts an unanswered offer past the TTL as a timeout", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    rec(db, "write_note", "offered", "form", 2, { at: NOW - 2 * TTL_MS });
    rec(db, "write_note", "accept", "form", 1, { at: NOW - 1000 });
    const r = await run(() => ({ tools: stats(db) }));
    expect(r.details?.["tool.write_note"]).toBe(
      "accept=1 decline=0 cancel=0 timeout=2 acceptRate=33% tokenApprovals=0",
    );
  });

  it("is ok and says so when nothing was recorded, and never FAILs", async () => {
    const empty = await run(() => ({ tools: [] }));
    expect(empty.status).toBe("ok");
    expect(empty.summary).toContain("no confirmation outcomes");
    const notProbed = await run();
    expect(notProbed.status).toBe("ok");
    expect(notProbed.summary).toContain("not probed");
  });

  it("an unreadable event_log is a warning, not 'no outcomes'", async () => {
    const r = await run(() => ({ tools: [], error: "database is locked" }));
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("database is locked");
  });

  it("carries no content: only tool names, counts and sanitized client names reach the report", async () => {
    const r = await run(() => ({ tools: stats(seeded()) }));
    const text = JSON.stringify(r);
    expect(text).not.toContain("write_note-accept-0"); // an args_hash
    expect(text).not.toContain("stdio"); // a caller
  });

  it("is part of the assembled report under its stable id", async () => {
    const profile: CapabilityProfile = {
      serverVersion: "1.10.0",
      runtime: { name: "bun", version: "1.3.14", nativeModule: true },
      obsidian: { registryPath: null, installed: false, vaults: [] },
      hardware: {
        platform: "linux",
        arch: "arm64",
        cpuCount: 4,
        totalMemMb: 24000,
        hasGpu: false,
        gpus: [],
      },
    };
    const report = await assembleDoctorReport({
      config: {
        auth: { mode: "jwt" as const, tokenTtlSeconds: 86400, readOnly: false },
        hitlConfirmations: { windowDays: 7, probe: () => ({ tools: stats(seeded()) }) },
      },
      profile,
      now: () => "2026-09-30T00:00:00.000Z",
    });
    expect(report.checks["hitl.confirmations"]?.status).toBe("warning");
    expect(report.checks["hitl.confirmations"]?.category).toBe("security");
  });
});

describe("probeHitlConfirmations (real cache.db)", () => {
  it("reads the window from disk; older rows and a missing db are handled", async () => {
    const dir = makeTempDir("obtc-hitl-probe-");
    try {
      expect(await probeHitlConfirmations(dir, 5000, { windowDays: 7, ttlSeconds: 300 })).toEqual({
        tools: [],
      });
      const db = await openDatabase(join(dir, "cache.db"), 5000);
      provisionCacheDb(db, { version: "test" });
      const now = Date.now();
      rec(db, "write_note", "accept", "form", 2, { at: now - 1000 });
      rec(db, "write_note", "accept", "form", 3, { at: now - 30 * 86_400_000 });
      db.close?.();
      const probed = await probeHitlConfirmations(dir, 5000, {
        windowDays: 7,
        ttlSeconds: 300,
        now,
      });
      expect(probed.error).toBeUndefined();
      expect(probed.tools).toHaveLength(1);
      expect(probed.tools[0]).toMatchObject({ tool: "write_note", accept: 2 });
    } finally {
      rmTemp(dir);
    }
  });
});
