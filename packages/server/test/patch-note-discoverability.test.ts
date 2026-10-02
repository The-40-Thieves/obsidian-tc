// Write-ergonomics eval findings (move-heading-block, duplicate-heading, the note_exists refusal
// and the "either anchor or target_heading" refusal): the fixtures are the eval's own Plan.md
// verbatim, and every error string a client actually hit is asserted here, so a model reading
// these refusals finds the accepted shape instead of guessing a parameter name.
import { describe, expect, it } from "vitest";
import { SEED } from "../eval/write-ergonomics/fixtures";
import { makeTestVault } from "./m1-helpers";

const PLAN = "Projects/Alpha/Plan.md";
const plan = SEED[PLAN] as string;

function errMessage(r: { ok: boolean; error?: { message: string } }): string {
  if (r.ok || !r.error) throw new Error("expected an error result");
  return r.error.message;
}

describe("duplicate-heading (eval task): add a line to the SECOND of two identical H2s", () => {
  it("anchor.occurrence picks the Nth match, in document order", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PLAN,
        operation: "append",
        anchor: { type: "heading", heading: "Notes", occurrence: 2 },
        content: "\nThird pass pending.",
      });
      expect(r.ok).toBe(true);
      const t = v.read(PLAN);
      expect(t.split("Third pass pending.")).toHaveLength(2);
      expect(t.indexOf("Third pass pending.")).toBeGreaterThan(t.indexOf("Second pass of notes"));
      expect(t.indexOf("First pass of notes")).toBeLessThan(t.indexOf("Second pass of notes"));
    } finally {
      v.cleanup();
    }
  });

  it("occurrence 1 targets the first match", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PLAN,
        operation: "replace_text",
        anchor: { type: "heading", heading: "Notes", occurrence: 1 },
        old_string: "First pass of notes.",
        new_string: "First pass, revised.",
      });
      expect(r.ok).toBe(true);
      expect(v.read(PLAN)).toContain("First pass, revised.");
    } finally {
      v.cleanup();
    }
  });

  it("no occurrence on a duplicated heading refuses, listing every match line and the fix", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PLAN,
        operation: "append",
        target_heading: "Notes",
        content: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // Line numbers are body-relative (frontmatter is stripped before the scan).
        const bodyOffset = plan.split("\n").indexOf("# Alpha Plan");
        const lines = plan
          .split("\n")
          .flatMap((l, i) => (l === "## Notes" ? [i + 1 - bodyOffset] : []));
        expect(lines).toHaveLength(2);
        expect(r.error.details).toMatchObject({ count: 2, lines });
        expect(r.error.message).toMatch(/ambiguous heading: matches 2 lines \(\d+, \d+\)/);
        expect(r.error.message).toContain("occurrence");
        expect(r.error.message).toContain("Parent > ");
      }
      expect(v.read(PLAN)).toBe(plan);
    } finally {
      v.cleanup();
    }
  });

  it("an occurrence past the last match refuses and lists the matches that exist", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PLAN,
        operation: "append",
        anchor: { type: "heading", heading: "Notes", occurrence: 3 },
        content: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toMatch(/occurrence 3 is out of range.*matches 2 lines/);
        expect(r.error.details).toMatchObject({ count: 2, occurrence: 3 });
      }
      expect(v.read(PLAN)).toBe(plan);
    } finally {
      v.cleanup();
    }
  });

  it("occurrence is rejected below 1 and for non-integers", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      for (const occurrence of [0, -1, 1.5]) {
        const r = await v.call("patch_note", {
          vault: "test",
          path: PLAN,
          operation: "append",
          anchor: { type: "heading", heading: "Notes", occurrence },
          content: "x",
        });
        expect(r.ok, `occurrence ${occurrence}`).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("read_note's section read takes the same occurrence anchor", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: PLAN,
        anchor: { type: "heading", heading: "Notes", occurrence: 2 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { section?: { text: string } };
        expect(d.section?.text).toContain("Second pass of notes");
        expect(d.section?.text).not.toContain("First pass of notes");
      }
    } finally {
      v.cleanup();
    }
  });
});

