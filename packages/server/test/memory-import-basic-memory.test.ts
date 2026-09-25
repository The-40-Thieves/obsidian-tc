// THE-1124 — end-to-end basic-memory import against test/fixtures/memory-import/basic-memory/
// (a small sanitized fixture set: two real notes that cross-reference each other, one with a
// relation to a target that does not exist in the batch, one with malformed frontmatter, one with
// no frontmatter at all). Covers dry-run (nothing written), --apply (real vault writes through
// create_entity/add_observation/link_entities/update_frontmatter), and idempotent re-apply (no
// duplication, keyed on source_path).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyImport } from "../src/memory-import/apply";
import { buildParsedSource } from "../src/memory-import/plan";
import { makeMemoryImportHarness } from "./memory-import-helpers";

const FIXTURE_ROOT = fileURLToPath(new URL("fixtures/memory-import/basic-memory", import.meta.url));

describe("memory import — basic-memory adapter", () => {
  it("parses the fixture set: 3 entities, 1 malformed skip", () => {
    const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
    expect(parsed.entities.map((e) => e.name).sort()).toStrictEqual([
      "Coffee Brewing Methods",
      "Tea Brewing Methods",
      "plain-no-frontmatter",
    ]);
    expect(parsed.skipped).toStrictEqual([
      {
        sourcePath: "notes/malformed.md",
        reason: expect.stringContaining("malformed frontmatter"),
      },
    ]);
    const coffee = parsed.entities.find((e) => e.name === "Coffee Brewing Methods");
    expect(coffee?.entityType).toBe("note");
    // THE-1130: a `[category] text` bullet whose category passes add_observation's key regex is
    // split into { key, text } — both do here ("method", "technique").
    expect(coffee?.observations).toStrictEqual([
      { key: "method", text: "Pour over provides more flavor clarity than French press" },
      { key: "technique", text: "Water temperature at 205F extracts optimal compounds #brewing" },
    ]);
    expect(coffee?.relations).toStrictEqual([
      { relationType: "relates_to", targetName: "Tea Brewing Methods" },
      { relationType: "requires", targetName: "Proper Grinding Technique" },
    ]);
  });

  it("falls back to the filename when a note has no frontmatter title", () => {
    const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
    const plain = parsed.entities.find((e) => e.sourcePath === "notes/plain-no-frontmatter.md");
    expect(plain?.name).toBe("plain-no-frontmatter");
    expect(plain?.entityType).toBe("note");
  });

  it("dry-run writes nothing", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: false,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(report.applied).toBe(false);
      expect(report.entities.every((e) => e.action === "create")).toBe(true);
      expect(h.exists("memory")).toBe(false);
      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.observationsToAdd).toBe(2);
      // dry-run still resolves relation targets against the (empty) vault read-only, so the
      // preview reports the same outcome --apply would.
      expect(coffee?.relations.map((r) => r.status)).toStrictEqual(["planned", "skipped"]);
    } finally {
      h.cleanup();
    }
  });

  it("--apply creates entities, observations, relations, and provenance frontmatter", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(report.applied).toBe(true);
      const created = report.entities.filter((e) => e.action === "create");
      expect(created).toHaveLength(3);

      const note = h.read("memory/note/Coffee Brewing Methods.md");
      expect(note).toContain("entity_type: note");
      expect(note).toContain("imported_from: basic-memory");
      expect(note).toContain("source_path: notes/coffee-brewing.md");
      expect(note).toContain("imported_at: 2026-01-01T00:00:00.000Z");
      expect(note).toContain("- [method] Pour over provides more flavor clarity than French press");
      expect(note).toContain("- relates_to [[Tea Brewing Methods]]");

      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      const requires = coffee?.relations.find((r) => r.relationType === "requires");
      expect(requires?.status).toBe("skipped");
      expect(requires?.reason).toContain("relation target not found");

      const tea = report.entities.find((e) => e.name === "Tea Brewing Methods");
      expect(tea?.relations).toStrictEqual([
        { relationType: "contrasts_with", targetName: "Coffee Brewing Methods", status: "created" },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("re-applying the same directory is idempotent (keyed on source_path)", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const first = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(first.entities.every((e) => e.action === "create")).toBe(true);

      const second = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-02T00:00:00.000Z",
      });
      expect(second.entities.every((e) => e.action === "exists")).toBe(true);
      expect(second.entities.every((e) => e.observationsToAdd === 0)).toBe(true);
      const coffee = second.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.observationsAlready).toBe(2);
      expect(coffee?.relations.find((r) => r.relationType === "relates_to")?.status).toBe(
        "already-exists",
      );

      const note = h.read("memory/note/Coffee Brewing Methods.md");
      // Not duplicated: the bullet appears exactly once.
      expect(
        note.split("- [method] Pour over provides more flavor clarity than French press"),
      ).toHaveLength(2);
      // imported_at was NOT re-stamped on re-run (the entity was resolved as "exists", not
      // re-created) — still the FIRST run's timestamp.
      expect(note).toContain("imported_at: 2026-01-01T00:00:00.000Z");
    } finally {
      h.cleanup();
    }
  });

  it("refuses to touch an entity that already exists with NO verifiable provenance (collision)", async () => {
    const h = makeMemoryImportHarness();
    try {
      // Plant an entity at the same (type, name) the fixture would import, but with no
      // matching provenance — as if hand-authored or imported from somewhere else.
      const created = await h.dispatch("create_entity", {
        vault: "test",
        type: "note",
        name: "Coffee Brewing Methods",
        materialize: true,
      });
      expect(created.ok).toBe(true);

      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.action).toBe("collision");
      expect(coffee?.reason).toContain("no verifiable import provenance");
    } finally {
      h.cleanup();
    }
  });

  it("refuses to touch an entity that already exists with a DIFFERENT source_path (real mismatch, not just unverifiable)", async () => {
    const h = makeMemoryImportHarness();
    try {
      // Plant an entity at the same (type, name), THIS time with real (but different)
      // provenance — as if a PRIOR, unrelated import already claimed this (type, name).
      const created = await h.dispatch("create_entity", {
        vault: "test",
        type: "note",
        name: "Coffee Brewing Methods",
        materialize: true,
      });
      expect(created.ok).toBe(true);
      const createdData = created.ok ? (created.data as { vault_path: string }) : null;
      const fm = await h.dispatch("update_frontmatter", {
        vault: "test",
        path: createdData?.vault_path,
        operation: "merge",
        properties: {
          imported_from: "basic-memory",
          source_path: "some/other/note.md",
          imported_at: "2025-01-01T00:00:00.000Z",
        },
      });
      expect(fm.ok).toBe(true);

      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.action).toBe("collision");
      expect(coffee?.reason).toContain("different source_path");
      expect(coffee?.reason).not.toContain("no verifiable");
    } finally {
      h.cleanup();
    }
  });

  it("--resume continues an entity with a row but no observations and no provenance (interrupted first run)", async () => {
    const h = makeMemoryImportHarness();
    try {
      // Simulate a run that got as far as create_entity but crashed before its
      // update_frontmatter — a real row, ZERO observations, no source_path.
      const created = await h.dispatch("create_entity", {
        vault: "test",
        type: "note",
        name: "Coffee Brewing Methods",
        materialize: true,
      });
      expect(created.ok).toBe(true);

      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const withoutResume = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(withoutResume.entities.find((e) => e.name === "Coffee Brewing Methods")?.action).toBe(
        "collision",
      );

      const withResume = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        resume: true,
        now: () => "2026-01-02T00:00:00.000Z",
      });
      const coffee = withResume.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.action).toBe("resumed");
      expect(coffee?.observationsToAdd).toBe(2);
      const note = h.read("memory/note/Coffee Brewing Methods.md");
      expect(note).toContain("source_path: notes/coffee-brewing.md");
      expect(note).toContain("- [method] Pour over provides more flavor clarity than French press");
    } finally {
      h.cleanup();
    }
  });

  it("--resume does NOT relax refusal once the entity has real observations", async () => {
    const h = makeMemoryImportHarness();
    try {
      const created = await h.dispatch("create_entity", {
        vault: "test",
        type: "note",
        name: "Coffee Brewing Methods",
        materialize: true,
        observations: ["someone else's note, not from this import"],
      });
      expect(created.ok).toBe(true);

      const parsed = buildParsedSource(FIXTURE_ROOT, "basic-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        resume: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect(coffee?.action).toBe("collision");
    } finally {
      h.cleanup();
    }
  });
});
