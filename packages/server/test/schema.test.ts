import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { openMemoryDb } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));

describe("committed V1 schema (packages/server/src/schema.sql)", () => {
  it("applies cleanly and creates all V1 tables", () => {
    const raw = readFileSync(resolve(here, "../src/schema.sql"), "utf8");
    // The migration runner owns schema_migrations; strip its DDL from the documentation schema.
    const sql = raw.replace(/CREATE TABLE schema_migrations[\s\S]*?\);/, "");
    const d = openMemoryDb();
    runMigrations(d, [{ version: "20260519_001_initial", sql }]);
    const tables = d
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of [
      "chunks",
      "chunk_embeddings",
      "workspace_sessions",
      "capture_queue",
      "memory_entities",
      "memory_relations",
      "idempotency_keys",
      "elicit_tokens",
      "event_log",
    ]) {
      expect(tables).toContain(t);
    }
  });
});
