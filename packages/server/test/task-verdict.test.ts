// THE-726 — the task-verdict producer. Design:
// docs/superpowers/specs/2026-08-16-the-726-task-verdict-producer-design-v2.md
//
// `agent_episodes.task_result` had READERS AND NO WRITER: reflect.ts holds a bad-result episode out
// of promotion and gates the preference-extraction evidence set, and both were inert at 0 of 630
// live rows. These tests pin the writer, and specifically the four things v2's first draft got
// wrong badly enough to be rejected — each is a case where a plausible implementation passes the
// obvious test and is still broken.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { stampOpenWindow, UNSTAMPED_DEBT_CLAUSES } from "../src/experiential/verdict";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");

const CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
  { version: "20260806_003", sql: read("20260806_003_agent_episodes_task_result.sql") },
  { version: "20260806_006", sql: read("20260806_006_episode_eligibility_reason.sql") },
  { version: "20260816_001", sql: read("20260816_001_episode_type_structural.sql") },
  { version: "20260816_002", sql: read("20260816_002_episode_verdict_at.sql") },
];

function db(): Database {
  const d = openMemoryDb();
  runMigrations(d, CHAIN);
  return d;
}

let seq = 0;
function seed(
  d: Database,
  over: {
    session?: string;
    ts?: number;
    kind?: string;
    tool?: string;
    eligibility?: string;
  } = {},
): string {
  const id = `ep-${++seq}`;
  d.prepare(
    `INSERT INTO agent_episodes
       (id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, eligibility, blocked, valid_from)
     VALUES (?, ?, 'main', ?, 'alice', 'dispatch', ?, ?, 'ok', ?, 0, ?)`,
  ).run(
    id,
    over.ts ?? 1000,
    over.session ?? "sess_a",
    over.kind ?? "tool_call",
    over.tool ?? "read_note",
    over.eligibility ?? "pending",
    over.ts ?? 1000,
  );
  return id;
}

const results = (d: Database) =>
  d
    .prepare("SELECT id, task_result, verdict_at, eligibility FROM agent_episodes ORDER BY id")
    .all() as Array<{
    id: string;
    task_result: number | null;
    verdict_at: number | null;
    eligibility: string;
  }>;

describe("THE-726: the window", () => {
  it("stamps every unjudged judgeable row in the session, and nothing outside it", () => {
    const d = db();
    seed(d, { session: "sess_a" });
    seed(d, { session: "sess_a" });
    seed(d, { session: "sess_b" }); // another session
    const out = stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000 });
    expect(out.stamped).toBe(2);
    const rows = results(d);
    expect(rows.map((r) => r.task_result)).toEqual([1, 1, null]);
    expect(rows[0]?.verdict_at).toBe(5000);
    d.close?.();
  });

  it("a second stamp with no work between reports 0 — the window really closed", () => {
    // v1's design failed exactly here: the stamping verb's own dispatch row landed AFTER the
    // UPDATE, reopening the window, so a second call reported 1 and stamped the bookkeeping.
    const d = db();
    seed(d);
    expect(stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000 }).stamped).toBe(1);
    expect(stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 6000 }).stamped).toBe(0);
    d.close?.();
  });

  it("partitions a session: two stamps, two verdicts, two distinct verdict_at", () => {
    const d = db();
    const a = seed(d, { ts: 1000 });
    stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000 });
    const b = seed(d, { ts: 6000 });
    stampOpenWindow(d, { sessionId: "sess_a", result: -1, now: 7000 });
    const by = Object.fromEntries(results(d).map((r) => [r.id, r]));
    expect(by[a]?.task_result).toBe(1);
    expect(by[b]?.task_result).toBe(-1);
    expect(by[a]?.verdict_at).not.toBe(by[b]?.verdict_at);
    d.close?.();
  });

  it("as_of pins the boundary: work committed after it is not swept in", () => {
    // The TOCTOU case. The UPDATE is atomic but the agent's judgement is not formed atomically with
    // it, so a dispatch landing in between would otherwise be judged by a verdict formed before it.
    const d = db();
    const early = seed(d, { ts: 1000 });
    const late = seed(d, { ts: 4000 });
    const out = stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000, asOf: 2000 });
    expect(out.stamped).toBe(1);
    const by = Object.fromEntries(results(d).map((r) => [r.id, r]));
    expect(by[early]?.task_result).toBe(1);
    expect(by[late]?.task_result).toBeNull();
    d.close?.();
  });
});

