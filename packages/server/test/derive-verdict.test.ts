// THE-726 (on-demand derivation) — the derived-verdict pass. `deriveWindowVerdict` is pure and
// tested in isolation first; `deriveClosedWindows` is the cross-store (cache.db + experiential.db)
// wiring on top of it, tested against real migration chains via `provisionCacheDb`/`runMigrations`
// (the reflect-citation-preferences.test.ts pattern for a cross-store fixture).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  DERIVATION_POLICY_VERSION,
  deriveClosedWindows,
  deriveWindowVerdict,
  MAX_CANDIDATE_SESSIONS,
  READ_FAMILY_TOOLS,
  TERMINAL_DRAIN_POLICY,
  type WindowRow,
} from "../src/experiential/derive-verdict";
import { registerEpisodeEvaluation } from "../src/experiential/episode-evaluation-schedule";
import {
  applyPreferenceDeltas,
  evaluateEpisodes,
  extractPreferences,
  SEARCH_FAMILY_TOOLS,
} from "../src/experiential/reflect";
import { Scheduler } from "../src/scheduler/scheduler";
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

// THE-726 fix round 3 (G2b): `seq` defaults to the CALL order (mirrors `rowid`, real capture
// order), independently of `id` - a test that wants ids to sort AGAINST capture order overrides
// `id` alone and leaves `seq` at its natural default, exactly the shape the tiebreak fix needs to
// be tested against.
let rowSeq = 0;
function row(over: Partial<WindowRow> = {}): WindowRow {
  const n = ++rowSeq;
  return {
    id: over.id ?? `r-${n}`,
    seq: over.seq ?? n,
    tool: over.tool ?? "read_note",
    status: over.status ?? "ok",
    error_code: over.error_code ?? null,
    args_hash: over.args_hash ?? null,
    ts: over.ts ?? 0,
  };
}

