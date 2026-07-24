import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { GatewayRoles } from "../src/plane/gateway";
import { isoWeek, parseSynthesis, runSynthesis } from "../src/plane/jobs/synthesis";
import { openMemoryDb } from "./helpers";

const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function rolesReturning(text: string): GatewayRoles {
  const r = async () => ({ text, model: "mock" });
  return { extract: r, synthesize: async () => ({ text, model: "opus" }), judge: r };
}

function withChunksDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT }]);
  db.exec(
    "CREATE TABLE syntheses (vault_id TEXT NOT NULL, iso_year INTEGER NOT NULL, iso_week INTEGER NOT NULL, generated_at INTEGER NOT NULL, cluster_count INTEGER NOT NULL, pattern_count INTEGER NOT NULL, clusters TEXT NOT NULL, patterns TEXT NOT NULL, judge_model TEXT, PRIMARY KEY (vault_id, iso_year, iso_week));",
  );
  return db;
}

describe("synthesis job (kb-synthesis-worker collapse)", () => {
  it("isoWeek computes the ISO 8601 week (UTC)", () => {
    expect(isoWeek(new Date(Date.UTC(2026, 0, 1))).year).toBe(2026);
  });

  it("parseSynthesis requires patterns + clusters arrays", () => {
    expect(() => parseSynthesis("{}")).toThrow();
    expect(parseSynthesis('{"patterns":[],"clusters":[]}').patterns).toEqual([]);
  });

  it("pulls recent chunks, calls the synthesize role, and stores the record", async () => {
    const db = withChunksDb();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'recent note', 'h', 1, 0, 1)",
    ).run();
    const synth =
      '{"patterns":[{"title":"t","summary":"s","evidence_paths":["A.md"],"contradiction_ids":[]}],"clusters":[{"label":"l","summary":"s","chunk_paths":["A.md"]}]}';
    const res = await runSynthesis({
      db,
      roles: rolesReturning(synth),
      now: () => Date.UTC(2026, 5, 1),
    });
    expect(res.ok).toBe(true);
    const row = db
      .prepare("SELECT pattern_count, cluster_count, judge_model FROM syntheses WHERE vault_id = 'v1'")
      .get() as {
      pattern_count: number;
      cluster_count: number;
      judge_model: string;
    };
    expect(row.pattern_count).toBe(1);
    expect(row.cluster_count).toBe(1);
    expect(row.judge_model).toBe("opus");
  });

  it("skips cleanly when there are no chunks", async () => {
    const db = withChunksDb();
    const res = await runSynthesis({ db, roles: rolesReturning("{}"), now: () => 1 });
    expect(res.ok).toBe(true);
    expect(res.detail?.skipped).toBe("no chunks");
  });

  it("writes one synthesis per vault, each blending only its own vault's chunks", async () => {
    const db = withChunksDb();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'note one', 'h1', 1, 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('b', 'v2', 'B.md', '0', '[]', 'note two', 'h2', 1, 0, 1)",
    ).run();
    const synth =
      '{"patterns":[{"title":"t","summary":"s","evidence_paths":["A.md"],"contradiction_ids":[]}],"clusters":[{"label":"l","summary":"s","chunk_paths":["A.md"]}]}';
    const res = await runSynthesis({ db, roles: rolesReturning(synth), now: () => Date.UTC(2026, 5, 1) });
    expect(res.ok).toBe(true);
    const vaults = (db.prepare("SELECT vault_id FROM syntheses ORDER BY vault_id").all() as { vault_id: string }[]).map((r) => r.vault_id);
    expect(vaults).toEqual(["v1", "v2"]);
  });
});
