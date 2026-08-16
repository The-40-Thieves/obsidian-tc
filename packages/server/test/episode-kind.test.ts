// THE-839 — `agent_episodes.episode_type` is structural, not a name guess.
//
// The producer used to write the literal 'tool_call' for every captured operation, so the column
// held one distinct value across 630 live rows and 30.5% of them were MCP protocol methods
// mislabelled as tool calls. These tests pin the replacement at the two places it can regress:
// the DISPATCH SITE (which kind each entry point declares) and the BACKFILL (what the migration
// did to history).
//
// The slash test is the one that matters most and the one most likely to be deleted as redundant.
// It is not: SEP-986 ("Specify Format for Tool Names") permits `/` in tool names precisely so they
// can be hierarchical, with `user-profile/update` as a documented valid example. Every name-based
// scheme — including the `tool NOT LIKE '%/%'` predicate this ticket's parent design originally
// proposed — misclassifies that tool and keeps doing it silently. If someone reintroduces a name
// test, this is the test that fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { createEpisodeCapture } from "../src/experiential/episodes";
import { type CallerContext, type DispatchEpisode, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");

const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
];
/** The chain WITH this ticket's migration, for the backfill cases below. */
const EXP_CHAIN_BACKFILLED = [
  ...EXP_CHAIN,
  { version: "20260816_001", sql: read("20260816_001_episode_type_structural.sql") },
];

function expDb(chain = EXP_CHAIN): Database {
  const db = openMemoryDb();
  runMigrations(db, chain);
  return db;
}

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function ctx(db: Database): CallerContext {
  return {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
  };
}

/** A registry whose episode sink records into `seen`, so a test asserts what the DISPATCH SITE
 *  declared rather than what the sink chose to store. */
function registryCapturing(seen: DispatchEpisode[], tags?: string[]) {
  const registry = new ToolRegistry({ onEpisode: (e) => seen.push(e) });
  return { registry, tags };
}

function defineProbe(registry: ToolRegistry, name: string, tags?: string[]) {
  registry.register({
    name,
    domain: "knowledge",
    description: "probe",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    ...(tags ? { tags } : {}),
    handler: () => ({ ok: true }),
  });
}

