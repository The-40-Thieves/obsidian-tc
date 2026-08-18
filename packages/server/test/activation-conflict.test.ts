// THE-643 item 3 — the read-only reconciliation between note_quality's stale_access flag and
// activation's aggregate chunk score. Pure-function coverage of the conflict rule itself
// (activationConflict) plus the batched path -> max-chunk-activation lookup (maxActivationByPath).
// See test/experiential-tools-branch-coverage.test.ts for the end-to-end note_quality_report
// wiring — this file is the rule in isolation, no DB or tool dispatch required for the rule tests.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  ACTIVATION_NEUTRAL_FLOOR,
  activationConflict,
  maxActivationByPath,
} from "../src/tools/m8/activation-conflict";
import { openMemoryDb } from "./helpers";

describe("THE-643 activationConflict", () => {
  it("null aggregate (no activation data at all) is NEVER a conflict, either direction", () => {
    expect(activationConflict(null, true)).toBe(false);
    expect(activationConflict(null, false)).toBe(false);
  });

  it("stale_access + activation strictly ABOVE the neutral floor = conflict", () => {
    expect(activationConflict(ACTIVATION_NEUTRAL_FLOOR + 0.01, true)).toBe(true);
    expect(activationConflict(0.9, true)).toBe(true);
  });

  it("stale_access + activation AT the floor is not a conflict — the floor itself is neutral, not evidence of liveness", () => {
    expect(activationConflict(ACTIVATION_NEUTRAL_FLOOR, true)).toBe(false);
    expect(activationConflict(0.1, true)).toBe(false);
  });

  it("no stale_access + activation AT OR UNDER the floor = conflict (the inverse direction)", () => {
    expect(activationConflict(ACTIVATION_NEUTRAL_FLOOR, false)).toBe(true);
    expect(activationConflict(0.1, false)).toBe(true);
  });

  it("no stale_access + activation strictly above the floor is not a conflict — both signals agree the note is live", () => {
    expect(activationConflict(0.9, false)).toBe(false);
  });
});

function chunk(db: Database, id: string, vaultId: string, path: string) {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'x', ?, 1, 0, 0)",
  ).run(id, vaultId, path, `h-${id}`);
}

describe("THE-643 maxActivationByPath", () => {
  it("takes the MAX across a note's chunks, not the first or last", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    chunk(db, "c1", "v", "note.md");
    chunk(db, "c2", "v", "note.md");
    const scores = new Map([
      ["c1", 0.2],
      ["c2", 0.8],
    ]);
    const result = maxActivationByPath(db, "v", ["note.md"], (id) => scores.get(id) ?? null);
    expect(result.get("note.md")).toBe(0.8);
  });

  it("is null for a path with no chunks", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const result = maxActivationByPath(db, "v", ["nothing.md"], () => 0.5);
    expect(result.get("nothing.md")).toBeNull();
  });

  it("is null when chunks exist but none carry an activation score", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    chunk(db, "c1", "v", "note.md");
    const result = maxActivationByPath(db, "v", ["note.md"], () => null);
    expect(result.get("note.md")).toBeNull();
  });

  it("scopes chunks to the given vault — a same-path chunk in another vault doesn't leak in", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    chunk(db, "c1", "other-vault", "note.md");
    const result = maxActivationByPath(db, "v", ["note.md"], () => 0.9);
    expect(result.get("note.md")).toBeNull();
  });
});
