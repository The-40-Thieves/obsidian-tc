// Every tool that touches principal-owned state declares `principalOwned`, so dispatch refuses a
// caller with no identity (a valid token with no `sub` is `caller: null`, and `IS ?` binds NULL as
// a value that matches every such credential). The set is DERIVED, not listed by hand:
//
//   1. the owner columns come from the migrated schema (any table with a `caller`, `principal` or
//      `scope_caller` column), so a new owned table is a failure here until it is classified;
//   2. the tools touching them come from the tool source: a `defineTool` block that names the
//      table in SQL, or calls an exported function of a module that does.
//
// A tool reaching owner-partitioned state is in exactly one of three classes:
//
//   principalOwned           dispatch refuses a caller with no identity (the state is unusable
//                            without one: work memory, sessions);
//   degradesWithoutIdentity  the tool stays usable for such a caller (search must not be locked
//                            out) but, for it, reads and writes NO shared state: it takes the
//                            default instead. Each entry names the test that proves it;
//   exempt                   not owner-partitioned at all, with the reason.
//
// Two shapes of "state" are scanned: owner-column TABLES (above) and in-memory per-caller MAPS
// declared at module/factory scope in a tool file that keys on `ctx.caller`. The latter has no
// schema to derive from, so a new one is a failure here until classified.
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
const PARTITIONED = [
  "agent_episodes",
  "chunk_retrievals",
  "workspace_sessions",
  "preference_profile",
  "preference_deltas",
] as const;

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
};

/** A test that proves the null-caller path of a `degradesWithoutIdentity` tool touches no shared
 *  state. The coverage test checks the file exists and holds an `it(...)` with exactly this title. */
interface Proof {
  file: string;
  title: string;
}

/** Tools that keep per-caller state but stay usable for a caller with no identity, by touching none
 *  of it for that caller. NOT `principalOwned`: that would refuse search for a sub-less token. */
