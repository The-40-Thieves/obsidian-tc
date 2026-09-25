// THE-1124 — memory-import/plan.ts: sanitized-name collision detection (review finding — must
// show up in the DRY-RUN preview, not only surface once apply.ts hits an "already exists" from
// create_entity) and the exact-case, root-only claude-code-memory index match.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// CI finding (macOS/Windows build-test): a fixture that writes BOTH "MEMORY.md" and "memory.md"
// at the SAME directory aliases to one file on a case-insensitive filesystem — there is no
// "wrong-case root file that is a real fact file" to assert on those platforms, because the OS
// never let two such files coexist in the first place. Probe capability the same idiom
// vault-watcher.test.ts's own symlinkOk does (a module-level probe, its own scratch dir), and
// skip the platform-specific test with a stated reason (it.skipIf, so it reports as SKIPPED, not
// a silent pass) rather than have it fail for a reason that has nothing to do with plan.ts.
let caseSensitiveFs = true;
{
  const probeDir = mkdtempSync(join(tmpdir(), "obtc-mi-case-probe-"));
  try {
    writeFileSync(join(probeDir, "a.tmp"), "x");
    caseSensitiveFs = !existsSync(join(probeDir, "A.tmp"));
  } finally {
    rmTemp(probeDir);
  }
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
  it("skips root MEMORY.md, exact case — platform-invariant (true on case-sensitive AND case-insensitive filesystems)", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-mi-plan-index-"));
    try {
      write(root, "MEMORY.md", "# Memory Index\n- [a](a.md)\n");
      // Lowercase, but NOT at the root — a different path either way, on any filesystem, so this
      // is a real fact file regardless of case-sensitivity (the platform-specific case is the
      // SEPARATE test below).
      write(
        root,
        "sub/memory.md",
        "---\nname: nested-memory-md\nmetadata:\n  type: note\n---\nbody\n",
      );
      const parsed = buildParsedSource(root, "claude-code-memory");
      expect(parsed.entities.map((e) => e.name)).toStrictEqual(["nested-memory-md"]);
      expect(parsed.skipped).toStrictEqual([
        { sourcePath: "MEMORY.md", reason: "index file (not imported)" },
      ]);
    } finally {
      rmTemp(root);
    }
  });

  // Skipped on a case-insensitive filesystem (macOS/Windows default): "MEMORY.md" and "memory.md"
  // at the root are the SAME directory entry there — see plan.ts's rootIndexEntryName — so there
  // is no "wrong-case root file that survives as a real fact file" to assert.
  it.skipIf(!caseSensitiveFs)(
    "a root memory.md in the WRONG case is a real fact file — case-sensitive filesystems only",
    () => {
      const root = mkdtempSync(join(tmpdir(), "obtc-mi-plan-index-case-"));
      try {
        write(root, "MEMORY.md", "# Memory Index\n- [a](a.md)\n");
        write(root, "memory.md", "---\nname: not-the-index\nmetadata:\n  type: note\n---\nbody\n");
        const parsed = buildParsedSource(root, "claude-code-memory");
        expect(parsed.entities.map((e) => e.name)).toStrictEqual(["not-the-index"]);
        expect(parsed.skipped).toStrictEqual([
          { sourcePath: "MEMORY.md", reason: "index file (not imported)" },
        ]);
      } finally {
        rmTemp(root);
      }
    },
  );
});
