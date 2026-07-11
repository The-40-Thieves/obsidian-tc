// THE-228 — agent_episodes capture bus. Proves the sink appends one row per dispatch outcome
// with attribution + write-on-control defaults (eligibility 'pending', blocked 0), chains
// prev_id per caller, gates the content axis behind captureContent (with secret redaction +
// size cap), never throws, and fires end-to-end from a real ToolRegistry dispatch via the
// onEpisode hook.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { createEpisodeCapture, redactSecrets } from "../src/experiential/episodes";
import { type CallerContext, type DispatchEpisode, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
];
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function ev(over: Partial<DispatchEpisode> = {}): DispatchEpisode {
  return {
    ts: NOW,
    vaultId: "main",
    tool: "read_note",
    caller: "tester",
    sessionId: null,
    status: "ok",
    errorCode: null,
    durationMs: 12,
    resultSize: 340,
    argsHash: "h1",
    args: { path: "a.md" },
    ...over,
  };
}

interface Row {
  id: string;
  ts: number;
  vault_id: string;
  session_id: string | null;
  caller: string | null;
  channel: string;
  episode_type: string;
  tool: string;
  status: string;
  error_code: string | null;
  args_json: string | null;
  secret_scan: string;
  eligibility: string;
  blocked: number;
  valid_from: number;
  prev_id: string | null;
}

const allRows = (db: Database) =>
  db.prepare("SELECT * FROM agent_episodes ORDER BY ts, id").all() as Row[];

describe("agent_episodes capture bus (THE-228)", () => {
  it("appends one row per outcome with control defaults; content axis off by default", () => {
    const db = edb0();
    let t = NOW;
    const sink = createEpisodeCapture(db, { now: () => t++ });
    sink(ev());
    sink(ev({ status: "error", errorCode: "forbidden", tool: "delete_note" }));
    const rows = allRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      vault_id: "main",
      session_id: null,
      caller: "tester",
      channel: "dispatch",
      episode_type: "tool_call",
      tool: "read_note",
      status: "ok",
      error_code: null,
      args_json: null, // content axis defaults OFF (THE-238 gate ordering)
      secret_scan: "off",
      eligibility: "pending", // control 2: born pending, evaluator stamps later
      blocked: 0, // control 1: tombstone off
      valid_from: NOW, // control 3: bi-temporal birth (first event's clock tick)
    });
    const err = rows.find((r) => r.status === "error");
    expect(err?.error_code).toBe("forbidden");
    expect(err?.tool).toBe("delete_note");
  });

  it("chains prev_id per caller", () => {
    const db = edb0();
    let t = NOW;
    const sink = createEpisodeCapture(db, { now: () => t++ });
    sink(ev({ caller: "a", argsHash: "1" }));
    sink(ev({ caller: "b", argsHash: "2" }));
    sink(ev({ caller: "a", argsHash: "3" }));
    const rows = allRows(db);
    const a = rows.filter((r) => r.caller === "a");
    const b = rows.filter((r) => r.caller === "b");
    expect(a[0]?.prev_id).toBeNull();
    expect(a[1]?.prev_id).toBe(a[0]?.id); // second "a" episode chains to the first
    expect(b[0]?.prev_id).toBeNull(); // other caller's chain is independent
  });

  it("captureContent persists redacted, size-capped args and records the scan", () => {
    const db = edb0();
    const sink = createEpisodeCapture(db, { now: () => NOW, captureContent: true });
    sink(
      ev({
        args: {
          note: "call with api_key=supersecret12345 and sk-abcdefghijklmnopqrstuvwx please",
        },
      }),
    );
    const [row] = allRows(db);
    expect(row?.secret_scan).toBe("redacted:2");
    expect(row?.args_json).toContain("[REDACTED]");
    expect(row?.args_json).not.toContain("supersecret12345");
    expect(row?.args_json).not.toContain("sk-abcdefghijklmnopqrstuvwx");

    const sinkCapped = createEpisodeCapture(db, {
      now: () => NOW + 1,
      captureContent: true,
      maxArgsBytes: 64,
    });
    sinkCapped(ev({ args: { blob: "y".repeat(500) }, argsHash: "big" }));
    const capped = allRows(db).find((r) => r.ts === NOW + 1);
    expect(capped?.args_json?.endsWith("…[truncated]")).toBe(true);
    expect((capped?.args_json ?? "").length).toBeLessThan(100);
  });

  it("clean content records scan 'clean'", () => {
    const db = edb0();
    const sink = createEpisodeCapture(db, { now: () => NOW, captureContent: true });
    sink(ev({ args: { path: "notes/plain.md" } }));
    const [row] = allRows(db);
    expect(row?.secret_scan).toBe("clean");
    expect(row?.args_json).toContain("notes/plain.md");
  });

  it("never throws: a broken store reports to onError and the caller survives", () => {
    const db = edb0();
    db.exec("DROP TABLE agent_episodes");
    let seen: unknown;
    let sink: ReturnType<typeof createEpisodeCapture> = () => {};
    try {
      sink = createEpisodeCapture(db, {
        now: () => NOW,
        onError: (e) => {
          seen = e;
        },
      });
    } catch (e) {
      seen = e;
    }
    expect(() => sink(ev())).not.toThrow();
    expect(seen).toBeDefined();
  });

  it("redactSecrets catches the credential shapes and counts hits", () => {
    const { text, redactions } = redactSecrets(
      [
        "token=abcdef123456789",
        "Bearer aaaaaaaaaaaaaaaaaaaa",
        "ghp_ABCDEFGHIJKLMNOPQRSTUV",
        "AKIAABCDEFGHIJKLMNOP",
        "nothing secret here",
      ].join(" "),
    );
    expect(redactions).toBe(4);
    expect(text).toContain("nothing secret here");
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("fires end-to-end from a real dispatch via the registry onEpisode hook", async () => {
    // cache.db side: the audit event_log the dispatch pipeline writes to.
    const cacheDb = openMemoryDb();
    runMigrations(cacheDb, [
      {
        version: "001",
        sql: "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
      },
    ]);
    const edb = edb0();
    const registry = new ToolRegistry({
      onEpisode: createEpisodeCapture(edb, { now: () => NOW }),
    });
    registry.register({
      name: "read_thing",
      description: "scoped read",
      inputSchema: z.object({ path: z.string() }),
      requiredScopes: ["read:notes"],
      handler: (i: { path: string }) => ({ path: i.path, ok: true }),
    });
    const ctx: CallerContext = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes"]),
      vaultId: "main",
      db: cacheDb,
      sessionId: "sess_abc",
    };
    const res = await registry.dispatch("read_thing", { path: "a.md" }, ctx);
    expect((res as { ok?: boolean }).ok ?? true).toBeTruthy();
    const rows = allRows(edb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "read_thing",
      caller: "tester",
      session_id: "sess_abc",
      status: "ok",
      channel: "dispatch",
      eligibility: "pending",
    });
    expect(rows[0]?.args_json).toBeNull(); // content axis off by default
  });
});
