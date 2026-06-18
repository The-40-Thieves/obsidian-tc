// M5 workspace session + JSONL trace model (THE-181, Domain 23): session row
// lifecycle (insert/get/idempotent end), the windowed session listing, and the
// append-only JSONL contract (round-trip, missing-file = empty, blank/torn-line
// resilience, ordering preserved).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import {
  appendTrace,
  endSession,
  genSessionId,
  getSession,
  insertSession,
  readTrace,
  sessionsInWindow,
  traceRelPath,
} from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function freshDb(): Database {
  const db = openMemoryDb();
  db.exec(schemaSql);
  return db;
}

describe("session ids + trace paths", () => {
  it("mints prefixed ids and builds the JSONL path", () => {
    expect(genSessionId()).toMatch(/^sess_[a-f0-9]{24}$/);
    expect(traceRelPath(".obsidian-tc/traces", "sess_1")).toBe(".obsidian-tc/traces/sess_1.jsonl");
    expect(traceRelPath("traces/", "sess_2")).toBe("traces/sess_2.jsonl");
  });
});

describe("session row lifecycle", () => {
  it("inserts, reads back, and idempotently ends a session", () => {
    const db = freshDb();
    const s = insertSession(db, {
      id: "sess_1",
      vaultId: "test",
      caller: "agent-x",
      startedAt: 1000,
      tracePath: ".obsidian-tc/traces/sess_1.jsonl",
      metadata: { goal: "demo" },
    });
    expect(s.ended_at).toBeNull();
    expect(s.metadata_json).toBe(JSON.stringify({ goal: "demo" }));
    expect(getSession(db, "sess_1")?.caller).toBe("agent-x");

    expect(endSession(db, "sess_1", 2000)).toEqual({ changes: 1 });
    expect(getSession(db, "sess_1")?.ended_at).toBe(2000);
    // A second end is a no-op (does not overwrite the original ended_at).
    expect(endSession(db, "sess_1", 9999)).toEqual({ changes: 0 });
    expect(getSession(db, "sess_1")?.ended_at).toBe(2000);
  });

  it("lists sessions in a started-at window, newest first", () => {
    const db = freshDb();
    for (const [id, at] of [
      ["sess_a", 100],
      ["sess_b", 200],
      ["sess_c", 300],
    ] as const) {
      insertSession(db, {
        id,
        vaultId: "test",
        caller: null,
        startedAt: at,
        tracePath: `t/${id}.jsonl`,
      });
    }
    insertSession(db, {
      id: "other",
      vaultId: "elsewhere",
      caller: null,
      startedAt: 250,
      tracePath: "t/o.jsonl",
    });
    const win = sessionsInWindow(db, "test", 150, 350);
    expect(win.map((s) => s.id)).toEqual(["sess_c", "sess_b"]);
  });
});

describe("append-only JSONL trace", () => {
  function tempFile(): { abs: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "obtc-trace-"));
    return {
      abs: join(dir, "sub", "sess.jsonl"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("returns [] for a missing trace file", () => {
    const f = tempFile();
    try {
      expect(readTrace(f.abs)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("appends records one per line and replays them in order (creating dirs)", () => {
    const f = tempFile();
    try {
      appendTrace(f.abs, { ts: 1, type: "session_start", session_id: "sess_1" });
      appendTrace(f.abs, {
        ts: 2,
        type: "event",
        tool: "write_note",
        caller: "agent",
        args_hash: "abc",
      });
      appendTrace(f.abs, { ts: 3, type: "session_end", session_id: "sess_1" });
      const recs = readTrace(f.abs);
      expect(recs.map((r) => r.ts)).toEqual([1, 2, 3]);
      expect(recs[1]?.tool).toBe("write_note");
      // The on-disk form is exactly one JSON object per line.
      const lines = readFileSync(f.abs, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(3);
    } finally {
      f.cleanup();
    }
  });

  it("skips blank and torn (unparseable) lines during replay", () => {
    const f = tempFile();
    try {
      appendTrace(f.abs, { ts: 1, type: "event", tool: "a" });
      appendFileSync(f.abs, "\n");
      appendFileSync(f.abs, "{ this is not json\n"); // a torn write
      appendTrace(f.abs, { ts: 2, type: "event", tool: "b" });
      const recs = readTrace(f.abs);
      expect(recs.map((r) => r.tool)).toEqual(["a", "b"]);
    } finally {
      f.cleanup();
    }
  });
});
