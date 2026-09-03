// THE-726 (on-demand derivation) — the derived-verdict pass. `deriveWindowVerdict` is pure and
// tested in isolation first; `deriveClosedWindows` is the cross-store (cache.db + experiential.db)
// wiring on top of it, tested against real migration chains via `provisionCacheDb`/`runMigrations`
// (the reflect-citation-preferences.test.ts pattern for a cross-store fixture).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  DERIVATION_POLICY_VERSION,
  deriveClosedWindows,
  deriveWindowVerdict,
  READ_FAMILY_TOOLS,
  type WindowRow,
} from "../src/experiential/derive-verdict";
import {
  evaluateEpisodes,
  extractPreferences,
  SEARCH_FAMILY_TOOLS,
} from "../src/experiential/reflect";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXPERIENTIAL_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({
  version: versionOf(f),
  sql: read(f),
}));

const NOW = 1_900_000_000_000;

// ---------------------------------------------------------------------------
// deriveWindowVerdict — pure, one rule at a time.

function row(over: Partial<WindowRow> = {}): WindowRow {
  return {
    tool: over.tool ?? "read_note",
    status: over.status ?? "ok",
    error_code: over.error_code ?? null,
    args_hash: over.args_hash ?? null,
    ts: over.ts ?? 0,
  };
}

describe("deriveWindowVerdict: the read-family list (THE-726)", () => {
  it("READ_FAMILY_TOOLS names only tools that exist in the live registry", () => {
    const names = new Set(
      buildFullRegistry()
        .list()
        .map((t) => t.name),
    );
    for (const t of READ_FAMILY_TOOLS) {
      expect(names.has(t), `${t} is not a registered tool — READ_FAMILY_TOOLS has drifted`).toBe(
        true,
      );
    }
  });

  it("READ_FAMILY_TOOLS and SEARCH_FAMILY_TOOLS never overlap", () => {
    for (const t of READ_FAMILY_TOOLS) expect(SEARCH_FAMILY_TOOLS.has(t)).toBe(false);
  });

  it("reuses reflect.ts's own SEARCH_FAMILY_TOOLS set, not a duplicate", () => {
    expect(SEARCH_FAMILY_TOOLS.has("search_text")).toBe(true);
    expect(SEARCH_FAMILY_TOOLS.has("vault_graph_search")).toBe(true);
  });
});

describe("deriveWindowVerdict: empty window", () => {
  it("returns null for an empty window — nothing to stamp", () => {
    expect(deriveWindowVerdict([])).toBeNull();
  });
});

