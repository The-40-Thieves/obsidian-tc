// THE-1124 — memory-import/plan.ts: sanitized-name collision detection (review finding — must
// show up in the DRY-RUN preview, not only surface once apply.ts hits an "already exists" from
// create_entity) and the exact-case, root-only claude-code-memory index match.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildParsedSource } from "../src/memory-import/plan";
import { rmTemp } from "./tmp";

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("buildParsedSource — sanitized-name collisions", () => {
  it("an outright duplicate (type, name) across two files is a collision in the PLAN, not just at apply", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-plan-dup-"));
    try {
      write(root, "a.md", "---\ntitle: Ideas\ntype: note\n---\n## Observations\n- [a] one\n");
      write(root, "sub/b.md", "---\ntitle: Ideas\ntype: note\n---\n## Observations\n- [b] two\n");
      const parsed = buildParsedSource(root, "basic-memory");
      expect(parsed.entities.map((e) => e.sourcePath)).toStrictEqual(["a.md"]);
      const skip = parsed.skipped.find((s) => s.sourcePath === "sub/b.md");
      expect(skip?.reason).toContain("collides with a.md");
      expect(skip?.reason).toContain("first by source_path");
    } finally {
      rmTemp(root);
    }
  });

  it("two DIFFERENT (type, name) pairs that sanitize to the same note path are also a collision", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-plan-sanitize-"));
    try {
      // entityNotePath's sanitizeSegment replaces ":" with "-", so type "A:B" and type "A-B"
      // both resolve to the segment "A-B" — a collision entityNotePath itself creates.
      write(root, "a.md", '---\ntitle: X\ntype: "A:B"\n---\n');
      write(root, "b.md", "---\ntitle: X\ntype: A-B\n---\n");
      const parsed = buildParsedSource(root, "basic-memory");
      expect(parsed.entities).toHaveLength(1);
      expect(parsed.entities[0]?.sourcePath).toBe("a.md");
      const skip = parsed.skipped.find((s) => s.sourcePath === "b.md");
      expect(skip?.reason).toContain("collides with a.md");
    } finally {
      rmTemp(root);
    }
  });

  it("no collision when (type, name) genuinely differ", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-plan-nocollide-"));
    try {
      write(root, "a.md", "---\ntitle: One\ntype: note\n---\n");
      write(root, "b.md", "---\ntitle: Two\ntype: note\n---\n");
      const parsed = buildParsedSource(root, "basic-memory");
      expect(parsed.entities.map((e) => e.sourcePath).sort()).toStrictEqual(["a.md", "b.md"]);
      expect(parsed.skipped).toStrictEqual([]);
    } finally {
      rmTemp(root);
    }
  });
});

describe("buildParsedSource — claude-code-memory index match", () => {
  it("skips MEMORY.md only at the import root, exact case", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-plan-index-"));
    try {
      write(root, "MEMORY.md", "# Memory Index\n- [a](a.md)\n");
      // NOT the index: wrong case, and/or not at the root.
      write(root, "memory.md", "---\nname: not-the-index\nmetadata:\n  type: note\n---\nbody\n");
      write(
        root,
        "sub/MEMORY.md",
        "---\nname: nested-memory-md\nmetadata:\n  type: note\n---\nbody\n",
      );
      const parsed = buildParsedSource(root, "claude-code-memory");
      expect(parsed.entities.map((e) => e.name).sort()).toStrictEqual([
        "nested-memory-md",
        "not-the-index",
      ]);
      expect(parsed.skipped).toStrictEqual([
        { sourcePath: "MEMORY.md", reason: "index file (not imported)" },
      ]);
    } finally {
      rmTemp(root);
    }
  });
});
