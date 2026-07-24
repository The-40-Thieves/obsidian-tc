// THE-222 — sleep-time half pins. Safety invariants first: born-ineligible rows are never
// raised, the judge can only lower (and a malformed response aborts the judge layer with the
// deterministic promotions standing), unstable ok/error clusters are held. Preference profile:
// typed deltas only (the ACE constraint) — add/strengthen/weaken/retract with weight counters,
// monotonic batch versions, retraction keeps the row at weight 0, and rows not named by a
// delta are untouched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  applyPreferenceDeltas,
  evaluateEpisodes,
  extractPreferences,
  preferenceProfile,
} from "../src/experiential/reflect";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    { version: "20260711_002", sql: sql("20260711_002_agent_episodes.sql") },
    { version: "20260712_001", sql: sql("20260712_001_preference_profile.sql") },
  ]);
  return db;
}

function seed(
  db: Database,
  id: string,
  over: Partial<{
    status: string;
    eligibility: string;
    args_hash: string | null;
    caller: string;
    tool: string;
    outcome: number | null;
    blocked: number;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, args_hash, outcome, eligibility, blocked, valid_from)
     VALUES (?, ?, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    NOW,
    over.caller ?? "alice",
    over.tool ?? "read_note",
    over.status ?? "ok",
    over.args_hash ?? null,
    over.outcome ?? null,
    over.eligibility ?? "pending",
    over.blocked ?? 0,
    NOW,
  );
}

function elig(db: Database, id: string): string {
  return (
    db.prepare("SELECT eligibility AS e FROM agent_episodes WHERE id = ?").get(id) as {
      e: string;
    }
  ).e;
}

describe("evaluateEpisodes (THE-222)", () => {
  it("promotes stable pending rows; never touches born-ineligible", async () => {
    const db = edb0();
    seed(db, "e1");
    seed(db, "e2", { status: "error" });
    seed(db, "poisoned", { eligibility: "ineligible" });
    const stats = await evaluateEpisodes(db, { nowMs: NOW + 1000 });
    expect(stats).toMatchObject({ scanned: 2, promoted: 2, held: 0, denied: 0, judged: 0 });
    expect(elig(db, "e1")).toBe("eligible");
    expect(elig(db, "e2")).toBe("eligible"); // errors are lessons too
    expect(elig(db, "poisoned")).toBe("ineligible"); // the invariant
  });

  it("holds a known-bad outcome (outcome=-1) but still promotes a plain error (THE-565)", async () => {
    const db = edb0();
    seed(db, "bad", { status: "ok", outcome: -1 }); // an explicit bad outcome: held
    seed(db, "err", { status: "error", outcome: null }); // a failed dispatch, no bad stamp: promoted
    seed(db, "neutral", { status: "ok", outcome: 0 }); // outcome recorded, not bad: promoted
    const stats = await evaluateEpisodes(db, { nowMs: NOW + 1000 });
    expect(stats).toMatchObject({ scanned: 3, promoted: 2, held: 1, denied: 0 });
    expect(elig(db, "bad")).toBe("pending"); // the THE-565 hardening
    expect(elig(db, "err")).toBe("eligible"); // "errors are lessons too" preserved
    expect(elig(db, "neutral")).toBe("eligible");
  });

  it("holds unstable ok/error clusters (cross-episode consistency, layer 2)", async () => {
    const db = edb0();
    seed(db, "u1", { args_hash: "h1", status: "ok" });
    seed(db, "u2", { args_hash: "h1", status: "error" });
    seed(db, "stable", { args_hash: "h2", status: "ok" });
    const stats = await evaluateEpisodes(db, { nowMs: NOW + 1000 });
    expect(stats.held).toBe(2);
    expect(stats.promoted).toBe(1);
    expect(elig(db, "u1")).toBe("pending");
    expect(elig(db, "u2")).toBe("pending");
    expect(elig(db, "stable")).toBe("eligible");
  });

  it("judge can only lower: hold -> pending, deny -> ineligible", async () => {
    const db = edb0();
    seed(db, "j1");
    seed(db, "j2");
    seed(db, "j3");
    const judge = async () => ({
      text: JSON.stringify({
        verdicts: [
          { id: "j1", verdict: "hold" },
          { id: "j2", verdict: "deny" },
          { id: "j3", verdict: "ok" },
        ],
      }),
      model: "mock",
    });
    const stats = await evaluateEpisodes(db, { nowMs: NOW + 1000, judge });
    expect(stats).toMatchObject({ judged: 3, promoted: 1, held: 1, denied: 1 });
    expect(elig(db, "j1")).toBe("pending");
    expect(elig(db, "j2")).toBe("ineligible");
    expect(elig(db, "j3")).toBe("eligible");
  });

  it("a malformed judge response aborts the layer; deterministic promotions stand", async () => {
    const db = edb0();
    seed(db, "k1");
    seed(db, "k2");
    const judge = async () => ({ text: "not json at all", model: "mock" });
    const stats = await evaluateEpisodes(db, { nowMs: NOW + 1000, judge });
    expect(stats.judgeAborted).toBe(true);
    expect(stats.promoted).toBe(2);
    expect(elig(db, "k1")).toBe("eligible");
    expect(elig(db, "k2")).toBe("eligible");
  });
});