// THE-726 review round 1 FOLD-IN #8: the previous version of this describe block only checked that
// READ_FAMILY_TOOLS' two names still exist in the registry — it said nothing about the OTHER 20
// read_*/get_* tools the registry exposes, so a 23rd one could appear and sit in neither bucket
// (counted as read-family, or deliberately excluded) without any test noticing. This snapshots the
// FULL set and partitions it, so a new tool forces a reviewed decision instead of silent drift.
describe("deriveWindowVerdict: the read-family list (THE-726)", () => {
  // Deliberately excluded from S1's "browse" signal — see READ_FAMILY_TOOLS' own doc comment for
  // why (structural-field reads, not "looked at a note the search found"). Pinned as a literal list
  // rather than "everything else": a NEW tool must be added here (or to READ_FAMILY_TOOLS) by a
  // reviewed decision, and this array going stale is exactly the failure mode #8 exists to catch.
  // THE-726 fix round 2: this partition is computed purely over NAME, tools starting `read_` or
  // `get_`. A future read tool named outside that convention (`fetch_note`, say) would slip both
  // buckets silently and must be added here by hand; the test below only catches the ones the
  // naming filter already surfaces.
  const DELIBERATELY_EXCLUDED_READ_TOOLS = [
    "get_attachment",
    "get_backlinks",
    "get_entity",
    "get_index_status",
    "get_link_strength",
    "get_metrics",
    "get_note_tags",
    "get_outgoing_links",
    "get_periodic_note",
    "get_server_config",
    "get_session_traces",
    "get_vault",
    "read_base",
    "read_canvas",
    "read_excalidraw",
    "read_frontmatter",
    "read_kanban_board",
    "read_metadata_fields",
    "read_property",
    "read_snapshot",
  ] as const;

  function liveReadGetToolNames(): string[] {
    return buildFullRegistry()
      .list()
      .map((t) => t.name)
      .filter((n) => n.startsWith("read_") || n.startsWith("get_"))
      .sort();
  }

  it("READ_FAMILY_TOOLS names only tools that exist in the live registry", () => {
    const names = new Set(liveReadGetToolNames());
    for (const t of READ_FAMILY_TOOLS) {
      expect(names.has(t), `${t} is not a registered tool — READ_FAMILY_TOOLS has drifted`).toBe(
        true,
      );
    }
  });

  it("every read_*/get_* tool the registry exposes lands in EXACTLY one bucket: in-family or deliberately excluded", () => {
    const live = liveReadGetToolNames();
    const inFamily: string[] = [...READ_FAMILY_TOOLS];
    const excluded: string[] = [...DELIBERATELY_EXCLUDED_READ_TOOLS];
    const accounted = new Set([...inFamily, ...excluded]);

    // Forward: every live tool is accounted for. A new (23rd) read tool fails HERE — it exists in
    // the registry but in neither pinned bucket, forcing a reviewed decision about which one it
    // belongs to rather than silently doing nothing.
    const unaccounted = live.filter((n) => !accounted.has(n));
    expect(
      unaccounted,
      `${unaccounted.length} read_*/get_* tool(s) are in neither READ_FAMILY_TOOLS nor the pinned exclusion list: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    // Backward: nothing pinned as excluded (or in-family) has been renamed/removed out from under
    // this list — a stale entry would make the exclusion list a lie about what is actually excluded.
    const stale = [...excluded, ...inFamily].filter((n) => !live.includes(n));
    expect(stale, `pinned name(s) no longer exist in the registry: ${stale.join(", ")}`).toEqual(
      [],
    );

    // No overlap: a tool cannot be simultaneously in-family and deliberately excluded.
    const overlap = inFamily.filter((n) => excluded.includes(n));
    expect(overlap).toEqual([]);
  });

  it("READ_FAMILY_TOOLS and SEARCH_FAMILY_TOOLS never overlap", () => {
    for (const t of READ_FAMILY_TOOLS) expect(SEARCH_FAMILY_TOOLS.has(t)).toBe(false);
  });

  // THE-726 fix round 3 (G7): retitled - the previous title claimed this proves S1 "reuses
  // reflect.ts's own SEARCH_FAMILY_TOOLS set, not a duplicate", but the assertions below only check
  // two known names are present; they say nothing about object identity and would pass identically
  // against an independent set someone hand-copied with the same two names in it. The import at the
  // top of this file (`SEARCH_FAMILY_TOOLS` from `../src/experiential/reflect`) is what actually
  // guarantees no duplicate exists - this test just spot-checks the imported set's contents.
  it("the imported SEARCH_FAMILY_TOOLS names the two search tools these other tests rely on", () => {
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

  // THE-726 fix round 3 (G7): a `null` args_hash cannot be correlated across calls
  // (`hasRetryAfterErrorNoRecovery`'s own `if (!r.args_hash) continue;` guard, and the module
  // header, both say so) - this pins the CONSEQUENCE directly rather than trusting the guard exists.
  // A LAST row that is itself `ok` is essential here: two null-hash errors alone would also satisfy
  // F1 (last call error) regardless of F2, so this would derive -1 either way and prove nothing
  // about the guard specifically. With the guard removed, a buggy implementation would group both
  // null-hash rows under one key, see "recurs, never reaches ok" (within that GROUP, not the whole
  // window), and wrongly derive -1 via F2 even though the window's actual last call is ok.
  it("two errors with args_hash: null do not form an F2 retry group, even though they would match if hashed", () => {
    const rows = [
      row({ tool: "write_note", args_hash: null, status: "error", ts: 1 }),
      row({ tool: "write_note", args_hash: null, status: "error", ts: 2 }),
      row({ tool: "read_note", args_hash: null, status: "ok", ts: 3 }), // unrelated, ends the window ok
    ];
    // Not F1 (last call is ok), not F2 (args_hash: null excludes both errors from any retry group),
    // not S1 (no search precedes the read) -> 0.
    expect(deriveWindowVerdict(rows)).toBe(0);
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

  // THE-726 review round 1 BLOCKING #1: v1 set sawSearch on ANY search-family row regardless of
  // status, so an ERRORED search followed by an unrelated successful read derived +1 and fed a
  // POSITIVE preferred.search_mode delta for the tool that had just failed. Reproduced exactly as
  // the reviewer's probe: search_text status=error, then read_note ok.
  it("an ERRORED search followed by a successful read does NOT satisfy S1 — no longer derives +1", () => {
    const rows = [
      row({ tool: "search_text", status: "error", ts: 1 }),
      row({ tool: "read_note", status: "ok", ts: 2 }),
    ];
    // Not F1 (last call is ok), not F2 (no recurring args_hash), not S1 (the seeding search errored)
    // -> S2 is false -> 0, not +1. This is the exact fix: a failed search proves nothing was found
    // to look at, so a read afterward is not evidence of a successful browse.
    expect(deriveWindowVerdict(rows)).toBe(0);
  });

  it("an errored search does not count toward S1 even when a LATER successful search seeds it", () => {
    const rows = [
      row({ tool: "search_text", status: "error", ts: 1 }),
      row({ tool: "search_vault", status: "ok", ts: 2 }),
      row({ tool: "read_note", status: "ok", ts: 3 }),
    ];
    // The errored search_text must not seed S1; search_vault (ok) does, and read_note follows it ->
    // a genuine +1, distinguishing "the errored search is excluded" from "no search ever seeds it".
    expect(deriveWindowVerdict(rows)).toBe(1);
  });

  it("an OK search followed by a read still derives +1 — the fix does not disable S1 itself", () => {
    const rows = [
      row({ tool: "search_text", status: "ok", ts: 1 }),
      row({ tool: "read_note", status: "ok", ts: 2 }),
    ];
    expect(deriveWindowVerdict(rows)).toBe(1);
  });

  // THE-726 fix round 3, G1 (cross-vendor finding on PR #882, same class of defect as BLOCKING #1
  // above, on the OTHER side of S1): an OK search followed by an ERRORED read still satisfied S1 as
  // long as a LATER, unrelated call happened to end `ok` - `search ok, read error, write ok (last)`
  // derived +1 and fed a positive `preferred.search_mode` delta for a browse that never actually
  // succeeded. Reproduced exactly as the finding's own scenario.
  it("an OK search followed by an ERRORED read does NOT satisfy S1 by itself - no longer derives +1", () => {
    const rows = [
      row({ tool: "search_text", status: "ok", ts: 1 }),
      row({ tool: "read_note", status: "error", ts: 2 }),
      row({ tool: "write_note", status: "ok", ts: 3 }),
    ];
    // Not F1 (last call is ok), not F2 (no recurring args_hash), not S1 (the read that followed the
    // ok search itself errored) -> S2 is false -> 0, not +1. The LAST call being ok is not enough;
    // the read that actually satisfies S1 must be the one that ends ok.
    expect(deriveWindowVerdict(rows)).toBe(0);
  });

  it("an OK search, an ERRORED read, then a LATER OK read still derives +1 - the later successful read satisfies S1", () => {
    const rows = [
      row({ tool: "search_text", status: "ok", ts: 1 }),
      row({ tool: "read_note", status: "error", ts: 2 }),
      row({ tool: "read_note", status: "ok", ts: 3 }),
    ];
    // The errored read does not clear `sawOkSearch`; the SECOND read (ok) satisfies S1, and it is
    // also the last call -> S2 -> +1. Distinguishes "the errored read itself is excluded" from "no
    // read after an errored one can ever seed S1".
    expect(deriveWindowVerdict(rows)).toBe(1);
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

// THE-726 review round 1 BLOCKING #2: `a.ts - b.ts` alone has no tiebreaker, so two rows sharing
// one `ts` sorted DIFFERENTLY depending on which order the array (or the DB) happened to hand them
// back — the reviewer reproduced opposite verdicts for the identical pair (ok@5, error@5) in
// opposite array order. The round-1 fix broke the tie on `id`, deterministically.
//
// THE-726 fix round 3, G2b (cross-vendor finding): `id` is `genEpisodeId()` - random hex - so it is
// STABLE (same input always sorts the same way) but not CAUSAL: it has no relationship to the
// actual dispatch order. A same-millisecond dispatch of `search_text ok` then `write_note error`
// (in that order) must derive -1 (F1: the error really was last), but with an id-based tiebreak the
// verdict depended on which random id happened to sort last - reproducibly WRONG whenever the
// error's id sorted first. The fix breaks the tie on `seq` (SQL `rowid`, real capture order)
// instead; these tests now pick ids that sort AGAINST the intended seq/capture order specifically
// to prove `id` no longer participates in the comparison at all.
describe("deriveWindowVerdict: tied ts is broken deterministically by seq/capture order, not id (THE-726 fix round 3)", () => {
  it("a tied pair (ok, error at the same ts) derives the SAME verdict in both array orders", () => {
    // seq (capture order): ok=1, error=2 -> error is last, F1 -> -1. Ids deliberately sort the
    // OPPOSITE way ("b" < ... no: chosen so id order would put error FIRST, ok LAST, the wrong
    // answer an id-based tiebreak would have given).
    const ok = row({ id: "z-ok", seq: 1, tool: "write_note", status: "ok", ts: 5 });
    const err = row({ id: "a-err", seq: 2, tool: "write_note", status: "error", ts: 5 });
    const verdictOkFirst = deriveWindowVerdict([ok, err]);
    const verdictErrFirst = deriveWindowVerdict([err, ok]);
    expect(verdictOkFirst).toBe(verdictErrFirst);
    expect(verdictOkFirst).toBe(-1); // F1: the seq-broken-tie last call is the error
  });

  it("a tied pair sorts by seq when ts is equal, not by id or array position", () => {
    // seq: errFirst=1, okLast=2 -> ok is last by seq -> not F1 -> 0. Ids are picked to sort the
    // OPPOSITE way ("a-err" < "z-ok" alphabetically), so this only passes if seq, not id, decides.
    const okLast = row({ id: "z-ok", seq: 2, tool: "write_note", status: "ok", ts: 9 });
    const errFirst = row({ id: "a-err", seq: 1, tool: "write_note", status: "error", ts: 9 });
    expect(deriveWindowVerdict([okLast, errFirst])).toBe(0); // last-by-seq is okLast -> not F1
    expect(deriveWindowVerdict([errFirst, okLast])).toBe(0); // same regardless of array order
  });

  // THE-726 fix round 3, G2b: the finding's own scenario, exactly. Dispatched in this order:
  // `search_text` ok (first), `write_note` error (second), both at one millisecond. The ids are
  // picked BY HAND to sort against that insertion order - an id-based tiebreak would put the error
  // FIRST and the ok call LAST, deriving 0 (missing F1 entirely, and symmetrically missing S1 on a
  // search-then-read pair). The verdict must follow capture order, not the ids.
  it("a same-ts dispatch (search ok, then write error, in that capture order) derives -1 even when the ids sort the opposite way", () => {
    const searchOk = row({ id: "z-search", seq: 1, tool: "search_text", status: "ok", ts: 7 });
    const writeErr = row({ id: "a-write", seq: 2, tool: "write_note", status: "error", ts: 7 });
    expect(deriveWindowVerdict([searchOk, writeErr])).toBe(-1); // F1: seq-order last is the error
    expect(deriveWindowVerdict([writeErr, searchOk])).toBe(-1); // same regardless of array order
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

/** THE-726 fix round 3 (G7): a full structural + content fingerprint of a database, not one row -
 *  the previous "does not write to cache.db" check only compared `workspace_sessions` row 'sess_a'
 *  before and after, which would not have caught a write to any OTHER table, or a second row
 *  inserted or deleted in the SAME table. Every table `sqlite_master` names, its row count, and a
 *  content hash (so a same-count UPDATE that changes bytes still shows up) all have to match. */
function dbFingerprint(db: Database): {
  tables: string[];
  rowCounts: Record<string, number>;
  hash: string;
} {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const rowCounts: Record<string, number> = {};
  const hash = createHash("sha256");
  for (const t of tables) {
    let rows: unknown[];
    try {
      rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    } catch {
      // A `WITHOUT ROWID` table (e.g. acl_path_members, cache.db) has no `rowid` column at all -
      // its natural scan order is already primary-key order (it IS the b-tree keyed by PK), which
      // is deterministic without an explicit ORDER BY.
      rows = db.prepare(`SELECT * FROM ${t}`).all();
    }
    rowCounts[t] = rows.length;
    hash.update(t);
    hash.update(JSON.stringify(rows));
  }
  return { tables, rowCounts, hash: hash.digest("hex") };
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
    expect(out.stamped).toEqual({ minus: 0, zero: 0, plus: 1, drained: 0 }); // search then read, ends ok -> +1
    expect(episodeRow(edb, closedRow).task_result).toBe(1);
    expect(episodeRow(edb, readRow).task_result).toBe(1);
    expect(episodeRow(edb, liveRow).task_result).toBeNull(); // untouched — its session never ended
  });

  // THE-726 fix round 3 (G7): the boundary case for both `<=` comparisons this pass relies on -
  // `loadWindow`'s `ts <= ?` (ended_at) and `stampOpenWindow`'s own `ts <= ?` (asOf). A row whose
  // `ts` is EXACTLY `ended_at` must be IN bounds and genuinely stamped, not treated as past the
  // window (which would silently starve it the same way BLOCKING #4 did) or fall into the drain
  // path (which is for a window that is entirely OUT of bounds, not one sitting exactly on it).
  it("a row whose ts equals ended_at exactly is in-bounds, stamped, and NOT drained", async () => {
    const { cacheDb, edb } = stores();
    const endedAt = NOW - 5000;
    seedSession(cacheDb, "sess_a", { endedAt });
    const id = seedEpisode(edb, { session: "sess_a", tool: "write_note", ts: endedAt });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.stamped).toEqual({ minus: 0, zero: 1, plus: 0, drained: 0 });
    const r = episodeRow(edb, id);
    expect(r.task_result).toBe(0); // rules-judged neutral (no F/S evidence), not the drain path
    expect(r.verdict_policy).toBe(DERIVATION_POLICY_VERSION);
    const verdictAt = (
      edb.prepare("SELECT verdict_at AS v FROM agent_episodes WHERE id = ?").get(id) as {
        v: number;
      }
    ).v;
    expect(verdictAt).toBe(endedAt); // the session's own ended_at, not widened to nowMs
  });

  it("a second pass finds no open rows — idempotent", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    seedEpisode(edb, { session: "sess_a", tool: "read_note", status: "ok" });

    const first = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(first.sessionsSeen).toBe(1);
    const second = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(second.sessionsSeen).toBe(0);
    expect(second.stamped).toEqual({ minus: 0, zero: 0, plus: 0, drained: 0 });
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

  // THE-726 review round 1 BLOCKING #4: a genuinely empty in-bounds window (every open row's `ts`
  // exceeds its own session's `ended_at`) used to leave the rows NULL forever — this session would
  // be re-selected as a candidate and re-derive null on every future pass, permanently starving the
  // oldest-first cap. The fix widens the ceiling to `nowMs` and stamps a NEUTRAL terminal verdict so
  // the rows leave the debt set.
  //
  // THE-726 fix round 2: this drain stamp writes `verdict_policy = TERMINAL_DRAIN_POLICY` (0), not
  // `DERIVATION_POLICY_VERSION`, and lands in `stamped.drained`, not `stamped.zero`. It is
  // structurally distinct from a rule genuinely returning 0, which the next test pins.
  it("a window entirely past its session's ended_at gets a NEUTRAL terminal stamp (verdict_at = nowMs), not left open forever", async () => {
    const { cacheDb, edb } = stores();
    const endedAt = NOW - 5000;
    seedSession(cacheDb, "sess_a", { endedAt });
    // Every open row postdates ended_at — nothing is in the ORIGINAL bound to judge.
    const id = seedEpisode(edb, { session: "sess_a", tool: "read_note", ts: endedAt + 1000 });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.sessionsSeen).toBe(1);
    expect(out.skipped).toBe(0); // it WAS stamped — terminal, not skipped
    expect(out.stamped).toEqual({ minus: 0, zero: 0, plus: 0, drained: 1 });
    const r = episodeRow(edb, id);
    expect(r.task_result).toBe(0);
    expect(r.verdict_source).toBe("derived");
    expect(r.verdict_policy).toBe(TERMINAL_DRAIN_POLICY);
    const verdictAt = (
      edb.prepare("SELECT verdict_at AS v FROM agent_episodes WHERE id = ?").get(id) as {
        v: number;
      }
    ).v;
    expect(verdictAt).toBe(NOW); // widened to nowMs, not the session's own (too-early) ended_at

    // Idempotent afterward — the row is no longer open, so a second pass finds nothing for it.
    const second = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW + 1 });
    expect(second.sessionsSeen).toBe(0);
  });

  // THE-726 fix round 2: the counterpart to the drain test above. A window IN BOUNDS that a rule
  // genuinely derives as 0 (no F1/F2/S1/S2 evidence either way) lands under DERIVATION_POLICY_VERSION
  // and `stamped.zero`, never `TERMINAL_DRAIN_POLICY`/`stamped.drained`. Same `task_result = 0`,
  // different provenance: this is the distinction the fix exists to make queryable.
  it("a rules-judged neutral window (no F/S evidence) lands under DERIVATION_POLICY_VERSION and stamped.zero, not the drain bucket", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    // In bounds (ts <= ended_at), no search/read/error signal at all -> deriveWindowVerdict returns
    // 0 by rule, not null.
    const id = seedEpisode(edb, { session: "sess_a", tool: "write_note", ts: NOW - 8000 });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.stamped).toEqual({ minus: 0, zero: 1, plus: 0, drained: 0 });
    const r = episodeRow(edb, id);
    expect(r.task_result).toBe(0);
    expect(r.verdict_policy).toBe(DERIVATION_POLICY_VERSION);
  });

  it("a stuck (permanently-empty-window) session no longer starves a newer derivable one at limit: 1", async () => {
    // Reproduces the reviewer's probe: over several passes at limit 1, a stuck oldest session used
    // to be re-selected and re-skipped forever, and a newer, perfectly derivable session was NEVER
    // reached. With the terminal-stamp fix, pass 1 fully resolves the stuck session (nothing left
    // open in it), so pass 2 reaches the newer one.
    const { cacheDb, edb } = stores();
    const stuckEndedAt = NOW - 9000;
    seedSession(cacheDb, "stuck", { endedAt: stuckEndedAt });
    const stuckRow = seedEpisode(edb, {
      session: "stuck",
      tool: "read_note",
      ts: stuckEndedAt + 500,
    }); // postdates ended_at
    seedSession(cacheDb, "newer", { endedAt: NOW - 1000 });
    const newerRow = seedEpisode(edb, { session: "newer", tool: "read_note", ts: NOW - 2000 });

    let firstPass: Awaited<ReturnType<typeof deriveClosedWindows>> | undefined;
    for (let pass = 0; pass < 5; pass++) {
      const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW, limit: 1 });
      if (pass === 0) firstPass = out;
    }
    expect(episodeRow(edb, newerRow).task_result).not.toBeNull();
    // THE-726 fix round 2: the stuck row lands with verdict_policy = TERMINAL_DRAIN_POLICY (0), and
    // pass 1's own outcome counts it under `drained`, not `zero`.
    expect(firstPass?.stamped).toEqual({ minus: 0, zero: 0, plus: 0, drained: 1 });
    expect(episodeRow(edb, stuckRow).verdict_policy).toBe(TERMINAL_DRAIN_POLICY);
  });

  it("does not write to cache.db - a full snapshot (every table, row counts, content hash) is unchanged", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    seedEpisode(edb, { session: "sess_a", tool: "read_note", status: "ok" });
    const before = dbFingerprint(cacheDb);
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    const after = dbFingerprint(cacheDb);
    expect(after).toEqual(before);
    // The floor: this is a real, non-empty fixture, not an accidental pass over zero tables.
    expect(before.tables.length).toBeGreaterThan(0);
    expect(before.rowCounts.workspace_sessions).toBe(1);
  });

  // THE-726 fix round 3 (G7): the previous version of this test only checked the STAMPED COLUMNS
  // (task_result/session_id/verdict_at), which pins that stampOpenWindow ran but nothing about
  // extractPreferences actually reading them the way it claims to. This drives the REAL
  // extractPreferences and asserts the delta it produces is a "weaken" op - a regression that broke
  // the -1 evidence path (say, groupEpisodesByVerdictWindow silently dropping derived rows) would
  // pass the old version and fail this one.
  it("a -1 window derived here feeds extractPreferences the same way an operator -1 does (weaken)", async () => {
    const { cacheDb, edb } = stores();
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    // Establish the key exactly the way a prior +1 extraction would (reflect-evaluator.test.ts's own
    // pattern for this exact assertion) - isolated via applyPreferenceDeltas directly, so the
    // derived -1 window below is the ONLY thing this extractPreferences call re-derives.
    applyPreferenceDeltas(
      edb,
      "main",
      [{ key: "preferred.search_mode", op: "add", value: "search_text", scopeCaller: "alice" }],
      NOW - 20_000,
    );
    // A terminal error -> F1 -> -1.
    seedEpisode(edb, {
      session: "sess_a",
      tool: "search_text",
      status: "error",
      ts: NOW - 8000,
    });
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    // Flag off -> the derived -1 does not hold; it promotes to 'eligible', which is the only
    // eligibility state extractPreferences reads evidence from.
    await evaluateEpisodes(edb, { nowMs: NOW, derivedVerdictHold: false });
    const r = await extractPreferences(edb, "main", { nowMs: NOW });
    expect(r).toMatchObject({ skipped: false, applied: 1 });

    const weaken = edb
      .prepare(
        "SELECT key, op, value FROM preference_deltas WHERE vault_id = 'main' AND op = 'weaken'",
      )
      .get() as { key: string; op: string; value: string } | undefined;
    expect(weaken).toEqual({ key: "preferred.search_mode", op: "weaken", value: "search_text" });
  });

  // THE-726 review round 1 BLOCKING #3 (second half): a cache.db that exists as a FILE but was
  // never provisioned (no migrations run — `openDatabase` creates an empty file) has no
  // `workspace_sessions` table. Reachable today: `obsidian-tc reflect` against a cacheDir the
  // server never booted. Mirrors maintenance.ts's `job_schedule` guard.
  it("no-ops cleanly when cache.db has no workspace_sessions table, rather than throwing", async () => {
    const bareCacheDb = openMemoryDb(); // NOT provisionCacheDb()'d — no tables at all
    const edb = openMemoryDb();
    runMigrations(edb, EXPERIENTIAL_CHAIN);
    seedEpisode(edb, { session: "sess_a", tool: "read_note" });

    const out = await deriveClosedWindows(edb, bareCacheDb, { nowMs: NOW });
    expect(out).toEqual({
      sessionsSeen: 0,
      stamped: { minus: 0, zero: 0, plus: 0, drained: 0 },
      skipped: 0,
    });
  });

  // THE-726 review round 1 BLOCKING #4 (second half): candidateIds is bounded IN THE SQL (a LIMIT
  // in the query, not a slice of an unbounded result), so the next step's `IN (...)` expansion can
  // never ask for more bind parameters than the cap regardless of backlog size.
  it("the candidate session scan is bounded — a backlog far larger than the cap does not make every session a candidate in one pass", async () => {
    const { cacheDb, edb } = stores();
    const backlogSize = MAX_CANDIDATE_SESSIONS + 5;
    for (let i = 0; i < backlogSize; i++) {
      const id = `bulk-${i}`;
      seedSession(cacheDb, id, { endedAt: NOW - 1000 - i }); // each with a distinct, older ended_at
      seedEpisode(edb, { session: id, tool: "read_note", ts: NOW - 5000 - i });
    }
    // A `limit` far larger than the cap: if candidateIds were unbounded, sessionsSeen would equal
    // the whole backlog. It cannot, because the candidate SELECT itself caps at MAX_CANDIDATE_SESSIONS.
    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW, limit: backlogSize });
    expect(out.sessionsSeen).toBeLessThan(backlogSize);
    expect(out.sessionsSeen).toBeLessThanOrEqual(MAX_CANDIDATE_SESSIONS);
  }, 20_000);

  // THE-726 fix round 3 (G2): open sessions (cache.db `ended_at IS NULL`) used to occupy candidate
  // slots the same as ended ones - enough of them (>= the cap) meant an ended session with real
  // debt was NEVER reached, no matter how old its debt was. Lowers the cap via
  // `opts.maxCandidateSessions` to make this reproducible without seeding thousands of rows.
  it("open sessions cannot occupy every candidate slot - an ended session is still derived even when open sessions with debt outnumber the (lowered) cap", async () => {
    const { cacheDb, edb } = stores();
    const cap = 3;
    // cap-plus-one OPEN sessions, each with debt OLDER than the ended session below - under the
    // pre-fix behavior these alone would fill the entire (lowered) candidate cap.
    for (let i = 0; i < cap + 1; i++) {
      const id = `open-${i}`;
      seedSession(cacheDb, id, { endedAt: null });
      seedEpisode(edb, { session: id, tool: "read_note", ts: NOW - 9000 - i });
    }
    seedSession(cacheDb, "ended", { endedAt: NOW - 1000 });
    const endedRow = seedEpisode(edb, { session: "ended", tool: "read_note", ts: NOW - 1500 });

    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW, maxCandidateSessions: cap });
    expect(out.sessionsSeen).toBe(1);
    expect(episodeRow(edb, endedRow).task_result).not.toBeNull();
  });

  // THE-726 fix round 3 (G2b, candidate ordering): the candidate scan orders by oldest debt first
  // (`MIN(ts) ASC`), not insertion order, so the (lowered) cap always keeps the globally oldest
  // debt inside it even when `cap`-plus-one OTHER ended sessions are competing for the same slots.
  it("the (lowered) candidate cap keeps the OLDEST debt inside it among cap-plus-one ended sessions", async () => {
    const { cacheDb, edb } = stores();
    const cap = 3;
    seedSession(cacheDb, "s-oldest", { endedAt: NOW - 8000 });
    const oldestRow = seedEpisode(edb, { session: "s-oldest", tool: "read_note", ts: NOW - 9000 });
    for (let i = 0; i < cap; i++) {
      const id = `s-newer-${i}`;
      seedSession(cacheDb, id, { endedAt: NOW - 1000 - i });
      seedEpisode(edb, { session: id, tool: "read_note", ts: NOW - 2000 - i });
    }
    // Total sessions = cap + 1 (s-oldest plus `cap` newer ones).
    await deriveClosedWindows(edb, cacheDb, { nowMs: NOW, maxCandidateSessions: cap });
    expect(episodeRow(edb, oldestRow).task_result).not.toBeNull();
  });

  // THE-726 review round 1 FOLD-IN #11: the module comment used to claim a session carries AT MOST
  // ONE window ever ("the two writers cannot race... the window definitions are simply disjoint").
  // False: `work_result` accepts an explicit `asOf`, so an operator can judge only PART of a
  // session and leave the rest open for the derived pass once the session ends. This is fine
  // (disjoint by verdict_at, per the window-identity design) but the comment overstated it — this
  // pins the actual coexistence the corrected comment describes.
  it("a session can carry BOTH an operator window (partial, via asOf) and a later derived window on the remainder", async () => {
    const { cacheDb, edb } = stores();
    const operatorAsOf = NOW - 6000;
    seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
    const early = seedEpisode(edb, { session: "sess_a", tool: "write_note", ts: NOW - 7000 });
    const late = seedEpisode(edb, { session: "sess_a", tool: "read_note", ts: NOW - 3000 });
    // The operator judges only up to `operatorAsOf` — `early` is in bounds, `late` is not.
    edb
      .prepare(
        `UPDATE agent_episodes SET task_result = 1, verdict_at = ?, verdict_source = 'operator'
          WHERE session_id = 'sess_a' AND ts <= ?`,
      )
      .run(operatorAsOf, operatorAsOf);
    expect(episodeRow(edb, early).verdict_source).toBe("operator");
    expect(episodeRow(edb, late).task_result).toBeNull(); // left open by the operator's asOf

    // The session later ends; the derived pass picks up exactly the leftover work.
    const out = await deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
    expect(out.sessionsSeen).toBe(1);
    const lateRow = episodeRow(edb, late);
    expect(lateRow.verdict_source).toBe("derived");
    expect(lateRow.task_result).not.toBeNull();

    // Two distinct judgements on ONE session — disjoint verdict_at, both present, neither
    // overwritten.
    const verdictAts = edb
      .prepare("SELECT DISTINCT verdict_at AS v FROM agent_episodes WHERE session_id = 'sess_a'")
      .all() as Array<{ v: number }>;
    expect(verdictAts).toHaveLength(2);
    expect(episodeRow(edb, early).verdict_source).toBe("operator"); // still untouched
  });
});

// THE-726: the PASS-ORDERING requirement — a derived -1 written in a pass must be visible to the
// hold rule in that SAME pass (registerEpisodeEvaluation calls deriveClosedWindows immediately
// before evaluateEpisodes, in one `run`).
//
// THE-726 fix round 3 (G7): the previous version of this describe block called deriveClosedWindows
// and evaluateEpisodes directly, one after the other - which pins that CALLING THEM IN THIS ORDER
// produces the right result, but says nothing about whether registerEpisodeEvaluation's own `run`
// (the actual production wiring, episode-evaluation-schedule.ts) really calls them in that order,
// in ONE tick. A regression that reordered or decoupled them there would pass the old version of
// this test and still fail in production. These now drive the REAL scheduler with a call log
// recording which of the two ran first.
describe("derive -> evaluate, same pass (THE-726 pass ordering)", () => {
  it("registerEpisodeEvaluation calls deriveClosedWindows before evaluateEpisodes in one tick - a derived -1 is held when derivedVerdictHold is on", async () => {
    vi.useFakeTimers();
    try {
      const { cacheDb, edb } = stores();
      seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
      const id = seedEpisode(edb, {
        session: "sess_a",
        tool: "write_note",
        status: "error",
        ts: NOW - 8000,
      });
      const callLog: string[] = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb,
        intervalMs: 1000,
        now: () => NOW,
        derivedVerdictHold: true,
        deriveClosedWindows: async () => {
          callLog.push("derive");
          return deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
        },
        onEvaluate: () => callLog.push("evaluate"),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      await sched.stop();

      expect(callLog).toEqual(["derive", "evaluate"]);
      const row = edb
        .prepare("SELECT eligibility, eligibility_reason FROM agent_episodes WHERE id = ?")
        .get(id) as { eligibility: string; eligibility_reason: string };
      expect(row.eligibility).toBe("pending");
      expect(row.eligibility_reason).toBe("held_bad_task_result");
    } finally {
      vi.useRealTimers();
    }
  });

  it("registerEpisodeEvaluation calls deriveClosedWindows before evaluateEpisodes in one tick - a derived -1 is promoted with promoted_stable when derivedVerdictHold is off", async () => {
    vi.useFakeTimers();
    try {
      const { cacheDb, edb } = stores();
      seedSession(cacheDb, "sess_a", { endedAt: NOW - 1000 });
      const id = seedEpisode(edb, {
        session: "sess_a",
        tool: "write_note",
        status: "error",
        ts: NOW - 8000,
      });
      const callLog: string[] = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb,
        intervalMs: 1000,
        now: () => NOW,
        derivedVerdictHold: false,
        deriveClosedWindows: async () => {
          callLog.push("derive");
          return deriveClosedWindows(edb, cacheDb, { nowMs: NOW });
        },
        onEvaluate: () => callLog.push("evaluate"),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      await sched.stop();

      expect(callLog).toEqual(["derive", "evaluate"]);
      const row = edb
        .prepare("SELECT eligibility, eligibility_reason FROM agent_episodes WHERE id = ?")
        .get(id) as { eligibility: string; eligibility_reason: string };
      expect(row.eligibility).toBe("eligible");
      expect(row.eligibility_reason).toBe("promoted_stable");
    } finally {
      vi.useRealTimers();
    }
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
