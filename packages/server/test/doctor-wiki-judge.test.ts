// wiki.judge doctor check: configured / default-on / model / today's calls, from config plus the
// judge's own rows in cache.db. Offline and read-only. The probe test drives a real cache.db that a
// real judge instance wrote, so the numbers doctor shows are the numbers the caps enforce.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeWikiJudge } from "../src/cli/commands/doctor-probes";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { type WikiJudgeView, wikiJudgeCheck } from "../src/doctor/wiki-judge";
import type { GatewayRoles } from "../src/plane/gateway";
import { createWikiJudge, DEFAULT_WIKI_JUDGE_SETTINGS } from "../src/tools/m7/knowledge/wiki-judge";
import { makeTempDir } from "./tmp";

const ctx = { serverVersion: "test" };
const base: WikiJudgeView = {
  gatewayConfigured: true,
  enabled: true,
  sweepJudges: false,
  maxCallsPerDay: 200,
  maxCallsPerRequest: 3,
  timeoutMs: 15000,
  model: "openai:gpt-test-a",
  callsToday: 12,
  failuresToday: 1,
  cachedVerdicts: 40,
};
const run = (over: Partial<WikiJudgeView> = {}) => wikiJudgeCheck({ ...base, ...over }).run(ctx);

describe("wiki.judge doctor check", () => {
  it("reports model and today's use when configured and on", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.summary).toBe(
      "wiki judge: on by default, 12/200 calls today, model openai:gpt-test-a",
    );
    expect(r.details).toMatchObject({
      configured: "true",
      defaultOn: "true",
      model: "openai:gpt-test-a",
      callsToday: "12/200",
      failuresToday: "1",
      cachedVerdicts: "40",
    });
  });

  it("says off-by-default when the gateway is there but the config is not on", async () => {
    const r = await run({ enabled: false, model: null, callsToday: 0 });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("available (off by default; judge=true opts in)");
    expect(r.summary).toContain("model none yet");
    expect(r.details).toMatchObject({ defaultOn: "false" });
  });

  it("is ok and explicit without a gateway; notes a stranded enabled flag", async () => {
    const quiet = await run({ gatewayConfigured: false, enabled: false });
    expect(quiet.status).toBe("ok");
    expect(quiet.summary).toContain("not configured");
    expect(quiet.details).toMatchObject({ defaultOn: "false" });
    const stranded = await run({ gatewayConfigured: false, enabled: true });
    expect(stranded.notes?.join(" ")).toContain("needs a gateway");
    expect(stranded.details).toMatchObject({ defaultOn: "false" });
  });

  it("warns when the daily cap is reached", async () => {
    const r = await run({ callsToday: 200 });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("daily cap reached");
    expect(r.remediation).toContain("maxCallsPerDay");
  });

  it("warns when most of today's calls failed, but not on a handful", async () => {
    expect((await run({ callsToday: 10, failuresToday: 8 })).status).toBe("warning");
    expect((await run({ callsToday: 3, failuresToday: 3 })).status).toBe("ok");
    expect((await run({ callsToday: 10, failuresToday: 5 })).status).toBe("ok");
  });

  it("a cap of 0 is reported as disabled", async () => {
    const r = await run({ maxCallsPerDay: 0, callsToday: 0 });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("disabled");
  });

  it("an unreadable cache.db is a warning, not a failure", async () => {
    const r = await run({ unreadable: "database disk image is malformed" });
    expect(r.status).toBe("warning");
    expect(r.issues).toContain("database disk image is malformed");
  });
});

describe("probeWikiJudge: a real cache.db", () => {
  const configured = {
    gatewayConfigured: true,
    enabled: true,
    sweepJudges: true,
    maxCallsPerDay: 5,
    maxCallsPerRequest: 3,
    timeoutMs: 1000,
  };

  it("zeros when cache.db does not exist or has never judged", async () => {
    const dir = makeTempDir("obtc-wjdoctor-");
    try {
      expect(await probeWikiJudge(dir, 5000, configured)).toMatchObject({
        model: null,
        callsToday: 0,
        cachedVerdicts: 0,
      });
      const db = await openDatabase(join(dir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      db.close?.();
      expect(await probeWikiJudge(dir, 5000, configured)).toMatchObject({
        model: null,
        callsToday: 0,
        cachedVerdicts: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads exactly what the judge recorded: resolved model, calls, failures, cached verdicts", async () => {
    const dir = makeTempDir("obtc-wjdoctor-");
    try {
      const db = await openDatabase(join(dir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      let n = 0;
      const roles = {
        judge: async () => ({
          text: ++n === 2 ? "garbage" : '{"verdict":"different","rationale":"r"}',
          model: "openai:gpt-test-a",
        }),
      } as unknown as GatewayRoles;
      const j = createWikiJudge({
        roles,
        db,
        settings: { ...DEFAULT_WIKI_JUDGE_SETTINGS, enabled: true, timeoutMs: 1000 },
      });
      const note = (i: number) => ({
        path: `n${i}.md`,
        title: `n${i}`,
        text: "t",
        hash: String(i).padStart(64, "0"),
      });
      for (let i = 1; i <= 3; i++) await j.judgeTopic("topic", note(i), j.newBudget());
      db.close?.();
      const view = await probeWikiJudge(dir, 5000, configured);
      expect(view).toMatchObject({
        model: "openai:gpt-test-a",
        callsToday: 3,
        failuresToday: 1,
        cachedVerdicts: 2,
        gatewayConfigured: true,
      });
      expect(view.unreadable).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
