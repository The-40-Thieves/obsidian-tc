// THE-605 — `forget --erase` destroys vault content with no `audit_events` (event_log) row. This
// pins the fix: `forgetEpisodeAudited`/`forgetNoteAudited` (cli/commands/forget.ts) wrap the
// THE-239 forget_log writers with a direct `writeEvent` call, gated on a real change happening —
// mirroring the `changes > 0` discipline THE-600 established for `work_forget` so a no-op forget
// (unknown path / not-found id) never writes a spurious audit row.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { forgetEpisodeAudited, forgetNoteAudited } from "../src/cli/commands/forget";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { verifyForgetLog } from "../src/experiential/forget";
import { argsHash } from "../src/hash";
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
    { version: "20260712_003", sql: sql("20260712_003_forget_log.sql") },
  ]);
  return db;
}

function cacheWithChunks(relPath: string): Database {
  const cache = openMemoryDb();
  provisionCacheDb(cache);
  cache
    .prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', 'c', ?, 10, ?, ?)",
    )
    .run("t1", relPath, "h1", NOW, NOW);
  return cache;
}

function eventLogRows(cacheDb: Database): Array<{
  ts: number;
  vault_id: string | null;
  tool_name: string | null;
  caller: string | null;
  duration_ms: number | null;
  result_size: number | null;
  status: string;
  error_code: string | null;
  args_hash: string | null;
  event_type: string | null;
}> {
  return cacheDb
    .prepare(
      "SELECT ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type FROM event_log WHERE tool_name = 'forget'",
    )
    .all() as ReturnType<typeof eventLogRows>;
}

function seedEpisode(edb: Database, id: string): void {
  edb
    .prepare(
      `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, eligibility, blocked, valid_from)
       VALUES (?, ?, 'alice', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0, ?)`,
    )
    .run(id, NOW, NOW);
}

describe("forgetNoteAudited (THE-605)", () => {
  it("forget --note --erase writes ONE audit_events row naming the erased path", () => {
    const edb = edb0();
    const cache = cacheWithChunks("notes/target.md");
    const r = forgetNoteAudited(edb, cache, {
      vaultId: "main",
      relPath: "notes/target.md",
      nowMs: NOW,
      erase: true,
    });
    expect(r.chunk_ids).toEqual(["t1"]);

    const rows = eventLogRows(cache);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.vault_id).toBe("main");
    expect(row?.tool_name).toBe("forget");
    expect(row?.status).toBe("ok");
    expect(row?.event_type).toBe("tool_invocation");
    // "naming the erased path": the row's args_hash is a deterministic hash of exactly the
    // identifying args recomputed here — anyone holding (kind, path, erase) can verify the row
    // corresponds to THIS path, the same reconstruction mechanism recordOutcome's own args_hash
    // relies on (mcp/registry.ts). Cross-referenced with the paired forget_log row (which carries
    // the literal path), the pair fully reconstructs what was destroyed.
    expect(row?.args_hash).toBe(
      argsHash("forget", { kind: "note", target: "notes/target.md", erase: true }),
    );
  });

  it("writes BOTH audit_events and forget_log — one is not the other (THE-600)", () => {
    const edb = edb0();
    const cache = cacheWithChunks("notes/target.md");
    forgetNoteAudited(edb, cache, {
      vaultId: "main",
      relPath: "notes/target.md",
      nowMs: NOW,
    });
    expect(verifyForgetLog(edb)).toEqual({ ok: true, entries: 1 });
    expect(eventLogRows(cache)).toHaveLength(1);
  });

  it("a no-op forget (unknown path) does not write a spurious audit_events row", () => {
    const edb = edb0();
    const cache = openMemoryDb();
    provisionCacheDb(cache); // no chunks seeded — the path was never indexed
    const r = forgetNoteAudited(edb, cache, {
      vaultId: "main",
      relPath: "notes/never-known.md",
      nowMs: NOW,
    });
    expect(r.chunk_ids).toHaveLength(0);
    expect(eventLogRows(cache)).toHaveLength(0);
  });
});

describe("forgetEpisodeAudited (THE-605)", () => {
  it("a found episode writes one audit_events row", () => {
    const edb = edb0();
    const cache = openMemoryDb();
    provisionCacheDb(cache);
    seedEpisode(edb, "e1");
    const r = forgetEpisodeAudited(edb, cache, "main", "e1", { nowMs: NOW, erase: true });
    expect(r.found).toBe(true);
    const rows = eventLogRows(cache);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.args_hash).toBe(
      argsHash("forget", { kind: "episode", target: "e1", erase: true }),
    );
  });

  it("an unknown episode id is a no-op — no audit_events row (mirrors work_forget's changes > 0)", () => {
    const edb = edb0();
    const cache = openMemoryDb();
    provisionCacheDb(cache);
    const r = forgetEpisodeAudited(edb, cache, "main", "nope", { nowMs: NOW });
    expect(r.found).toBe(false);
    expect(eventLogRows(cache)).toHaveLength(0);
    expect(verifyForgetLog(edb).entries).toBe(0); // forget_log agrees: nothing happened
  });
});

describe("auditForgetEvent fail-open reporting (THE-605 review)", () => {
  // recordOutcome's own fail-open catch (mcp/registry.ts:670) is paired with a metric AND
  // onAuditFailure (THE-457) so an operator watching server_health sees the audit trail going
  // lossy. The CLI has no such sink — its equivalent is a stderr warning, since an operator is
  // standing at the terminal. Force the write to throw (drop event_log out from under it) and
  // assert: the forget still succeeds, forget_log is unaffected, and the operator is told.
  it("a failed audit_events write still lets forget succeed, still writes forget_log, and warns on stderr", () => {
    const edb = edb0();
    const cache = cacheWithChunks("notes/target.md");
    cache.exec("DROP TABLE event_log"); // forces writeEvent to throw inside auditForgetEvent

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const r = forgetNoteAudited(edb, cache, {
        vaultId: "main",
        relPath: "notes/target.md",
        nowMs: NOW,
        erase: true,
      });
      // (a) the forget itself still succeeds — an audit-write fault must not mask or abort it.
      expect(r.chunk_ids).toEqual(["t1"]);
      // (b) forget_log (THE-239) is unaffected by the audit_events failure.
      expect(verifyForgetLog(edb)).toEqual({ ok: true, entries: 1 });
      // (c) the operator is told, not left to discover a silent gap later.
      const warnings = stderrSpy.mock.calls.map((c) => String(c[0]));
      const warned = warnings.some(
        (w) => /audit_events row could not be written/.test(w) && /forget_log entry/.test(w),
      );
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