describe("deriveWindowVerdict: F1 terminal error", () => {
  it("the last call being an error, alone, gives -1", () => {
    const rows = [
      row({ tool: "write_note", status: "ok", ts: 1 }),
      row({ status: "error", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(-1);
  });

  it("an error that is NOT the last call is not F1 by itself", () => {
    const rows = [
      row({ status: "error", ts: 1 }),
      row({ tool: "write_note", status: "ok", ts: 2 }),
    ];
    // No F1 (last call ok), no F2 (different tool/no args_hash to retry), no S1 (no search->read).
    expect(deriveWindowVerdict(rows)).toBe(0);
  });
});

describe("deriveWindowVerdict: F2 retry-after-error", () => {
  it("an args_hash erroring, recurring later, never reaching ok, gives -1", () => {
    const rows = [
      row({ tool: "write_note", args_hash: "h1", status: "error", ts: 1 }),
      row({ tool: "write_note", args_hash: "h1", status: "error", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(-1);
  });

  it("a retried args_hash that eventually succeeds is NOT F2", () => {
    const rows = [
      row({ tool: "write_note", args_hash: "h1", status: "error", ts: 1 }),
      row({ tool: "write_note", args_hash: "h1", status: "ok", ts: 2 }),
    ];
    // Last call is ok, no S1 (no search-then-read), so 0 — not the -1 F2 would have produced.
    expect(deriveWindowVerdict(rows)).toBe(0);
  });

  it("a rejection chain — search, search again with DIFFERENT args, no read — gives 0, not -1", () => {
    const rows = [
      row({ tool: "search_text", args_hash: "q1", status: "ok", ts: 1 }),
      row({ tool: "search_text", args_hash: "q2", status: "ok", ts: 2 }),
    ];
    // Different args_hash each time -> never recurs -> not F2. No read call -> not S1 -> not S2.
    expect(deriveWindowVerdict(rows)).toBe(0);
  });

  it("an error with no recurrence of its args_hash is not F2", () => {
    const rows = [
      row({ tool: "write_note", args_hash: "h1", status: "error", ts: 1 }),
      row({ tool: "write_note", args_hash: "h2", status: "ok", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(0);
  });
});

describe("deriveWindowVerdict: S1 browse / S2 clean end", () => {
  it("a search-family call followed by a read-family call, ending ok, gives +1", () => {
    const rows = [
      row({ tool: "search_text", status: "ok", ts: 1 }),
      row({ tool: "read_note", status: "ok", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(1);
  });

  it("S2 alone (no F1/F2) gives +1", () => {
    const rows = [
      row({ tool: "search_vault", status: "ok", ts: 1 }),
      row({ tool: "read_notes", status: "ok", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(1);
  });

  it("a read BEFORE any search does not satisfy S1", () => {
    const rows = [
      row({ tool: "read_note", status: "ok", ts: 1 }),
      row({ tool: "search_text", status: "ok", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(0);
  });

  it("a search-then-read window ending in error is F1 without S2 -> -1", () => {
    const rows = [
      row({ tool: "search_text", status: "ok", ts: 1 }),
      row({ tool: "read_note", status: "ok", ts: 2 }),
      row({ tool: "write_note", status: "error", ts: 3 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(-1);
  });
});

describe("deriveWindowVerdict: precedence", () => {
  it("F and S2 together give 0, not -1 or +1", () => {
    // Search then read (S1, and the read call is 'ok' -> S2) but an EARLIER call in the window has
    // an args_hash that errors, recurs, and never reaches ok (F2) — window includes the retry chain
    // AND the clean browse.
    const rows = [
      row({ tool: "write_note", args_hash: "h1", status: "error", ts: 1 }),
      row({ tool: "write_note", args_hash: "h1", status: "error", ts: 2 }),
      row({ tool: "search_text", status: "ok", ts: 3 }),
      row({ tool: "read_note", status: "ok", ts: 4 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(0);
  });

  it("F1 alone (no S2) gives -1", () => {
    expect(
      deriveWindowVerdict([
        row({ tool: "write_note", status: "ok", ts: 1 }),
        row({ tool: "write_note", status: "error", ts: 2 }),
      ]),
    ).toBe(-1);
  });
});

describe("deriveWindowVerdict: ordering is by ts, not insertion order", () => {
  it("rows passed out of ts order still derive the ts-ordered verdict", () => {
    // Inserted with the error LAST but timestamped FIRST — if the function trusted array order
    // instead of sorting by ts, this would read as F1 (error last -> -1); sorted by ts it is a
    // clean search-then-read ending ok -> +1.
    const rows = [
      row({ tool: "read_note", status: "ok", ts: 20 }),
      row({ tool: "search_text", status: "ok", ts: 10 }),
      row({ tool: "write_note", status: "error", ts: 0 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deriveClosedWindows — cross-store wiring.

function stores(): { cacheDb: Database; edb: Database } {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const edb = openMemoryDb();
  runMigrations(edb, EXPERIENTIAL_CHAIN);
  return { cacheDb, edb };
}

function seedSession(
  cacheDb: Database,
  id: string,
  over: { endedAt?: number | null; startedAt?: number } = {},
): void {
  cacheDb
    .prepare(
      "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path) VALUES (?, 'main', 'alice', ?, ?, 'trace.jsonl')",
    )
    .run(id, over.startedAt ?? NOW - 10_000, over.endedAt === undefined ? NOW : over.endedAt);
}

let epSeq = 0;
function seedEpisode(
  edb: Database,
  over: {
    session?: string;
    ts?: number;
    tool?: string;
    status?: string;
    args_hash?: string | null;
    task_result?: number | null;
    kind?: string;
  } = {},
): string {
  const id = `ep-${++epSeq}`;
  edb
    .prepare(
      `INSERT INTO agent_episodes
         (id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, args_hash, task_result, eligibility, blocked, valid_from)
       VALUES (?, ?, 'main', ?, 'alice', 'dispatch', ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    )
    .run(
      id,
      over.ts ?? NOW - 5000,
      over.session ?? "sess_a",
      over.kind ?? "tool_call",
      over.tool ?? "read_note",
      over.status ?? "ok",
      over.args_hash ?? null,
      over.task_result ?? null,
      over.ts ?? NOW - 5000,
    );
  return id;
}

function episodeRow(
  edb: Database,
  id: string,
): { task_result: number | null; verdict_source: string | null; verdict_policy: number | null } {
  return edb
    .prepare("SELECT task_result, verdict_source, verdict_policy FROM agent_episodes WHERE id = ?")
    .get(id) as {
    task_result: number | null;
    verdict_source: string | null;
    verdict_policy: number | null;
  };
}

describe("deriveClosedWindows", () => {
  it("stamps only ended sessions, leaving a live session's open rows untouched", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    seedSession(cacheDb, "sess_live", { endedAt: null });
    const closedRow = seedEpisode(edb, {
      session: "sess_a",
      tool: "search_text",
      ts: NOW - 8000,
    });
    const readRow = seedEpisode(edb, { session: "sess_a", tool: "read_note", ts: NOW - 7000 });
    const liveRow = seedEpisode(edb, { session: "sess_live", tool: "read_note" });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.sessionsSeen).toBe(1);
    expect(out.stamped).toEqual({ minus: 0, zero: 0, plus: 1 }); // search then read, ends ok -> +1
    expect(episodeRow(edb, closedRow).task_result).toBe(1);
    expect(episodeRow(edb, readRow).task_result).toBe(1);
    expect(episodeRow(edb, liveRow).task_result).toBeNull(); // untouched — its session never ended
  });

  it("a second pass finds no open rows — idempotent", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    seedEpisode(edb, { session: "sess_a", tool: "read_note", status: "ok" });

    const first = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(first.sessionsSeen).toBe(1);
    const second = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(second.sessionsSeen).toBe(0);
    expect(second.stamped).toEqual({ minus: 0, zero: 0, plus: 0 });
  });

  it("verdict_source = 'derived' and verdict_policy = DERIVATION_POLICY_VERSION land on every stamped row; verdict_at = ended_at", async () => {
    const { cacheDb, edb } = stores();
    const endedAt = NOW - 2000;
    seedSession(cacheDb, "sess_a", { endedAt });
    const id = seedEpisode(edb, { session: "sess_a", tool: "read_note", status: "ok" });

    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    const r = episodeRow(edb, id);
    expect(r.verdict_source).toBe("derived");
    expect(r.verdict_policy).toBe(DERIVATION_POLICY_VERSION);
    const verdictAt = (
      edb.prepare("SELECT verdict_at AS v FROM agent_episodes WHERE id = ?").get(id) as {
        v: number;
      }
    ).v;
    expect(verdictAt).toBe(endedAt);
  });

  it("an operator stamp made before the session ended is not overwritten", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    const id = seedEpisode(edb, { session: "sess_a", tool: "read_note", status: "ok" });
    // The operator judged it while the session was still open (task_result already set).
    edb
      .prepare(
        "UPDATE agent_episodes SET task_result = 1, verdict_at = ?, verdict_source = 'operator' WHERE id = ?",
      )
      .run(NOW - 5000, id);

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    // No open rows left in this session -> deriveClosedWindows finds nothing to consider.
    expect(out.sessionsSeen).toBe(0);
    const r = episodeRow(edb, id);
    expect(r.verdict_source).toBe("operator"); // untouched
  });

  it("a session whose ended_at exceeds nowMs is treated as not-yet-closed", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_future", { endedAt: NOW + 10_000 });
    seedEpisode(edb, { session: "sess_future", tool: "read_note", ts: NOW - 5000 });
    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.sessionsSeen).toBe(0);
  });

  it("oldest ended_at first, capped at opts.limit", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "s1", { endedAt: NOW - 3000 });
    seedSession(cacheDb, "s2", { endedAt: NOW - 2000 });
    seedSession(cacheDb, "s3", { endedAt: NOW - 1000 });
    seedEpisode(edb, { session: "s1", tool: "read_note", ts: NOW - 3500 });
    seedEpisode(edb, { session: "s2", tool: "read_note", ts: NOW - 2500 });
    seedEpisode(edb, { session: "s3", tool: "read_note", ts: NOW - 1500 });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW, limit: 2 });
    expect(out.sessionsSeen).toBe(2);
    const s1 = (
      edb.prepare("SELECT task_result AS t FROM agent_episodes WHERE session_id = 's1'").get() as {
        t: number | null;
      }
    ).t;
    const s2 = (
      edb.prepare("SELECT task_result AS t FROM agent_episodes WHERE session_id = 's2'").get() as {
        t: number | null;
      }
    ).t;
    const s3 = (
      edb.prepare("SELECT task_result AS t FROM agent_episodes WHERE session_id = 's3'").get() as {
        t: number | null;
      }
    ).t;
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).toBeNull(); // outside the cap, oldest-first — s1/s2 win, s3 waits for the next pass
  });

  it("a window entirely past its session's ended_at derives null and is skipped, not stamped", async () => {
    const { cacheDb, edb } = stores();
    const endedAt = NOW - 5000;
    seedSession(cacheDb, "sess_a", { endedAt });
    // Every open row postdates ended_at — nothing is in bounds to judge.
    seedEpisode(edb, { session: "sess_a", tool: "read_note", ts: endedAt + 1000 });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.sessionsSeen).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.stamped).toEqual({ minus: 0, zero: 0, plus: 0 });
  });

  it("does not write to cache.db — workspace_sessions is untouched", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    seedEpisode(edb, { session: "sess_a", tool: "read_note", status: "ok" });
    const before = cacheDb.prepare("SELECT * FROM workspace_sessions WHERE id = 'sess_a'").get();
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    const after = cacheDb.prepare("SELECT * FROM workspace_sessions WHERE id = 'sess_a'").get();
    expect(after).toEqual(before);
  });

  it("a -1 window derived here feeds extractPreferences the same way an operator -1 does (weaken)", async () => {
    // Not a full extractPreferences round-trip (covered in reflect-evaluator.test.ts) — just pins
    // that the derived writer produces the SAME column shape (task_result/session_id/verdict_at)
    // that evidence gate reads, by construction of going through stampOpenWindow.
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    // A terminal error -> F1 -> -1.
    const id = seedEpisode(edb, {
      session: "sess_a",
      tool: "search_text",
      status: "error",
      ts: NOW - 8000,
    });
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    const r = edb
      .prepare("SELECT task_result, session_id, verdict_at FROM agent_episodes WHERE id = ?")
      .get(id) as { task_result: number; session_id: string; verdict_at: number };
    expect(r.task_result).toBe(-1);
    expect(r.session_id).toBe("sess_a");
    expect(r.verdict_at).not.toBeNull();
  });
});

// THE-726: the PASS-ORDERING requirement — a derived -1 written in a pass must be visible to the
// hold rule in that SAME pass (registerEpisodeEvaluation calls deriveClosedWindows immediately
// before evaluateEpisodes, in one `run`). These pin the two flag states end to end, not just the
// hold-rule unit tested in reflect-evaluator.test.ts.
describe("derive -> evaluate, same pass (THE-726 pass ordering)", () => {
  it("a derived -1 is held in the same pass when derivedVerdictHold is on", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    const id = seedEpisode(edb, {
      session: "sess_a",
      tool: "write_note",
      status: "error",
      ts: NOW - 8000,
    });
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    const stats = await evaluateEpisodes(edb, { nowMs: NOW, derivedVerdictHold: true });
    expect(stats).toMatchObject({ promoted: 0, held: 1 });
    const row = edb
      .prepare("SELECT eligibility, eligibility_reason FROM agent_episodes WHERE id = ?")
      .get(id) as { eligibility: string; eligibility_reason: string };
    expect(row.eligibility).toBe("pending");
    expect(row.eligibility_reason).toBe("held_bad_task_result");
  });

  it("a derived -1 is promoted with promoted_stable in the same pass when derivedVerdictHold is off", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    const id = seedEpisode(edb, {
      session: "sess_a",
      tool: "write_note",
      status: "error",
      ts: NOW - 8000,
    });
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    const stats = await evaluateEpisodes(edb, { nowMs: NOW, derivedVerdictHold: false });
    expect(stats).toMatchObject({ promoted: 1, held: 0 });
    const row = edb
      .prepare("SELECT eligibility, eligibility_reason FROM agent_episodes WHERE id = ?")
      .get(id) as { eligibility: string; eligibility_reason: string };
    expect(row.eligibility).toBe("eligible");
    expect(row.eligibility_reason).toBe("promoted_stable");
  });
});

// THE-726: extractPreferences must not care WHICH writer produced task_result/verdict_at — it
// groups by (session_id, verdict_at) regardless of verdict_source, so a derived window is exactly
// one observation, same as an operator one.
describe("extractPreferences groups derived windows by (session_id, verdict_at) (THE-726)", () => {
  it("a derived +1 window (search then read) applies one preferred.search_mode delta", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    seedEpisode(edb, { session: "sess_a", tool: "search_text", ts: NOW - 9000 });
    seedEpisode(edb, { session: "sess_a", tool: "read_note", ts: NOW - 8000 });

    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    await evaluateEpisodes(edb, { nowMs: NOW, derivedVerdictHold: false });
    const prefs = await extractPreferences(edb, "main", { nowMs: NOW });
    expect(prefs).toMatchObject({ skipped: false, applied: 1 });

    const deltas = edb
      .prepare("SELECT key, op, value, evidence FROM preference_deltas WHERE vault_id = 'main'")
      .all() as Array<{ key: string; op: string; value: string; evidence: string }>;
    expect(deltas).toEqual([
      {
        key: "preferred.search_mode",
        op: "add",
        value: "search_text",
        // sampled_calls=2 (both rows in the window), not 1 per row — one window, one observation.
        evidence: "tool=search_text sampled_calls=2 tool_calls=1",
      },
    ]);
  });
});