describe('heading path anchors: heading:"Parent > Child"', () => {
  const raw = [
    "# Alpha",
    "## Notes",
    "alpha notes",
    "# Beta",
    "## Notes",
    "beta notes",
    "### Deep",
    "deep text",
  ].join("\n");

  it("resolves a duplicated child by its parent", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "heading", heading: "Beta > Notes" },
        content: "more beta",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe(`${raw}\nmore beta`);
    } finally {
      v.cleanup();
    }
  });

  it("works through target_heading and for a grandparent that is not adjacent", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "Beta > Deep",
        content: "more deep",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe(`${raw}\nmore deep`);
    } finally {
      v.cleanup();
    }
  });

  it("a path that matches nothing is not-found, and a path still ambiguous says so", async () => {
    const v = makeTestVault({ files: { "a.md": `${raw}\n## Notes\nthird` } });
    try {
      const none = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "Gamma > Notes",
        content: "x",
      });
      expect(errMessage(none)).toBe("target heading not found");
      const still = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "Beta > Notes",
        content: "x",
      });
      expect(still.ok).toBe(false);
      if (!still.ok) expect(still.error.details).toMatchObject({ count: 2 });
      const picked = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "heading", heading: "Beta > Notes", occurrence: 2 },
        content: "x",
      });
      expect(picked.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a literal heading containing > still wins over a path reading", async () => {
    const lit = "## A > B\ntext\n## B\nother";
    const v = makeTestVault({ files: { "a.md": lit } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "A > B",
        content: "added",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("## A > B\ntext\nadded\n## B\nother");
    } finally {
      v.cleanup();
    }
  });

  it("replace on a path anchor still drops a repeated leaf heading line", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        anchor: { type: "heading", heading: "Beta > Notes" },
        content: "## Notes\nnew beta",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("# Alpha\n## Notes\nalpha notes\n# Beta\n## Notes\nnew beta");
      expect(v.read("a.md").match(/^## Notes$/gm)).toHaveLength(2);
    } finally {
      v.cleanup();
    }
  });
});

describe("move-heading-block (eval task): the documented replace_text recipe works in one call", () => {
  it("anchored on the top-level heading, one replace_text reorders sections", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const timeline = "## Timeline\n\n- Kickoff: 2026-10-05\n- Alpha: 2026-10-30\n\n";
      const risks = "## Risks\n\n- Upstream schema changes\n- Staffing gaps in November\n\n";
      expect(plan).toContain(timeline + risks);
      const r = await v.call("patch_note", {
        vault: "test",
        path: PLAN,
        operation: "replace_text",
        anchor: { type: "heading", heading: "Alpha Plan" },
        old_string: timeline + risks,
        new_string: risks + timeline,
      });
      expect(r.ok).toBe(true);
      const heads = [...v.read(PLAN).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(heads).toEqual(["Goals", "Risks", "Timeline", "Notes", "Notes"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("error text names the real parameters", () => {
  it("write_note mode:create on an existing note names mode, not an overwrite flag", async () => {
    const v = makeTestVault({ files: { "a.md": "x" } });
    try {
      const r = await v.call("write_note", { vault: "test", path: "a.md", content: "y" });
      const m = errMessage(r);
      expect(m).not.toContain("use overwrite or upsert");
      expect(m).toContain('mode: "overwrite"');
      expect(m).toContain('mode: "upsert"');
      expect(m).toContain("append_note");
    } finally {
      v.cleanup();
    }
  });

  it("write_note mode:overwrite on a missing note names mode too", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "nope.md",
        content: "y",
        mode: "overwrite",
      });
      const m = errMessage(r);
      expect(m).not.toContain("use create or upsert");
      expect(m).toContain('mode: "create"');
      expect(m).toContain('mode: "upsert"');
    } finally {
      v.cleanup();
    }
  });

  it("patch_note with neither anchor nor target_heading shows the accepted shapes and append_note", async () => {
    const v = makeTestVault({ files: { [PLAN]: plan } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PLAN,
        operation: "append",
        content: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("validation_error");
        const issues = (r.error.details as { issues: { message: string }[] }).issues;
        const m = issues.map((i) => i.message).join("\n");
        expect(m).toContain("either anchor or target_heading is required");
        expect(m).toContain('anchor:{type:"heading",heading:"Notes"}');
        expect(m).toContain("block_id");
        expect(m).toContain('type:"frontmatter"');
        expect(m).toContain("append_note");
      }
    } finally {
      v.cleanup();
    }
  });
});
