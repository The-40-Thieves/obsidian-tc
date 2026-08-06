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
  evaluateEpisodes,
  extractPreferences,
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
  }> = {},
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, args_hash, task_result, eligibility, blocked, valid_from, vault_id)
     VALUES (?, ?, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      .prepare("SELECT weight AS w FROM preference_profile WHERE vault_id='" + V1 + "' AND key='k'")
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
    seed(db, "no-vault", { task_result: 1, eligibility: "eligible", vault_id: null });
    let sawEvidence = false;
    const judge = async () => {
      sawEvidence = true;
      return { text: JSON.stringify({ deltas: [] }), model: "mock" };
    };
    const r = await extractPreferences(db, V1, { judge, nowMs: NOW });
    // No evidence reached the judge at all, so the pass reports skipped rather than applying zero.
    expect(sawEvidence).toBe(false);
    expect(r).toMatchObject({ skipped: true, applied: 0 });
  });

  it("extractPreferences only sees ITS OWN vault's episodes", async () => {
    const db = edb0();
    seed(db, "mine", { task_result: 1, eligibility: "eligible", tool: "read_note", vault_id: V1 });
    seed(db, "theirs", {
      task_result: 1,
      eligibility: "eligible",
      tool: "write_note",
      vault_id: V2,
    });
    let evidence = "";
    const judge = async (req: { messages: Array<{ content: string }> }) => {
      evidence = req.messages.map((m) => m.content).join("\n");
      return { text: JSON.stringify({ deltas: [] }), model: "mock" };
    };
    await extractPreferences(db, V1, { judge, nowMs: NOW });
    expect(evidence).toContain("read_note");
    expect(evidence).not.toContain("write_note");
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

  it("extractPreferences: skipped without a judge; aborted on a parse failure applies nothing", async () => {
    const db = edb0();
    seed(db, "o1", { task_result: 1, eligibility: "eligible" });
    expect(await extractPreferences(db, V1, { judge: null, nowMs: NOW })).toMatchObject({
      skipped: true,
    });
    const bad = async () => ({ text: "{oops", model: "mock" });
    const r = await extractPreferences(db, V1, { judge: bad, nowMs: NOW });
    expect(r.aborted).toBe(true);
    expect(preferenceProfile(db, V1).entries).toHaveLength(0);
    const good = async () => ({
      text: JSON.stringify({
        deltas: [{ key: "fast-reads", op: "add", value: "prefers read_note over search" }],
      }),
      model: "mock",
    });
    const ok = await extractPreferences(db, V1, { judge: good, nowMs: NOW });
    expect(ok).toMatchObject({ skipped: false, aborted: false, applied: 1 });
    expect(preferenceProfile(db, V1).entries[0]?.key).toBe("fast-reads");
  });

  it("excludes ineligible episodes from the judge even when they carry a task_result (A3)", async () => {
    const db = edb0();
    // both carry a (test-seeded) non-null task_result; only the eligible one may reach the judge.
    seed(db, "good", { eligibility: "eligible", task_result: 1, tool: "read_note" });
    seed(db, "poison", { eligibility: "ineligible", task_result: 1, tool: "exfiltrate_secrets" });
    let seenPrompt = "";
    const judge = async (req: unknown) => {
      seenPrompt = JSON.stringify(req);
      return { text: JSON.stringify({ deltas: [] }), model: "mock" };
    };
    await extractPreferences(db, V1, { judge, nowMs: NOW });
    expect(seenPrompt).toContain("read_note"); // the eligible episode reached the judge…
    expect(seenPrompt).not.toContain("exfiltrate_secrets"); // …the ineligible one did NOT.
  });
});
