// Every tool that touches principal-owned state declares `principalOwned`, so dispatch refuses a
// caller with no identity (a valid token with no `sub` is `caller: null`, and `IS ?` binds NULL as
// a value that matches every such credential). The set is DERIVED, not listed by hand:
//
//   1. the owner columns come from the migrated schema (any table with a `caller`, `principal` or
//      `scope_caller` column), so a new owned table is a failure here until it is classified;
//   2. the tools touching them come from the tool source: a `defineTool` block that names the
//      table in SQL, or calls an exported function of a module that does.
//
// A source scan is a heuristic, so it is pinned from both sides: a floor (the scan must find the
// tools we know touch these tables, or it matched nothing) and a stale-flag check (a tool that
// declares the flag must still reach an owned table).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const OWNER_COLUMN = /^(caller|principal|scope_caller)$/;

/** Tables whose owner column is a PARTITION a tool reads or writes by. A tool reaching one must
 *  declare `principalOwned`. */
const PARTITIONED = ["agent_episodes", "chunk_retrievals", "workspace_sessions"] as const;

/** Owner-column tables that are NOT a partition a tool serves, each with the reason. Every table
 *  the schema reports must be in exactly one of the two lists, so a new one fails until decided. */
const NOT_A_TOOL_PARTITION: Record<string, string> = {
  idempotency_keys:
    "keyed by principal and enforced in dispatch for EVERY tool (requireIdentifiedCaller on the key), not per tool",
  event_log:
    "audit rows written by dispatch; the caller column is a label, no tool partitions on it",
  elicit_tokens: "HITL confirmations are bound to the caller by elicit.ts itself, in dispatch",
  elicit_requests: "HITL confirmations are bound to the caller by elicit.ts itself, in dispatch",
  jobs: "task ownership: tasks.ts refuses an unidentified caller on every task surface",
  vault_context_watermark:
    "a per-caller diff cursor ('' for none); it discloses nothing another credential cannot already read",
  preference_profile: "derived by reflect from episodes; read through retrieval, never by owner",
  preference_deltas: "derived by reflect from episodes; read through retrieval, never by owner",
};

/** Tools that reach a partitioned table but are not owner-partitioned, each with the reason. */
const NOT_OWNER_PARTITIONED: Record<string, string> = {
  episode_stats:
    "aggregate counts only, k-anonymity floored, no row content, and `caller` is not a group_by",
  get_session_traces:
    "read:workspace window over a vault's traces; documented as not filtered by principal, and captured args are stripped",
  session_rerun:
    "admin:rerun + HITL; replays any session of the vault into a disposable sandbox by design",
  vault_context:
    "caller-independent except include_work, which checks requireIdentifiedCaller itself (vault-context.ts)",
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const sql = (table: string) => new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, "i");

function ownedTables(): string[] {
  const cache = openMemoryDb();
  provisionCacheDb(cache);
  const exp = openMemoryDb();
  runMigrations(
    exp,
    EXPERIENTIAL_MIGRATION_FILES.map((f) => ({
      version: versionOf(f),
      sql: readFileSync(join(SRC, "migrations", f), "utf8"),
    })),
  );
  const found = new Set<string>();
  for (const db of [cache, exp]) {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
      if (cols.some((c) => OWNER_COLUMN.test(c.name))) found.add(name);
    }
  }
  return [...found].sort();
}

/** table -> the tools whose `defineTool` block reaches it, directly or through a helper. */
function toolsTouching(tables: readonly string[], toolNames: readonly string[]) {
  const all = tsFiles(SRC).filter(
    (f) => !f.includes("/migrations") && !f.endsWith("migrations-embedded.ts"),
  );
  const toolDirs = join(SRC, "tools");
  // Exported helper -> the owned tables its module names in SQL.
  const helperTables = new Map<string, Set<string>>();
  // Helpers live outside src/tools (workspace/, experiential/) and in tool modules that define no
  // tool themselves (m8/feedback-scope.ts).
  for (const f of all) {
    const text = readFileSync(f, "utf8");
    if (f.startsWith(toolDirs) && text.includes("defineTool(")) continue;
    const hit = tables.filter((t) => sql(t).test(text));
    if (hit.length === 0) continue;
    for (const m of text.matchAll(/export (?:async )?function (\w+)/g)) {
      const set = helperTables.get(m[1] as string) ?? new Set<string>();
      for (const t of hit) set.add(t);
      helperTables.set(m[1] as string, set);
    }
  }
  const touched = new Map<string, Set<string>>();
  for (const f of all.filter((p) => p.startsWith(toolDirs))) {
    const text = readFileSync(f, "utf8");
    const starts = [...text.matchAll(/defineTool\(/g)].map((m) => m.index as number);
    starts.forEach((start, i) => {
      const block = text.slice(start, starts[i + 1] ?? text.length);
      const name = /name:\s*"(\w+)"/.exec(block)?.[1];
      if (!name || !toolNames.includes(name)) return;
      const hit = new Set<string>(tables.filter((t) => sql(t).test(block)));
      for (const [fn, ts] of helperTables)
        if (new RegExp(`\\b${fn}\\(`).test(block)) for (const t of ts) hit.add(t);
      if (hit.size > 0) touched.set(name, hit);
    });
  }
  return touched;
}

describe("principalOwned coverage", () => {
  const tables = ownedTables();
  const registry = buildFullRegistry().list();
  const names = registry.map((t) => t.name);
  const partitioned = tables.filter((t) => (PARTITIONED as readonly string[]).includes(t));
  const touched = toolsTouching(partitioned, names);
  const declared = new Set(registry.filter((t) => t.principalOwned === true).map((t) => t.name));

  it("classifies every table that has an owner column, in exactly one list", () => {
    // Floor: a schema that lost its owner columns would make everything below vacuous.
    expect(tables).toEqual(expect.arrayContaining([...PARTITIONED, "idempotency_keys"]));
    const classified = [...PARTITIONED, ...Object.keys(NOT_A_TOOL_PARTITION)].sort();
    expect(tables).toEqual(classified);
  });

  it("the scan finds the tools known to read owner-partitioned rows (not vacuous)", () => {
    for (const known of ["work_search", "work_episodes", "work_forget", "start_session"])
      expect([...touched.keys()], `scan missed ${known}`).toContain(known);
  });

  it("every tool reaching a partitioned table declares principalOwned, or says why not", () => {
    const missing = [...touched.keys()]
      .filter((n) => !declared.has(n) && !(n in NOT_OWNER_PARTITIONED))
      .sort();
    expect(
      missing,
      `tool(s) touching ${partitioned.join("/")} without \`principalOwned: true\` (or an entry in NOT_OWNER_PARTITIONED with a reason): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no exemption is stale: each names a registered tool that still reaches a table", () => {
    const stale = Object.keys(NOT_OWNER_PARTITIONED).filter(
      (n) => !names.includes(n) || declared.has(n) || !touched.has(n),
    );
    expect(
      stale,
      `stale or contradictory NOT_OWNER_PARTITIONED entries: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("no flag is stale: each principalOwned tool still reaches an owner-partitioned table", () => {
    const stale = [...declared].filter((n) => !touched.has(n)).sort();
    expect(stale, `principalOwned tool(s) that reach no owned table: ${stale.join(", ")}`).toEqual(
      [],
    );
  });
});