const DEGRADES_WITHOUT_IDENTITY: Record<string, { state: string; proofs: Proof[] }> = {
  search_vault: {
    state:
      "preference_profile: the caller-scoped `preferred.search_mode` row (experiential/search-mode-preference.ts)",
    proofs: [
      {
        file: "search-mode-preference.test.ts",
        title: "no identity: the read touches no store at all (nothing shared to steer or leak)",
      },
      {
        file: "search-mode-preference.test.ts",
        title: "no identity: two sub-less callers cannot influence each other's search mode",
      },
    ],
  },
  search_and_read: {
    state: "in-memory `selections` map: the continuation of a paged call, keyed by ctx.caller",
    proofs: [
      {
        file: "search-and-read.test.ts",
        title: "a second sub-less caller's search cannot replace the first one's remaining pages",
      },
    ],
  },
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
  // Exported helper -> the owned tables its own body names in SQL, or reaches through another
  // helper (search-mode-preference.ts names no table: `resolveSearchVaultMode` calls
  // `preferenceProfile`, which does). Helpers live outside src/tools (workspace/, experiential/) and
  // in tool modules that define no tool themselves (m8/feedback-scope.ts). A body is the text from
  // one `export function` to the next, so one module's many exports are told apart.
  const helperTables = new Map<string, Set<string>>();
  const bodies: Array<{ name: string; text: string }> = [];
  for (const f of all) {
    const text = readFileSync(f, "utf8");
    if (f.startsWith(toolDirs) && text.includes("defineTool(")) continue;
    const starts = [...text.matchAll(/^export (?:async )?function (\w+)/gm)];
    starts.forEach((m, i) => {
      bodies.push({
        name: m[1] as string,
        text: text.slice(m.index as number, starts[i + 1]?.index ?? text.length),
      });
    });
  }
  for (const b of bodies) {
    const hit = tables.filter((t) => sql(t).test(b.text));
    if (hit.length === 0) continue;
    const set = helperTables.get(b.name) ?? new Set<string>();
    for (const t of hit) set.add(t);
    helperTables.set(b.name, set);
  }
  // Fixpoint over camelCase calls (a bare `get(`/`run(` would match any method).
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of bodies)
      for (const [fn, ts] of [...helperTables])
        if (fn !== b.name && /[A-Z]/.test(fn) && new RegExp(`\\b${fn}\\(`).test(b.text)) {
          const set = helperTables.get(b.name) ?? new Set<string>();
          for (const t of ts)
            if (!set.has(t)) {
              set.add(t);
              changed = true;
            }
          helperTables.set(b.name, set);
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

/** Tool files that hold state across calls in a Map/WeakMap declared at module or factory scope
 *  (indent <= 2: a handler-local map lives one call) and read `ctx.caller`: the tools they define
 *  are candidates for caller-keyed in-memory state. */
function inMemoryCallerStateTools(toolNames: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of tsFiles(join(SRC, "tools"))) {
    const text = readFileSync(f, "utf8");
    if (!text.includes("defineTool(") || !/\bctx\.caller\b/.test(text)) continue;
    const maps = [
      ...text.matchAll(/^ {0,2}(?:const|let) (\w+)(?:: [^=\n]+)? = new (?:Weak)?Map\b/gm),
    ];
    if (maps.length === 0) continue;
    for (const m of text.matchAll(/defineTool\([\s\S]*?name:\s*"(\w+)"/g))
      if (toolNames.includes(m[1] as string))
        out.set(m[1] as string, `${maps.map((x) => x[1]).join("/")} (${f.slice(SRC.length)})`);
  }
  return out;
}

/** In-memory-state tools that are NOT keyed by the caller, each with the reason. */
const IN_MEMORY_NOT_CALLER_KEYED: Record<string, string> = {};

describe("principalOwned coverage", () => {
  const tables = ownedTables();
  const registry = buildFullRegistry().list();
  const names = registry.map((t) => t.name);
  const partitioned = tables.filter((t) => (PARTITIONED as readonly string[]).includes(t));
  const touched = toolsTouching(partitioned, names);
  const declared = new Set(registry.filter((t) => t.principalOwned === true).map((t) => t.name));
  const inMemory = inMemoryCallerStateTools(names);

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
      .filter(
        (n) =>
          !declared.has(n) && !(n in NOT_OWNER_PARTITIONED) && !(n in DEGRADES_WITHOUT_IDENTITY),
      )
      .sort();
    expect(
      missing,
      `tool(s) touching ${partitioned.join("/")} without \`principalOwned: true\` (or an entry in DEGRADES_WITHOUT_IDENTITY / NOT_OWNER_PARTITIONED): ${missing.join(", ")}`,
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

  it("the scan finds the in-memory per-caller state of search_and_read (not vacuous)", () => {
    expect([...inMemory.keys()]).toContain("search_and_read");
  });

  it("every tool keeping in-memory state beside ctx.caller is classified", () => {
    const missing = [...inMemory.keys()]
      .filter(
        (n) =>
          !declared.has(n) &&
          !(n in DEGRADES_WITHOUT_IDENTITY) &&
          !(n in IN_MEMORY_NOT_CALLER_KEYED),
      )
      .sort();
    expect(
      missing,
      `tool(s) holding a module/factory-scope Map in a file that reads ctx.caller, so a caller with no identity may share its entry (${missing.map((n) => inMemory.get(n)).join("; ")}): declare principalOwned, add to DEGRADES_WITHOUT_IDENTITY with a proof, or to IN_MEMORY_NOT_CALLER_KEYED with a reason`,
    ).toEqual([]);
  });

  it("each degradesWithoutIdentity tool is real, undeclared, and proven by a test that exists", () => {
    for (const [name, entry] of Object.entries(DEGRADES_WITHOUT_IDENTITY)) {
      expect(names, `${name} is not a registered tool`).toContain(name);
      expect(declared.has(name), `${name} is both principalOwned and degradesWithoutIdentity`).toBe(
        false,
      );
      expect(name in NOT_OWNER_PARTITIONED, `${name} is also exempt`).toBe(false);
      expect(
        touched.has(name) || inMemory.has(name),
        `${name} no longer reaches caller-owned state; drop the entry`,
      ).toBe(true);
      expect(entry.proofs.length, `${name} needs a proof`).toBeGreaterThan(0);
      for (const { file, title } of entry.proofs) {
        const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
        expect(readFileSync(path, "utf8"), `${file} has no test titled "${title}"`).toContain(
          `"${title}"`,
        );
      }
    }
  });

  it("no flag is stale: each principalOwned tool still reaches an owner-partitioned table", () => {
    const stale = [...declared].filter((n) => !touched.has(n)).sort();
    expect(stale, `principalOwned tool(s) that reach no owned table: ${stale.join(", ")}`).toEqual(
      [],
    );
  });
});
