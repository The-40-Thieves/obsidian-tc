// THE-585: `activeSessions`, `captureQueueDepth` and `elicitTokensPending` were in the gauge
// catalog and wired to NOTHING. They registered a `# TYPE` line and emitted no series at all, for
// many releases. `test/metrics.test.ts` did not catch it, because asserting a metric is REGISTERED
// says nothing about whether anything ever feeds it — the same measures-nothing-while-green shape
// the perf collectors refuse.
//
// So these tests do not check registration. They run the real SQL against a real provisioned
// schema and assert rows come back, then assert the same values reach the Prometheus exposition.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { databaseGaugeSources } from "../src/metrics/gauge-sources";
import { MetricsRecorder } from "../src/metrics/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_800_000_000_000;

async function seededDb(): Promise<Database> {
  const raw = openMemoryDb();
  const db: Database = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
  };
  await provisionCacheDb(db);

  // Two vaults, so a GROUP BY that silently collapsed vaults would be visible.
  db.prepare(
    "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path) VALUES (?,?,?,?,?,?)",
  ).run("s1", "main", "c", NOW - 1000, null, "t1");
  db.prepare(
    "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path) VALUES (?,?,?,?,?,?)",
  ).run("s2", "main", "c", NOW - 2000, null, "t2");
  // Ended — must NOT count.
  db.prepare(
    "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path) VALUES (?,?,?,?,?,?)",
  ).run("s3", "main", "c", NOW - 3000, NOW - 500, "t3");
  db.prepare(
    "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path) VALUES (?,?,?,?,?,?)",
  ).run("s4", "other", "c", NOW - 1000, null, "t4");

  const cap = db.prepare(
    "INSERT INTO capture_queue (id, vault_id, content, captured_at, committed_at) VALUES (?,?,?,?,?)",
  );
  cap.run("c1", "main", "x", NOW, null);
  cap.run("c2", "main", "y", NOW, null);
  cap.run("c3", "main", "z", NOW, NOW); // committed — must NOT count
  cap.run("c4", "other", "w", NOW, null);

  const el = db.prepare(
    "INSERT INTO elicit_tokens (token, vault_id, tool_name, args_hash, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?)",
  );
  el.run("t-live", "main", "write_note", "h", NOW, NOW + 60_000, null);
  el.run("t-consumed", "main", "write_note", "h", NOW, NOW + 60_000, NOW); // consumed
  el.run("t-expired", "main", "write_note", "h", NOW, NOW - 1, null); // expired
  return db;
}

describe("THE-585 database gauge sources actually return data", () => {
  it("counts only UNENDED sessions, grouped per vault", async () => {
    const db = await seededDb();
    const rows = databaseGaugeSources(db, () => NOW).activeSessions?.() ?? [];
    expect(new Map(rows.map((r) => [r.vault, r.value]))).toEqual(
      new Map([
        ["main", 2],
        ["other", 1],
      ]),
    );
  });

  it("counts only UNCOMMITTED capture rows, grouped per vault", async () => {
    const db = await seededDb();
    const rows = databaseGaugeSources(db, () => NOW).captureQueueDepth?.() ?? [];
    expect(new Map(rows.map((r) => [r.vault, r.value]))).toEqual(
      new Map([
        ["main", 2],
        ["other", 1],
      ]),
    );
  });

  // The interesting one: "pending" has TWO exclusions, and getting either wrong reports a backlog
  // an operator cannot act on. An expired token is not pending work — the sweep reaps it.
  it("counts elicit tokens that are neither consumed NOR expired", async () => {
    const db = await seededDb();
    const rows = databaseGaugeSources(db, () => NOW).elicitTokensPending?.() ?? [];
    expect(rows).toEqual([{ vault: "main", value: 1 }]);
  });

  it("re-reads at every call rather than latching a boot-time snapshot", async () => {
    const db = await seededDb();
    const sources = databaseGaugeSources(db, () => NOW);
    expect(sources.captureQueueDepth?.()).toContainEqual({ vault: "main", value: 2 });
    db.prepare(
      "INSERT INTO capture_queue (id, vault_id, content, captured_at, committed_at) VALUES (?,?,?,?,?)",
    ).run("c5", "main", "new", NOW, null);
    expect(sources.captureQueueDepth?.()).toContainEqual({ vault: "main", value: 3 });
  });

  // Time-dependence is why `now` is injectable: without controlling the clock a test cannot tell
  // "expired and correctly excluded" from "the predicate is wrong".
  it("stops counting a token once the clock passes its expiry", async () => {
    const db = await seededDb();
    let clock = NOW;
    const sources = databaseGaugeSources(db, () => clock);
    expect(sources.elicitTokensPending?.()).toEqual([{ vault: "main", value: 1 }]);
    clock = NOW + 120_000; // past t-live's expiry
    expect(sources.elicitTokensPending?.()).toEqual([]);
  });
});

