// THE-233 integration: verify the MERGED migration chain applies clean on a fresh db AND on a
// db that already has the pre-merge migrations (simulating an existing dev cache.db). Guards
// the cli.ts migration array assembled across W-SCHEMA + W-WORKERS.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
}

// The cache.db chain, in monotonic version order, exactly as cli.ts assembles it.
const cacheChain = [
  { version: "20260519_001", sql: read("20260519_001_initial.sql") },
  { version: "20260519_002", sql: read("20260519_002_entity_unique.sql") },
  { version: "20260626_001", sql: read("20260626_001_vault_edges.sql") },
  { version: "20260626_002", sql: read("20260626_002_plane.sql") },
  { version: "20260703_001", sql: read("20260703_001_vault_edges_vault_id.sql") },
];
const experientialChain = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
];

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

describe("merged migration chain (integration)", () => {
  it("cache.db: full chain applies on a fresh db, all tables present, idempotent", () => {
    const db = openMemoryDb();
    expect(runMigrations(db, cacheChain)).toEqual([
      "20260519_001",
      "20260519_002",
      "20260626_001",
      "20260626_002",
      "20260703_001",
    ]);
    for (const t of [
      "chunks",
      "chunk_embeddings",
      "memory_entities",
      "vault_edges",
      "contradictions",
      "syntheses",
      "audit_reports",
      "job_runs",
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
    expect(runMigrations(db, cacheChain)).toEqual([]); // idempotent re-run
  });

  it("cache.db: on an existing db (pre-merge migrations applied), only the new ones apply", () => {
    const db = openMemoryDb();
    runMigrations(db, cacheChain.slice(0, 2)); // simulate the current dev cache.db (001 + 002)
    expect(runMigrations(db, cacheChain)).toEqual(["20260626_001", "20260626_002", "20260703_001"]);
    expect(tableExists(db, "vault_edges")).toBe(true);
    expect(tableExists(db, "contradictions")).toBe(true);
  });

  it("experiential.db: the separate-store chain applies (the membrane)", () => {
    const db = openMemoryDb();
    expect(runMigrations(db, experientialChain)).toEqual([
      "20260626_001",
      "20260711_001",
      "20260711_002",
    ]);
    expect(tableExists(db, "vault_object_state")).toBe(true);
    expect(tableExists(db, "chunk_retrievals")).toBe(true);
    expect(tableExists(db, "agent_episodes")).toBe(true);
    // THE-230 outcome axis present and writable AT THIS POINT IN THE CHAIN. 20260806_001 later
    // retires it (THE-718) — this prefix stops long before that, and asserting the historical
    // state here is correct. The end state is asserted by the full-chain test below.
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, outcome) VALUES ('x', 'c', 1, 1)",
    ).run();
    const row = db.prepare("SELECT outcome FROM chunk_retrievals WHERE id = 'x'").get() as {
      outcome: number;
    };
    expect(row.outcome).toBe(1);
    expect(runMigrations(db, experientialChain)).toEqual([]); // idempotent re-run
  });

  // Regression guard for the PR #207 install-smoke failure: a migration file that exists on
  // disk but is never wired into cli.ts's runtime chain boots a server whose prepared
  // statements target tables that were never created. Tests can't catch that via their own
  // hand-built chains, so assert the SOURCE wiring: every src/migrations/*.sql filename must
  // be referenced by cli.ts.
  it("every migration file on disk is referenced by a chain (cli.ts or db/provision.ts)", () => {
    const migrationsDir = fileURLToPath(new URL("../src/migrations/", import.meta.url));
    // Audit #9: both chains are now built from db/migration-manifest.ts (the single source of
    // truth), so the filename literals live there, not in cli.ts/provision.ts themselves. The
    // invariant is unchanged: a migration referenced by none of these silently never runs.
    const chainSources = [
      "../src/cli.ts",
      "../src/db/provision.ts",
      "../src/db/migration-manifest.ts",
    ]
      .map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"))
      .join("\n");
    const missing = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !chainSources.includes(f));
    expect(missing).toEqual([]);
  });

  // THE-718. The prefix test above stops at 20260711_002 and correctly still sees `outcome`, so it
  // structurally cannot observe a retirement that happens 12 migrations later. This runs the WHOLE
  // registered chain and asserts the end state — the shape a fresh install actually gets.
  it("experiential.db: the FULL chain retires the outcome axis and renames the episode one", () => {
    const db = openMemoryDb();
    const full = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));
    runMigrations(db, full);
    const cols = (name: string) =>
      (db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as { name: string }[]).map(
        (c) => c.name,
      );

    const retrievals = cols("chunk_retrievals");
    expect(retrievals).not.toContain("outcome");
    // The surviving axis, asserted so a passing "not present" above cannot be a misspelled table
    // name or an empty result set reading as success.
    expect(retrievals).toContain("feedback");
    expect(retrievals).toContain("cited_in_response");

    const view = cols("chunk_access_stats");
    expect(view).toEqual(
      expect.arrayContaining([
        "chunk_id",
        "access_count",
        "last_accessed_at",
        "citations",
        "observed",
      ]),
    );
    expect(view).not.toContain("outcome_balance");

    const quality = cols("note_quality");
    expect(quality).toContain("observed_retrievals");
    expect(quality).not.toContain("outcome_balance");

    // Renamed, NOT dropped — a rename that silently became a drop would still satisfy a
    // "does not contain outcome" assertion on its own.
    const episodes = cols("agent_episodes");
    expect(episodes).toContain("task_result");
    expect(episodes).not.toContain("outcome");

    expect(runMigrations(db, full)).toEqual([]); // idempotent re-run
  });
});
