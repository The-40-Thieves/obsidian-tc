// THE-222 — sleep-time half pins. Safety invariants first: born-ineligible rows are never raised,
// unstable ok/error clusters are held, and (THE-701) a plain error PROMOTES — errors are lessons
// too. The judge layer was removed after measurement; see reflect.ts's header. Preference profile:
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
  ELIGIBILITY_POLICY_VERSION,
  evaluateEpisodes,
  extractPreferences,
  filterRegisteredDeltas,
  groupEpisodesByVerdictWindow,
  PREFERENCE_KEYS,
  type PreferenceDelta,
  preferenceProfile,
} from "../src/experiential/reflect";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");
const NOW = 1_700_000_000_000;
/** THE-710: the preference plane is partitioned by vault; these are the two test partitions. */
const V1 = "vault-one";
const V2 = "vault-two";

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    { version: "20260711_002", sql: sql("20260711_002_agent_episodes.sql") },
    // THE-718: the `outcome` column this fixture seeds was renamed to `task_result`
    // (20260806_003). That migration touches only agent_episodes, so it composes onto this prefix
    // without dragging in the rest of the chain.
    {
      version: "20260806_003",
      sql: sql("20260806_003_agent_episodes_task_result.sql"),
    },
    // THE-746: eligibility_reason / eligibility_policy. Also agent_episodes-only, so it composes
    // onto this prefix the same way.
    {
      version: "20260806_006",
      sql: sql("20260806_006_episode_eligibility_reason.sql"),
    },
    // THE-726: verdict_at. extractPreferences now SELECTs it — it is half the window identity
    // (session_id, verdict_at) that tells the extractor which rows carry one judgement rather than
    // N. agent_episodes-only, so it composes onto this prefix like the two above.
    {
      version: "20260816_002",
      sql: sql("20260816_002_episode_verdict_at.sql"),
    },
    { version: "20260712_001", sql: sql("20260712_001_preference_profile.sql") },
    // THE-710: the vault partition. Included here rather than in a separate fixture so every
    // existing assertion below runs against the PARTITIONED schema, not the pre-migration one.
    { version: "20260803_001", sql: sql("20260803_001_preference_vault_id.sql") },
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
    task_result: number | null;
    blocked: number;
    vault_id: string | null;
    // THE-673: the window identity a mixed-verdict fixture needs to exercise
    // groupEpisodesByVerdictWindow. Left undefined (-> NULL) by every pre-existing caller, which
    // keeps each of those rows its own one-row window, same as before THE-726 added the columns.
    session_id: string | null;
    verdict_at: number | null;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, args_hash, task_result, eligibility, blocked, valid_from, vault_id, session_id, verdict_at)
     VALUES (?, ?, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    NOW,
    over.caller ?? "alice",
    over.tool ?? "read_note",
    over.status ?? "ok",
    over.args_hash ?? null,
    over.task_result ?? null,
    over.eligibility ?? "pending",
    over.blocked ?? 0,
    NOW,
    // THE-710: `vault_id` is nullable on agent_episodes, and extractPreferences EXCLUDES nulls
    // rather than attributing them. Pass `null` explicitly to exercise that exclusion.
    over.vault_id === undefined ? V1 : over.vault_id,
    over.session_id ?? null,
    over.verdict_at ?? null,
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
    expect(stats).toMatchObject({ scanned: 2, promoted: 2, held: 0, denied: 0 });
    expect(elig(db, "e1")).toBe("eligible");
    expect(elig(db, "e2")).toBe("eligible"); // errors are lessons too
    expect(elig(db, "poisoned")).toBe("ineligible"); // the invariant
  });

  // THE-746. Before this, the ONLY way to learn which rule produced a verdict was to diff two
  // hand-made copies of the database — that is literally how THE-672's 337-episode measurement was
  // obtained. These assert the reason is in-band, that a HELD row records one too (it keeps
  // eligibility 'pending', so without a reason "never evaluated" and "evaluated and held" are
  // indistinguishable), and that the precedence between two simultaneously-true hold rules is
  // pinned rather than incidental.
  it("records a per-decision reason and the policy version (THE-746)", async () => {
    const db = edb0();
    seed(db, "good", { status: "ok", task_result: null });
    seed(db, "bad", { status: "ok", task_result: -1 });
    await evaluateEpisodes(db, { nowMs: NOW + 1000 });

    const row = (id: string) =>
      db
        .prepare(
          "SELECT eligibility, eligibility_reason, eligibility_policy FROM agent_episodes WHERE id = ?",
        )
        .get(id) as {
        eligibility: string;
        eligibility_reason: string | null;
        eligibility_policy: number | null;
      };

    expect(row("good")).toMatchObject({
      eligibility: "eligible",
      eligibility_reason: "promoted_stable",
      eligibility_policy: ELIGIBILITY_POLICY_VERSION,
    });
    // The held row stays pending — being held is the ABSENCE of a state change — but it is no
    // longer silent about why.
    expect(row("bad")).toMatchObject({
      eligibility: "pending",
      eligibility_reason: "held_bad_task_result",
      eligibility_policy: ELIGIBILITY_POLICY_VERSION,
    });
  });

  it("a row that is BOTH unstable and bad reports instability, stably (THE-746 precedence)", async () => {
    const db = edb0();
    // Same caller+tool+args_hash showing ok AND error makes the cluster unstable; the ok row also
    // carries task_result = -1, so both hold rules fire on it at once.
    seed(db, "u-ok", { status: "ok", args_hash: "h1", tool: "t", task_result: -1 });
    seed(db, "u-err", { status: "error", args_hash: "h1", tool: "t", task_result: null });
    await evaluateEpisodes(db, { nowMs: NOW + 1000 });
    const reason = (id: string) =>
      (
        db.prepare("SELECT eligibility_reason AS r FROM agent_episodes WHERE id = ?").get(id) as {
          r: string | null;
        }
      ).r;
    // Instability wins: it is a property of the EVIDENCE SET, the wider fact, and task_result is
    // still recoverable from the row's own column. An audit whose reason flips between runs on
    // identical data would be worse than no audit, so this precedence is pinned deliberately.
    expect(reason("u-ok")).toBe("held_unstable_evidence");
    expect(reason("u-err")).toBe("held_unstable_evidence");
  });

  it("holds a known-bad task_result (-1) but still promotes a plain error (THE-565)", async () => {
    const db = edb0();
    seed(db, "bad", { status: "ok", task_result: -1 }); // an explicit bad result: held
    seed(db, "err", { status: "error", task_result: null }); // a failed dispatch, no bad stamp: promoted
    seed(db, "neutral", { status: "ok", task_result: 0 }); // result recorded, not bad: promoted
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

  // THE-701. The test above pins that a born-ineligible row STAYS ineligible. This pins the
  // complement, which it does not: that no PENDING row is ever lowered INTO that state. Those are
  // different properties — the removed judge satisfied the first while violating the second on 35
  // rows, so a test asserting only "the poisoned row is still poisoned" would have passed
  // throughout. 'ineligible' is now reachable solely from assessPoison at capture time.
  it("the pass denies NOTHING — 'ineligible' is only ever set at capture", async () => {
    const db = edb0();
    seed(db, "p1", { status: "error" });
    seed(db, "p2", { status: "ok" });
    seed(db, "p3", { eligibility: "ineligible" });
    const stats = await evaluateEpisodes(db, { nowMs: NOW + 1000 });
    expect(stats.denied).toBe(0);
    expect(elig(db, "p3")).toBe("ineligible");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM agent_episodes WHERE eligibility = 'ineligible'")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});

describe("preference profile (ACE typed deltas)", () => {
  it("applies typed deltas with counters and monotonic versions; never wipes unnamed rows", () => {
    const db = edb0();
    const b1 = applyPreferenceDeltas(
      db,
      V1,
      [
        { key: "prefers-tables", op: "add", value: "answers as tables", evidence: "e1" },
        { key: "dark-mode", op: "add", value: "dark themes" },
      ],
      NOW,
    );
    expect(b1).toEqual({ version: 1, applied: 2 });
    const b2 = applyPreferenceDeltas(
      db,
      V1,
      [
        { key: "prefers-tables", op: "strengthen" },
        { key: "dark-mode", op: "weaken" },
      ],
      NOW + 10,
    );
    expect(b2.version).toBe(2);
    const p = preferenceProfile(db, V1);
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
    applyPreferenceDeltas(db, V1, [{ key: "k", op: "add", value: "v" }], NOW);
    applyPreferenceDeltas(db, V1, [{ key: "k", op: "retract" }], NOW + 1);
    expect(preferenceProfile(db, V1).entries).toHaveLength(0); // weight 0 filtered
    const raw = db
      .prepare(`SELECT weight AS w FROM preference_profile WHERE vault_id='${V1}' AND key='k'`)
      .get() as {
      w: number;
    };
    expect(raw.w).toBe(0); // row survives retraction
    applyPreferenceDeltas(db, V1, [{ key: "k", op: "add", value: "v2" }], NOW + 2);
    const back = preferenceProfile(db, V1).entries.find((e) => e.key === "k");
    expect(back?.weight).toBe(0.5); // re-add climbs from the counter, not a fresh row
    expect(back?.value).toBe("v2");
  });

  // ---- THE-710: the vault partition ----
  //
  // These are the tests the migration exists for. Before it, `key` was the entire primary key, so
  // the first assertion below was FALSE: vault-two's `add` silently overwrote vault-one's row and
  // there was no column to tell them apart. The rebuild reverses a P1.8-audited decision on the
  // vault axis only, so the caller axis is pinned as still-shared further down — a test that would
  // have to change if anyone closes that residual, which is the point of writing it.

  it("two vaults hold the same key independently — no blending", () => {
    const db = edb0();
    applyPreferenceDeltas(db, V1, [{ key: "tone", op: "add", value: "terse" }], NOW);
    applyPreferenceDeltas(db, V2, [{ key: "tone", op: "add", value: "verbose" }], NOW + 1);

    expect(preferenceProfile(db, V1).entries).toEqual([
      expect.objectContaining({ key: "tone", value: "terse", weight: 1 }),
    ]);
    expect(preferenceProfile(db, V2).entries).toEqual([
      expect.objectContaining({ key: "tone", value: "verbose", weight: 1 }),
    ]);
    // Two rows, not one overwritten row — assert the stored identity, not just the read-back.
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM preference_profile WHERE key = 'tone'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(2);
  });

  it("a delta cannot reach across the partition", () => {
    const db = edb0();
    applyPreferenceDeltas(db, V1, [{ key: "tone", op: "add", value: "terse" }], NOW);
    // `strengthen` on a key that exists only in the OTHER vault must change nothing, and must not
    // log a phantom audit row — the same C4 guard as above, now on the vault axis.
    const r = applyPreferenceDeltas(db, V2, [{ key: "tone", op: "strengthen" }], NOW + 1);
    expect(r.applied).toBe(0);
    expect(preferenceProfile(db, V1).entries[0]?.weight).toBe(1); // untouched
    expect(preferenceProfile(db, V2).entries).toHaveLength(0);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM preference_deltas WHERE vault_id = ?").get(V2) as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  it("version is per-vault, so one vault's batch does not bump the other's", () => {
    const db = edb0();
    applyPreferenceDeltas(db, V1, [{ key: "a", op: "add", value: "x" }], NOW);
    applyPreferenceDeltas(db, V1, [{ key: "a", op: "strengthen" }], NOW + 1);
    // V1 is at version 2. A first write to V2 must start at 1, not continue from 3.
    const first = applyPreferenceDeltas(db, V2, [{ key: "b", op: "add", value: "y" }], NOW + 2);
    expect(first.version).toBe(1);
    expect(preferenceProfile(db, V1).version).toBe(2);
    expect(preferenceProfile(db, V2).version).toBe(1);
  });

  it("the audit log carries the vault, so a delta is attributable after the fact", () => {
    const db = edb0();
    applyPreferenceDeltas(db, V1, [{ key: "a", op: "add", value: "x" }], NOW);
    applyPreferenceDeltas(db, V2, [{ key: "a", op: "add", value: "y" }], NOW + 1);
    const rows = db
      .prepare("SELECT vault_id, key FROM preference_deltas ORDER BY vault_id")
      .all() as Array<{ vault_id: string; key: string }>;
    expect(rows).toEqual([
      { vault_id: V1, key: "a" },
      { vault_id: V2, key: "a" },
    ]);
  });

  it("the CALLER axis is still shared within a vault — the accepted residual, pinned", () => {
    // Not an oversight and not a TODO: SECURITY.md documents per-caller preference isolation as an
    // accepted residual, and THE-710 closed the vault axis only.
    //
    // BE HONEST ABOUT WHAT THIS PINS. It cannot vary the caller, because neither
    // applyPreferenceDeltas nor preferenceProfile takes one — the residual is STRUCTURAL, not a
    // filter someone forgot to write. So what this asserts is that successive deltas in one vault
    // land on ONE row regardless of origin. It is a decision anchor: closing the residual means
    // adding a caller parameter, which makes this test stop compiling rather than quietly pass.
    const db = edb0();
    applyPreferenceDeltas(db, V1, [{ key: "tone", op: "add", value: "terse" }], NOW);
    applyPreferenceDeltas(db, V1, [{ key: "tone", op: "strengthen" }], NOW + 1);
    expect(preferenceProfile(db, V1).entries[0]?.weight).toBe(1.5);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM preference_profile WHERE vault_id = ?").get(V1) as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });

  it("extractPreferences EXCLUDES a null-vault episode rather than attributing it", async () => {
    // agent_episodes.vault_id is nullable. Attributing such an episode to a default vault would
    // invent exactly the attribution the migration purged old rows to avoid inventing.
    const db = edb0();
    seed(db, "no-vault", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_text",
      vault_id: null,
    });
    // No evidence reached the counter at all, so the pass reports skipped rather than applying zero.
    const r = await extractPreferences(db, V1, { nowMs: NOW });
    expect(r).toMatchObject({ skipped: true, applied: 0 });
    expect(preferenceProfile(db, V1).entries).toHaveLength(0);
  });

  it("extractPreferences only sees ITS OWN vault's episodes", async () => {
    const db = edb0();
    seed(db, "mine", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_text",
      vault_id: V1,
    });
    seed(db, "theirs", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_vault",
      vault_id: V2,
    });
    const r = await extractPreferences(db, V1, { nowMs: NOW });
    expect(r.applied).toBe(1);
    expect(preferenceProfile(db, V1).entries).toEqual([
      expect.objectContaining({ key: "preferred.search_mode", value: "search_text" }),
    ]);
    // V2's episode never reached this call — a separate extractPreferences(db, V2, ...) call would
    // need to run for it to produce anything, and this call didn't make one.
    expect(preferenceProfile(db, V2).entries).toHaveLength(0);
  });

  it("does not log a phantom audit row for a delta on a non-existent key (C4)", () => {
    const db = edb0();
    const r = applyPreferenceDeltas(
      db,
      V1,
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

  it("extractPreferences: skipped with no evidence; a neutral window applies nothing; a +1 window applies a delta", async () => {
    const db = edb0();
    expect(await extractPreferences(db, V1, { nowMs: NOW })).toMatchObject({
      skipped: true,
      applied: 0,
    });

    // Evidence exists but is neutral (task_result = 0): a recorded-but-neutral verdict is not
    // evidence of preference either way, so this must NOT be reported skipped (evidence WAS found)
    // and must NOT apply anything.
    seed(db, "neutral", { task_result: 0, eligibility: "eligible", tool: "search_text" });
    const neutral = await extractPreferences(db, V1, { nowMs: NOW });
    expect(neutral).toMatchObject({ skipped: false, aborted: false, applied: 0 });
    expect(preferenceProfile(db, V1).entries).toHaveLength(0);

    seed(db, "good", { task_result: 1, eligibility: "eligible", tool: "search_text" });
    const ok = await extractPreferences(db, V1, { nowMs: NOW });
    expect(ok).toMatchObject({ skipped: false, aborted: false, applied: 1 });
    expect(preferenceProfile(db, V1).entries[0]?.key).toBe("preferred.search_mode");
    expect(preferenceProfile(db, V1).entries[0]?.value).toBe("search_text");
  });

  it("excludes ineligible episodes from the deterministic counter even when they carry a task_result (A3)", async () => {
    const db = edb0();
    // both carry a (test-seeded) non-null task_result; only the eligible one may reach the counter.
    seed(db, "good", { eligibility: "eligible", task_result: 1, tool: "search_text" });
    seed(db, "poison", { eligibility: "ineligible", task_result: 1, tool: "search_vault" });
    const r = await extractPreferences(db, V1, { nowMs: NOW });
    // If the ineligible row had leaked in, this would be 2 applied deltas (two distinct tools).
    expect(r.applied).toBe(1);
    expect(preferenceProfile(db, V1).entries[0]?.value).toBe("search_text");
  });

  // ---- THE-673: deterministic counters over typed evidence ----

  it("groupEpisodesByVerdictWindow collapses rows sharing (session_id, verdict_at) into one window", () => {
    const rows = [
      { session_id: "s1", verdict_at: 100, tag: "a" },
      { session_id: "s1", verdict_at: 100, tag: "b" },
      { session_id: "s2", verdict_at: 100, tag: "c" }, // different session -> different window
      { session_id: "s1", verdict_at: 200, tag: "d" }, // different verdict_at -> different window
      { session_id: null, verdict_at: null, tag: "e" }, // pre-producer row -> its own window
      { session_id: null, verdict_at: null, tag: "f" }, // ditto -> its own window, not merged with e
    ];
    const windows = groupEpisodesByVerdictWindow(rows);
    expect(windows).toHaveLength(5);
    const bySize = windows.map((w) => w.sampledCalls).sort();
    expect(bySize).toEqual([1, 1, 1, 1, 2]); // the (s1, 100) pair is the only window with 2 members
    const merged = windows.find((w) => w.sampledCalls === 2);
    expect(merged?.episodes.map((e) => e.tag).sort()).toEqual(["a", "b"]);
  });

  it("a window dispatching MULTIPLE distinct search tools still yields exactly ONE delta (binding: one window = one observation)", async () => {
    const db = edb0();
    // Same window (s1, 100): two rows for search_text, one for search_vault. If the counter
    // proposed a delta per distinct tool, this single judgement would bump the weight twice —
    // exactly the length bias THE-726's windowing exists to remove one level up.
    seed(db, "w1", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_text",
      session_id: "s1",
      verdict_at: 100,
    });
    seed(db, "w2", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_text",
      session_id: "s1",
      verdict_at: 100,
    });
    seed(db, "w3", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_vault",
      session_id: "s1",
      verdict_at: 100,
    });
    const r = await extractPreferences(db, V1, { nowMs: NOW });
    expect(r.applied).toBe(1); // one window, one observation — not one per distinct tool
    expect(preferenceProfile(db, V1).entries).toEqual([
      expect.objectContaining({ key: "preferred.search_mode", value: "search_text", weight: 1 }),
    ]);
  });

  it("extractPreferences: a mixed-verdict fixture — +1 strengthens, -1 weakens an existing key, 0 and NULL yield no delta", async () => {
    const db = edb0();
    // Window A (session s1, verdict 100): +1, two rows both dispatching search_text -> ONE
    // delta (one window = one observation), sampled_calls carries the real count.
    seed(db, "a1", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_text",
      session_id: "s1",
      verdict_at: 100,
    });
    seed(db, "a2", {
      task_result: 1,
      eligibility: "eligible",
      tool: "search_text",
      session_id: "s1",
      verdict_at: 100,
    });
    // Window B (session s2, verdict 200): +1, dispatches vault_graph_search -> a second, distinct
    // delta on the same key (different value).
    seed(db, "b1", {
      task_result: 1,
      eligibility: "eligible",
      tool: "vault_graph_search",
      session_id: "s2",
      verdict_at: 200,
    });
    // Window C (session s3, verdict 300): 0 (neutral) -> no delta at all, even though it dispatched
    // a search tool.
    seed(db, "c1", {
      task_result: 0,
      eligibility: "eligible",
      tool: "search_regex",
      session_id: "s3",
      verdict_at: 300,
    });
    // A pre-producer row (verdict_at NULL): +1, but a non-search tool -> contributes no delta
    // either, because preferred.search_mode only counts the search family.
    seed(db, "d1", { task_result: 1, eligibility: "eligible", tool: "read_note" });

    const r = await extractPreferences(db, V1, { nowMs: NOW });
    expect(r).toMatchObject({ skipped: false, aborted: false, applied: 2 });

    const deltas = db
      .prepare(
        "SELECT key, op, value, evidence FROM preference_deltas WHERE vault_id = ? ORDER BY value",
      )
      .all(V1) as Array<{ key: string; op: string; value: string; evidence: string }>;
    expect(deltas).toEqual([
      {
        key: "preferred.search_mode",
        op: "add",
        value: "search_text",
        evidence: "tool=search_text sampled_calls=2", // derived from the real 2-row window, not a placeholder
      },
      {
        key: "preferred.search_mode",
        op: "add",
        value: "vault_graph_search",
        evidence: "tool=vault_graph_search sampled_calls=1",
      },
    ]);
  });

  it("extractPreferences: a -1 window WEAKENS an existing preferred.search_mode key", async () => {
    const db = edb0();
    // Establish the key exactly the way a prior +1 extraction would (isolated from this test's own
    // evidence, via applyPreferenceDeltas directly, so the -1 window below is the ONLY thing this
    // call re-derives — extractPreferences has no "already processed" state, so a second call
    // re-reads every eligible episode in scope, and mixing that re-read into the same DB as more
    // +1 evidence would confound what this assertion is checking).
    applyPreferenceDeltas(
      db,
      V1,
      [{ key: "preferred.search_mode", op: "add", value: "search_text" }],
      NOW,
    );
    const before = preferenceProfile(db, V1).entries[0]?.weight as number;

    seed(db, "neg", {
      task_result: -1,
      eligibility: "eligible",
      tool: "search_text",
      session_id: "s9",
      verdict_at: 900,
    });
    const r = await extractPreferences(db, V1, { nowMs: NOW + 1 });
    expect(r.applied).toBe(1);
    const after = preferenceProfile(db, V1).entries[0]?.weight as number;
    expect(after).toBeLessThan(before);
  });

  it("extractPreferences: a -1 window is a no-op when preferred.search_mode has never been added (C4)", async () => {
    const db = edb0();
    seed(db, "neg", {
      task_result: -1,
      eligibility: "eligible",
      tool: "search_omnisearch",
      session_id: "s9",
      verdict_at: 900,
    });
    const r = await extractPreferences(db, V1, { nowMs: NOW });
    expect(r.applied).toBe(0);
    expect(preferenceProfile(db, V1).entries).toHaveLength(0);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM preference_deltas WHERE vault_id = ?").get(V1) as {
        n: number;
      }
    ).n;
    expect(n).toBe(0); // no phantom audit row
  });
});