describe("preference profile (ACE typed deltas)", () => {
  it("applies typed deltas with counters and monotonic versions; never wipes unnamed rows", () => {
    const db = edb0();
    const b1 = applyPreferenceDeltas(
      db,
      [
        { key: "prefers-tables", op: "add", value: "answers as tables", evidence: "e1" },
        { key: "dark-mode", op: "add", value: "dark themes" },
      ],
      NOW,
    );
    expect(b1).toEqual({ version: 1, applied: 2 });
    const b2 = applyPreferenceDeltas(
      db,
      [
        { key: "prefers-tables", op: "strengthen" },
        { key: "dark-mode", op: "weaken" },
      ],
      NOW + 10,
    );
    expect(b2.version).toBe(2);
    const p = preferenceProfile(db);
    expect(p.version).toBe(2);
    const tables = p.entries.find((e) => e.key === "prefers-tables");
    expect(tables?.weight).toBe(1.5);
    expect(tables?.value).toBe("answers as tables"); // value survived — no regeneration
    expect(p.entries.find((e) => e.key === "dark-mode")?.weight).toBe(0.5);
    // audit log has every delta
    const n = (db.prepare("SELECT COUNT(*) AS n FROM preference_deltas").get() as { n: number }).n;
    expect(n).toBe(4);
  });

  it("retract zeroes the weight but keeps the row; add on an existing key strengthens", () => {
    const db = edb0();
    applyPreferenceDeltas(db, [{ key: "k", op: "add", value: "v" }], NOW);
    applyPreferenceDeltas(db, [{ key: "k", op: "retract" }], NOW + 1);
    expect(preferenceProfile(db).entries).toHaveLength(0); // weight 0 filtered
    const raw = db.prepare("SELECT weight AS w FROM preference_profile WHERE key='k'").get() as {
      w: number;
    };
    expect(raw.w).toBe(0); // row survives retraction
    applyPreferenceDeltas(db, [{ key: "k", op: "add", value: "v2" }], NOW + 2);
    const back = preferenceProfile(db).entries.find((e) => e.key === "k");
    expect(back?.weight).toBe(0.5); // re-add climbs from the counter, not a fresh row
    expect(back?.value).toBe("v2");
  });

  it("does not log a phantom audit row for a delta on a non-existent key (C4)", () => {
    const db = edb0();
    const r = applyPreferenceDeltas(
      db,
      [
        { key: "never-added", op: "strengthen" },
        { key: "also-missing", op: "retract" },
      ],
      NOW,
    );
    expect(r.applied).toBe(0); // neither key exists -> nothing applied
    const n = (db.prepare("SELECT COUNT(*) AS n FROM preference_deltas").get() as { n: number }).n;
    expect(n).toBe(0); // and no phantom audit rows
  });

  it("extractPreferences: skipped without a judge; aborted on a parse failure applies nothing", async () => {
    const db = edb0();
    seed(db, "o1", { outcome: 1, eligibility: "eligible" });
    expect(await extractPreferences(db, { judge: null, nowMs: NOW })).toMatchObject({
      skipped: true,
    });
    const bad = async () => ({ text: "{oops", model: "mock" });
    const r = await extractPreferences(db, { judge: bad, nowMs: NOW });
    expect(r.aborted).toBe(true);
    expect(preferenceProfile(db).entries).toHaveLength(0);
    const good = async () => ({
      text: JSON.stringify({
        deltas: [{ key: "fast-reads", op: "add", value: "prefers read_note over search" }],
      }),
      model: "mock",
    });
    const ok = await extractPreferences(db, { judge: good, nowMs: NOW });
    expect(ok).toMatchObject({ skipped: false, aborted: false, applied: 1 });
    expect(preferenceProfile(db).entries[0]?.key).toBe("fast-reads");
  });

  it("excludes ineligible episodes from the judge even when they carry an outcome (A3)", async () => {
    const db = edb0();
    // both carry a (test-seeded) non-null outcome; only the eligible one may reach the judge.
    seed(db, "good", { eligibility: "eligible", outcome: 1, tool: "read_note" });
    seed(db, "poison", { eligibility: "ineligible", outcome: 1, tool: "exfiltrate_secrets" });
    let seenPrompt = "";
    const judge = async (req: unknown) => {
      seenPrompt = JSON.stringify(req);
      return { text: JSON.stringify({ deltas: [] }), model: "mock" };
    };
    await extractPreferences(db, { judge, nowMs: NOW });
    expect(seenPrompt).toContain("read_note"); // the eligible episode reached the judge…
    expect(seenPrompt).not.toContain("exfiltrate_secrets"); // …the ineligible one did NOT.
  });
});