describe("THE-839: the dispatch site declares the episode kind", () => {
  it("a registered tool through tools/call is a tool_call", async () => {
    const seen: DispatchEpisode[] = [];
    const { registry } = registryCapturing(seen);
    defineProbe(registry, "read_note");
    const db = cacheDb();
    await registry.dispatch("read_note", {}, ctx(db));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("tool_call");
    db.close?.();
  });

  it("a tool whose NAME contains a slash is still a tool_call (SEP-986)", async () => {
    // The regression test for the whole ticket. `user-profile/update` is a spec-valid tool name.
    // Any scheme that classifies by name calls this protocol traffic and silently stops judging it.
    const seen: DispatchEpisode[] = [];
    const { registry } = registryCapturing(seen);
    defineProbe(registry, "user-profile/update");
    const db = cacheDb();
    await registry.dispatch("user-profile/update", {}, ctx(db));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("tool_call");
    expect(seen[0]?.kind).not.toBe("protocol");
    db.close?.();
  });

  it("a tool tagged `verdict` is a verdict, so it cannot become its own evidence", async () => {
    const seen: DispatchEpisode[] = [];
    const { registry } = registryCapturing(seen);
    defineProbe(registry, "work_result", ["experiential", "verdict"]);
    const db = cacheDb();
    await registry.dispatch("work_result", {}, ctx(db));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("verdict");
    db.close?.();
  });

  it("an MCP protocol method through dispatchResource is protocol", async () => {
    const seen: DispatchEpisode[] = [];
    const { registry } = registryCapturing(seen);
    const db = cacheDb();
    await registry.dispatchResource("prompts/list", ctx(db), [], {}, () => ({ prompts: [] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("protocol");
    db.close?.();
  });

  it("the two entry points disagree on kind for the SAME name", async () => {
    // Proves the discriminator is the ENTRY POINT, not the string. Without this, all four cases
    // above would still pass if kind were derived from the name by coincidence.
    const seen: DispatchEpisode[] = [];
    const { registry } = registryCapturing(seen);
    defineProbe(registry, "ambiguous");
    const db = cacheDb();
    await registry.dispatch("ambiguous", {}, ctx(db));
    await registry.dispatchResource("ambiguous", ctx(db), [], {}, () => ({}));
    expect(seen.map((e) => e.kind)).toEqual(["tool_call", "protocol"]);
    db.close?.();
  });
});

describe("THE-839: the sink persists the declared kind", () => {
  const base = (over: Partial<DispatchEpisode>): DispatchEpisode => ({
    ts: 1_700_000_000_000,
    vaultId: "main",
    tool: "read_note",
    kind: "tool_call",
    caller: "tester",
    sessionId: null,
    status: "ok",
    errorCode: null,
    durationMs: 1,
    resultSize: 1,
    argsHash: "h",
    args: {},
    ...over,
  });

  it("writes episode_type from kind, not the old literal", () => {
    const db = expDb();
    const sink = createEpisodeCapture(db);
    sink(base({ kind: "tool_call" }));
    sink(base({ kind: "protocol", tool: "prompts/list" }));
    sink(base({ kind: "verdict", tool: "work_result" }));
    const rows = db
      .prepare("SELECT tool, episode_type FROM agent_episodes ORDER BY rowid")
      .all() as Array<{ tool: string; episode_type: string }>;
    expect(rows.map((r) => r.episode_type)).toEqual(["tool_call", "protocol", "verdict"]);
    db.close?.();
  });

  it("channel stays 'dispatch' — reserved, not repurposed", () => {
    // THE-839 item 4: `channel` is also a constant. It is deliberately NOT given invented values;
    // this pins that decision so a later change is a choice rather than a drift.
    const db = expDb();
    createEpisodeCapture(db)(base({ kind: "protocol", tool: "resources/list" }));
    const row = db.prepare("SELECT channel FROM agent_episodes").get() as { channel: string };
    expect(row.channel).toBe("dispatch");
    db.close?.();
  });
});

describe("THE-839: the backfill corrects history without touching real tool calls", () => {
  /** Seed BEFORE the backfill migration runs, mirroring the shape of the live corpus. */
  function seedPreBackfill(db: Database) {
    const ins = db.prepare(
      `INSERT INTO agent_episodes (id, ts, vault_id, channel, episode_type, tool, status, eligibility, blocked, valid_from)
       VALUES (?, ?, 'main', 'dispatch', 'tool_call', ?, 'ok', 'pending', 0, ?)`,
    );
    // Exactly the two slash-bearing names the production corpus contains, plus real tool calls.
    ins.run("e1", 1, "prompts/list", 1);
    ins.run("e2", 2, "resources/list", 2);
    ins.run("e3", 3, "read_note", 3);
    ins.run("e4", 4, "write_note", 4);
  }

  it("reclassifies protocol rows and leaves tool rows alone", () => {
    const db = expDb();
    seedPreBackfill(db);
    // Watched failing first, in effect: before the migration every row reads 'tool_call'.
    const before = db
      .prepare("SELECT COUNT(*) n FROM agent_episodes WHERE episode_type = 'tool_call'")
      .get() as { n: number };
    expect(before.n).toBe(4);

    runMigrations(db, [
      { version: "20260816_001", sql: read("20260816_001_episode_type_structural.sql") },
    ]);

    const rows = db
      .prepare("SELECT tool, episode_type FROM agent_episodes ORDER BY id")
      .all() as Array<{ tool: string; episode_type: string }>;
    expect(rows).toEqual([
      { tool: "prompts/list", episode_type: "protocol" },
      { tool: "resources/list", episode_type: "protocol" },
      // The half that matters as much as the first: no real tool call was reclassified.
      { tool: "read_note", episode_type: "tool_call" },
      { tool: "write_note", episode_type: "tool_call" },
    ]);
    db.close?.();
  });

  it("the full chain applies the backfill exactly once and is idempotent on re-run", () => {
    const db = expDb(EXP_CHAIN_BACKFILLED);
    createEpisodeCapture(db)({
      ts: 1,
      vaultId: "main",
      tool: "prompts/list",
      kind: "protocol",
      caller: "t",
      sessionId: null,
      status: "ok",
      errorCode: null,
      durationMs: 1,
      resultSize: 1,
      argsHash: "h",
      args: {},
    });
    // Re-running the UPDATE must not disturb a row the producer already wrote correctly.
    runMigrations(db, [
      { version: "20260816_002", sql: read("20260816_001_episode_type_structural.sql") },
    ]);
    const row = db.prepare("SELECT episode_type FROM agent_episodes").get() as {
      episode_type: string;
    };
    expect(row.episode_type).toBe("protocol");
    db.close?.();
  });
});
