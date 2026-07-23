// THE-450: stamp each retrieval hit with note-content freshness { age_days, stale } from the note
// mtime, so an agent can reason "this note is 2y old, verify before relying". Additive and
// INFORMATIONAL — it does not change ranking. Distinct from the experiential retrieval-log decay
// (that is usage recency; this is vault-note CONTENT age).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { mtimesByPath, noteFreshness, STALE_THRESHOLD_DAYS } from "../src/search/freshness";
import { openMemoryDb } from "./helpers";

const DAY_MS = 86_400_000;

describe("THE-450 noteFreshness", () => {
  const now = 1_000 * DAY_MS;

  it("computes whole-day age from the mtime", () => {
    expect(noteFreshness(now - 10 * DAY_MS, now).age_days).toBe(10);
    expect(noteFreshness(now, now).age_days).toBe(0);
  });

  it("flags stale past the threshold, not before", () => {
    expect(noteFreshness(now - (STALE_THRESHOLD_DAYS - 1) * DAY_MS, now).stale).toBe(false);
    expect(noteFreshness(now - (STALE_THRESHOLD_DAYS + 1) * DAY_MS, now).stale).toBe(true);
  });

  it("honours a custom threshold", () => {
    expect(noteFreshness(now - 40 * DAY_MS, now, 30).stale).toBe(true);
    expect(noteFreshness(now - 20 * DAY_MS, now, 30).stale).toBe(false);
  });

  it("never reports a negative age (a future mtime clamps to 0)", () => {
    expect(noteFreshness(now + 5 * DAY_MS, now).age_days).toBe(0);
  });
});

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const NOTES_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260702_001_notes.sql", import.meta.url)),
  "utf8",
);

function dbWithNotes(): Database {
  const d = openMemoryDb();
  runMigrations(d, [
    { version: "20260519_001", sql: INIT_SQL },
    { version: "20260702_001", sql: NOTES_SQL },
  ]);
  return d;
}

describe("THE-450 mtimesByPath", () => {
  it("returns mtimes for the requested paths, scoped to the vault", () => {
    const d = dbWithNotes();
    const ins = d.prepare(
      "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?, ?, '', '[]', '{}', 'h', ?, 1, 0)",
    );
    ins.run("v1", "a.md", 111);
    ins.run("v1", "b.md", 222);
    ins.run("v2", "a.md", 999); // other vault — must not leak

    const m = mtimesByPath(d, "v1", ["a.md", "b.md", "missing.md"]);
    expect(m.get("a.md")).toBe(111);
    expect(m.get("b.md")).toBe(222);
    expect(m.has("missing.md")).toBe(false);
  });

  it("returns an empty map for no paths without querying", () => {
    const d = dbWithNotes();
    expect(mtimesByPath(d, "v1", []).size).toBe(0);
  });
});