describe("THE-585 #13 active embedding fingerprint", () => {
  it("reports the one fingerprint row under a bounded subsystem label, not per vault", async () => {
    const db = await seededDb();
    db.exec(
      "CREATE TABLE IF NOT EXISTS vec_index_fingerprint (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO vec_index_fingerprint (id, fingerprint) VALUES (1, ?)").run(
      "ollama|bge-m3|1024|cosine|0|1|v3",
    );
    // The table is CHECK (id = 1): ONE row per database, shared by every vault in it. Labelling it
    // per vault would copy one string across N series and imply a per-vault choice that cannot exist.
    expect(databaseGaugeSources(db, () => NOW).vecFingerprint?.()).toEqual([
      { vault: "index", fingerprint: "ollama|bge-m3|1024|cosine|0|1|v3" },
    ]);
  });

  it("reports NOTHING when no embedding has ever been generated", async () => {
    // A cache.db with no vec_index_fingerprint table has no fingerprint. An empty series is the
    // honest report; a placeholder value would be a claim about a representation that does not exist.
    const db = await seededDb();
    expect(databaseGaugeSources(db, () => NOW).vecFingerprint?.()).toEqual([]);
  });
});

describe("THE-585 the previously-dead gauges reach the Prometheus exposition", () => {
  it("emits real series, not just a registered TYPE line", async () => {
    const db = await seededDb();
    const text = await new MetricsRecorder(databaseGaugeSources(db, () => NOW)).metrics();

    // Before this change every one of these had a TYPE line and NO series beneath it.
    expect(text).toContain('obsidian_tc_active_sessions{vault="main"} 2');
    expect(text).toContain('obsidian_tc_active_sessions{vault="other"} 1');
    expect(text).toContain('obsidian_tc_capture_queue_depth{vault="main"} 2');
    expect(text).toContain('obsidian_tc_elicit_tokens_pending{vault="main"} 1');
  });

  // Behavioural tests above prove the SQL works and the recorder exposes it. Neither proves the
  // composition root still CALLS it — delete the spread and every test above stays green while
  // the gauges go silent again, which is precisely how they died the first time. A structural
  // check is the only thing that sees that, so this is a deliberate source scan.
  //
  // THE-466 slice 2 moved the recorder's construction (and this spread) out of cli.ts into
  // runtime/observability.ts; cli.ts now reaches it one level removed, through createObservability.
  it("the composition root still feeds the recorder from databaseGaugeSources", () => {
    const observability = readFileSync(
      new URL("../src/runtime/observability.ts", import.meta.url),
      "utf8",
    );
    expect(observability).toContain("...databaseGaugeSources(deps.db)");
    // The SQL must live in ONE place. A copy re-introduced here would be untestable again.
    expect(observability).not.toContain("FROM workspace_sessions WHERE ended_at IS NULL");
    expect(observability).not.toContain("FROM capture_queue WHERE committed_at IS NULL");

    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("createObservability({");
  });

  it("an unwired source still registers the metric but emits nothing — the old behaviour", async () => {
    // Pinning the failure mode itself, so the difference between "registered" and "reporting" stays
    // legible to whoever reads this next.
    const text = await new MetricsRecorder().metrics();
    expect(text).toContain("# TYPE obsidian_tc_active_sessions gauge");
    expect(text).not.toMatch(/^obsidian_tc_active_sessions\{/m);
  });
});
