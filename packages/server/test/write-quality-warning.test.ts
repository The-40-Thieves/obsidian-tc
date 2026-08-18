// THE-643 item 1 — the write-time guardrail. write_note/append_note/patch_note return
// quality_warning: null when the note_quality rollup has never run for this (vault, path) — NOT a
// false all-clear — and {flags, computed_at} reflecting the current row otherwise, including the
// empty-flags clean case. Never recomputed on the write path (see note-quality.test.ts's own
// noteQualityWarningFor suite for that function's unit coverage); this file is the end-to-end
// wiring through the three write tools.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, CHAIN);
  return db;
}

function noteQualityRow(
  db: Database,
  over: Partial<{ vault_id: string; path: string; computed_at: number; flags: string }>,
) {
  db.prepare(
    "INSERT INTO note_quality (vault_id, path, computed_at, flags) VALUES (?, ?, ?, ?)",
  ).run(
    over.vault_id ?? "test",
    over.path ?? "a.md",
    over.computed_at ?? 1_700_000_000_000,
    over.flags ?? "[]",
  );
}

describe("THE-643 write-time quality_warning", () => {
  it("is null with no edb wired at all (unchanged default behavior)", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("write_note", { vault: "test", path: "a.md", content: "hi" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { quality_warning: unknown }).quality_warning).toBeNull();
    } finally {
      v.cleanup();
    }
  });

  it("is null when edb is open but the rollup has never scored this note — not a false all-clear", async () => {
    const edb = edb0();
    const v = makeTestVault({ edb });
    try {
      const r = await v.call("write_note", { vault: "test", path: "fresh.md", content: "hi" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { quality_warning: unknown }).quality_warning).toBeNull();
    } finally {
      v.cleanup();
    }
  });

  it("write_note surfaces a stale row's flags — the point read doesn't care THIS write just happened", async () => {
    // A note_quality row can predate the write that produced the CURRENT bytes (the offline pass
    // runs on its own cadence) — the point read reflects whatever the last pass wrote, not the
    // write that just ran. Simulated here as a row already present for a path being freshly
    // created (e.g. re-creating a note whose prior rollup row hasn't been recomputed since).
    const edb = edb0();
    noteQualityRow(edb, { vault_id: "test", path: "b.md", flags: JSON.stringify(["stale_edit"]) });
    const v = makeTestVault({ edb });
    try {
      const created = await v.call("write_note", { vault: "test", path: "b.md", content: "x" });
      expect(created.ok).toBe(true);
      if (created.ok)
        expect((created.data as { quality_warning: unknown }).quality_warning).toEqual({
          flags: ["stale_edit"],
          computed_at: 1_700_000_000_000,
        });
    } finally {
      v.cleanup();
    }
  });

  it("append_note: {flags: [], computed_at} for a clean already-scored note", async () => {
    const edb = edb0();
    noteQualityRow(edb, { vault_id: "test", path: "a.md", computed_at: 12345, flags: "[]" });
    const v = makeTestVault({ files: { "a.md": "line1" }, edb });
    try {
      const r = await v.call("append_note", { vault: "test", path: "a.md", content: "line2" });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { quality_warning: unknown }).quality_warning).toEqual({
          flags: [],
          computed_at: 12345,
        });
    } finally {
      v.cleanup();
    }
  });

  it("append_note: carries flags when the note has been scored and flagged", async () => {
    const edb = edb0();
    noteQualityRow(edb, {
      vault_id: "test",
      path: "a.md",
      computed_at: 999,
      flags: JSON.stringify(["orphan", "stale_access"]),
    });
    const v = makeTestVault({ files: { "a.md": "line1" }, edb });
    try {
      const r = await v.call("append_note", { vault: "test", path: "a.md", content: "line2" });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { quality_warning: unknown }).quality_warning).toEqual({
          flags: ["orphan", "stale_access"],
          computed_at: 999,
        });
    } finally {
      v.cleanup();
    }
  });

  it("patch_note surfaces quality_warning for the patched note", async () => {
    const edb = edb0();
    noteQualityRow(edb, {
      vault_id: "test",
      path: "a.md",
      computed_at: 42,
      flags: JSON.stringify(["contradicted"]),
    });
    const v = makeTestVault({ files: { "a.md": "# H\nbody\n" }, edb });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "heading", heading: "H" },
        content: "more",
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { quality_warning: unknown }).quality_warning).toEqual({
          flags: ["contradicted"],
          computed_at: 42,
        });
    } finally {
      v.cleanup();
    }
  });

  it("quality_warning is scoped to (vault, path) — a row under a different vault id doesn't leak", async () => {
    const edb = edb0();
    noteQualityRow(edb, {
      vault_id: "other-vault",
      path: "a.md",
      flags: JSON.stringify(["orphan"]),
    });
    const v = makeTestVault({ files: { "a.md": "line1" }, edb });
    try {
      const r = await v.call("append_note", { vault: "test", path: "a.md", content: "line2" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { quality_warning: unknown }).quality_warning).toBeNull();
    } finally {
      v.cleanup();
    }
  });
});