describe("THE-726: judgeability is structural (THE-839)", () => {
  it("never judges protocol traffic or the verdict verbs themselves", () => {
    const d = db();
    const tool = seed(d, { kind: "tool_call" });
    const proto = seed(d, { kind: "protocol", tool: "prompts/list" });
    const verdict = seed(d, { kind: "verdict", tool: "work_result" });
    expect(stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000 }).stamped).toBe(1);
    const by = Object.fromEntries(results(d).map((r) => [r.id, r]));
    expect(by[tool]?.task_result).toBe(1);
    expect(by[proto]?.task_result).toBeNull();
    // Without this, every stamp strands its own dispatch row and the debt can never drain.
    expect(by[verdict]?.task_result).toBeNull();
    d.close?.();
  });

  it("judges a SLASH-NAMED tool — the filter is not a name test (SEP-986)", () => {
    // `user-profile/update` is a spec-valid tool name. v1 filtered with `tool NOT LIKE '%/%'`,
    // which would have excluded it from judgement forever and silently.
    const d = db();
    const id = seed(d, { kind: "tool_call", tool: "user-profile/update" });
    expect(stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000 }).stamped).toBe(1);
    expect(results(d).find((r) => r.id === id)?.task_result).toBe(1);
    d.close?.();
  });
});

describe("THE-726: a -1 demotes, so the hold rule is order-independent", () => {
  it("puts a promoted row back to pending when the verdict condemns it", () => {
    // reflect.ts selects `eligibility = 'pending'` and promotes to 'eligible'; NOTHING re-inspects a
    // promoted row. So a -1 arriving at close would never fire held_bad_task_result and the failed
    // task's episodes would stay retrievable — the exact outcome that rule exists to prevent.
    const d = db();
    const id = seed(d, { eligibility: "eligible" });
    const out = stampOpenWindow(d, { sessionId: "sess_a", result: -1, now: 5000 });
    expect(out.demoted).toBe(1);
    const row = results(d).find((r) => r.id === id);
    expect(row?.task_result).toBe(-1);
    expect(row?.eligibility).toBe("pending");
    d.close?.();
  });

  it("a 0 or +1 verdict demotes nothing", () => {
    const d = db();
    seed(d, { eligibility: "eligible" });
    expect(stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000 }).demoted).toBe(0);
    expect(results(d)[0]?.eligibility).toBe("eligible");
    d.close?.();
  });
});

describe("THE-726: the debt predicate", () => {
  it("selects unjudged judgeable work and excludes everything already stamped", () => {
    const d = db();
    const open = seed(d, { kind: "tool_call" });
    seed(d, { kind: "protocol", tool: "resources/list" });
    const stamped = seed(d, { kind: "tool_call" });
    stampOpenWindow(d, { sessionId: "sess_a", result: 1, now: 5000, asOf: 1000 });
    // Re-open one so there is a genuine mix.
    d.prepare("UPDATE agent_episodes SET task_result = NULL WHERE id = ?").run(open);

    const rows = d
      .prepare(`SELECT id FROM agent_episodes WHERE ${UNSTAMPED_DEBT_CLAUSES.join(" AND ")}`)
      .all() as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(stamped);
    // Protocol traffic is not debt: nobody can render a verdict on it, so leaving it in would make
    // the queue permanently non-empty and destroy its meaning as a signal.
    expect(rows).toHaveLength(1);
    d.close?.();
  });

  it("the debt clauses carry NO age term", () => {
    // Age is the caller's `until` filter over per-ROW ts. An earlier draft baked in session-level
    // MAX(ts) idleness, which let repeated protocol chatter hide a session's old unstamped rows
    // indefinitely.
    expect(UNSTAMPED_DEBT_CLAUSES.join(" ")).not.toMatch(/ts\s*[<>]/);
    expect(UNSTAMPED_DEBT_CLAUSES).toContain("task_result IS NULL");
    expect(UNSTAMPED_DEBT_CLAUSES).toContain("episode_type = 'tool_call'");
  });
});
