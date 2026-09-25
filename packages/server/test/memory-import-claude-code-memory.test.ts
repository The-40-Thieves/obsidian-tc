// THE-1124 — end-to-end claude-code-memory import against
// test/fixtures/memory-import/claude-code-memory/ (a small sanitized fixture set mirroring the
// real ~/.claude/projects/-home-ubuntu/memory/ layout: an index file MEMORY.md that must be
// skipped, two real per-fact files that cross-reference each other by `name`, and one with
// malformed frontmatter).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyImport } from "../src/memory-import/apply";
import { buildParsedSource } from "../src/memory-import/plan";
import { makeMemoryImportHarness } from "./memory-import-helpers";

const FIXTURE_ROOT = fileURLToPath(
  new URL("fixtures/memory-import/claude-code-memory", import.meta.url),
);

describe("memory import — claude-code-memory adapter", () => {
  it("skips the index file and parses the two fact files, skipping the malformed one", () => {
    const parsed = buildParsedSource(FIXTURE_ROOT, "claude-code-memory");
    expect(parsed.entities.map((e) => e.name).sort()).toStrictEqual([
      "feedback-example-fix-root-cause",
      "reference-example-reuse-before-write",
    ]);
    // plan.ts already returns `skipped` sorted by sourcePath.localeCompare — no re-sort needed
    // (and re-sorting the same way would be a no-op).
    expect(parsed.skipped).toStrictEqual([
      {
        sourcePath: "malformed_frontmatter.md",
        reason: expect.stringContaining("malformed frontmatter"),
      },
      {
        sourcePath: "MEMORY.md",
        reason: "index file (not imported)",
      },
    ]);
  });

  it("takes type from frontmatter.metadata.type and the body as one observation", () => {
    const parsed = buildParsedSource(FIXTURE_ROOT, "claude-code-memory");
    const reuse = parsed.entities.find((e) => e.name === "reference-example-reuse-before-write");
    expect(reuse?.entityType).toBe("reference");
    expect(reuse?.observations).toHaveLength(1);
    expect(reuse?.observations[0]).toContain("Invented fixture content");
    expect(reuse?.relations).toStrictEqual([
      { relationType: "relates_to", targetName: "feedback-example-fix-root-cause" },
    ]);

    const feedback = parsed.entities.find((e) => e.name === "feedback-example-fix-root-cause");
    expect(feedback?.entityType).toBe("feedback");
    expect(feedback?.relations).toStrictEqual([]);
  });

  it("--apply creates both entities with provenance frontmatter and the relation", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "claude-code-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "claude-code-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      expect(report.entities.every((e) => e.action === "create")).toBe(true);

      const note = h.read("memory/reference/reference-example-reuse-before-write.md");
      expect(note).toContain("imported_from: claude-code-memory");
      expect(note).toContain("source_path: reference_example_reuse_before_write.md");
      expect(note).toContain("- relates_to [[feedback-example-fix-root-cause]]");

      const reuse = report.entities.find((e) => e.name === "reference-example-reuse-before-write");
      expect(reuse?.relations).toStrictEqual([
        {
          relationType: "relates_to",
          targetName: "feedback-example-fix-root-cause",
          status: "created",
        },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("re-applying is idempotent: no duplicate observation, action becomes exists", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "claude-code-memory");
      await applyImport(parsed, {
        vault: "test",
        adapter: "claude-code-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-01T00:00:00.000Z",
      });
      const second = await applyImport(parsed, {
        vault: "test",
        adapter: "claude-code-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-01-02T00:00:00.000Z",
      });
      expect(second.entities.every((e) => e.action === "exists")).toBe(true);
      expect(second.entities.every((e) => e.observationsToAdd === 0)).toBe(true);
      const note = h.read("memory/feedback/feedback-example-fix-root-cause.md");
      expect(note.split("Invented fixture content")).toHaveLength(2); // appears exactly once
    } finally {
      h.cleanup();
    }
  });

  it("dry-run writes nothing and reports the same skip set", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = buildParsedSource(FIXTURE_ROOT, "claude-code-memory");
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "claude-code-memory",
        dispatch: h.dispatch,
        applied: false,
      });
      expect(h.exists("memory")).toBe(false);
      expect(report.skipped.map((s) => s.sourcePath).sort()).toStrictEqual([
        "MEMORY.md",
        "malformed_frontmatter.md",
      ]);
    } finally {
      h.cleanup();
    }
  });
});