describe("PREFERENCE_KEYS registry (THE-673)", () => {
  it("contains exactly the one key with a real, derivable producer today", () => {
    expect([...PREFERENCE_KEYS]).toEqual(["preferred.search_mode"]);
  });

  it("rejects a delta for an unregistered key before it reaches applyPreferenceDeltas", () => {
    const deltas: PreferenceDelta[] = [
      { key: "preferred.search_mode", op: "add", value: "search_text" },
      // None of these have a producer yet (captureContent off, THE-675 open, no HITL producer) —
      // a deterministic extractor proposing one of them would be exactly the "impossible state"
      // this registry exists to make unreachable.
      { key: "preferred.output_format", op: "add", value: "table" },
      { key: "response.detail", op: "add", value: "verbose" },
    ];
    const filtered = filterRegisteredDeltas(deltas);
    expect(filtered).toEqual([{ key: "preferred.search_mode", op: "add", value: "search_text" }]);
  });

  it("applying a filtered batch never writes the rejected keys", () => {
    const db = edb0();
    const deltas: PreferenceDelta[] = [
      { key: "preferred.search_mode", op: "add", value: "search_text" },
      { key: "workflow.confirmation_level", op: "add", value: "always" },
    ];
    const { applied } = applyPreferenceDeltas(db, V1, filterRegisteredDeltas(deltas), NOW);
    expect(applied).toBe(1);
    expect(preferenceProfile(db, V1).entries.map((e) => e.key)).toEqual(["preferred.search_mode"]);
  });
});
