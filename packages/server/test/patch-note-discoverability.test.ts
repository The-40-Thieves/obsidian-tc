// Write-ergonomics eval findings (move-heading-block, duplicate-heading, the note_exists refusal
// and the "either anchor or target_heading" refusal): the fixtures are the eval's own Plan.md
// verbatim, and every error string a client actually hit is asserted here, so a model reading
// these refusals finds the accepted shape instead of guessing a parameter name.
import { describe, expect, it } from "vitest";
import { SEED } from "../eval/write-ergonomics/fixtures";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { describeCapability } from "../src/mcp/facade";
import { PatchInput, PatchInputShape } from "../src/tools/m1/notes/schemas";
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
        expect(m).toContain('operation "append" requires anchor or target_heading');
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

// Cross-field rules. A portable JSON Schema cannot say "operation X requires field Y" (no if/then,
// oneOf or allOf), so the rules are written into the descriptions, which clients read, and every
// refusal names the operation. OPERATION_RULES is the whole per-operation rule set.
const OPERATION_RULES =
  "Required fields per operation (anchor or target_heading on append, prepend and replace only): append, prepend, replace: content; replace_text: old_string + new_string. Refused: old_string/new_string on append, prepend, replace; content on replace_text.";

describe("published rules: the advertised descriptions", () => {
  for (const name of ["patch_note", "patch_active_file"]) {
    it(`${name}'s description states each operation's required and forbidden fields`, () => {
      const def = buildFullRegistry()
        .list()
        .find((d) => d.name === name);
      if (!def) throw new Error(`${name} is not registered`);
      expect(describeCapability(def).description).toContain(OPERATION_RULES);
    });
  }
});

describe("field description: names the operations that require or forbid the field", () => {
  const text = (k: keyof typeof PatchInputShape) => PatchInputShape[k].description ?? "";

  it("content, old_string and new_string", () => {
    expect(text("content")).toContain("Required for append, prepend and replace");
    expect(text("content")).toContain("refused for replace_text");
    for (const k of ["old_string", "new_string"] as const) {
      expect(text(k)).toContain("Required for replace_text");
      expect(text(k)).toContain("refused for append, prepend and replace");
    }
  });

  it("insert_before is documented as append-only", () => {
    expect(text("insert_before")).toContain("Optional for append only");
    expect(text("insert_before")).toContain("unique line");
    expect(text("insert_before")).toContain("resolved section");
  });

  it("anchor and target_heading", () => {
    for (const k of ["anchor", "target_heading"] as const) {
      expect(text(k)).toContain("append, prepend and replace need anchor or target_heading");
      expect(text(k)).toContain("replace_text needs neither");
    }
  });
});

describe("refusals: each names the operation and the field it requires or forbids", () => {
  const H = { type: "heading", heading: "Notes" };
  // [label, input, field the issue points at (none for the anchor rule), message it must contain]
  const cases: [string, Record<string, unknown>, string | undefined, string][] = [
    [
      "append with no anchor",
      { operation: "append", content: "x" },
      undefined,
      'operation "append" requires anchor or target_heading',
    ],
    [
      "replace_text without old_string",
      { operation: "replace_text", anchor: H, new_string: "b" },
      "old_string",
      'operation "replace_text" requires old_string',
    ],
    [
      "replace_text without new_string",
      { operation: "replace_text", anchor: H, old_string: "a" },
      "new_string",
      'operation "replace_text" requires new_string',
    ],
    [
      "replace_text with content",
      { operation: "replace_text", anchor: H, old_string: "a", new_string: "b", content: "x" },
      "content",
      'operation "replace_text" forbids content',
    ],
    [
      "append without content",
      { operation: "append", anchor: H },
      "content",
      'operation "append" requires content',
    ],
    [
      "prepend without content",
      { operation: "prepend", anchor: H },
      "content",
      'operation "prepend" requires content',
    ],
    [
      "replace without content",
      { operation: "replace", anchor: H },
      "content",
      'operation "replace" requires content',
    ],
    [
      "append with old_string",
      { operation: "append", anchor: H, content: "x", old_string: "a" },
      "old_string",
      'operation "append" forbids old_string',
    ],
    [
      "replace with new_string",
      { operation: "replace", anchor: H, content: "x", new_string: "b" },
      "new_string",
      'operation "replace" forbids new_string',
    ],
  ];

  for (const [label, input, field, message] of cases) {
    it(label, () => {
      const r = PatchInput.safeParse({ vault: "test", path: "Notes/a.md", ...input });
      expect(r.success).toBe(false);
      const issues = r.success ? [] : r.error.issues;
      expect(issues).toContainEqual(
        expect.objectContaining({
          path: field === undefined ? [] : [field],
          message: expect.stringContaining(message),
        }),
      );
    });
  }

  it("the refusal a client receives over MCP names the operation", async () => {
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
        expect(issues.map((i) => i.message).join("\n")).toContain(
          'operation "append" requires anchor or target_heading',
        );
      }
    } finally {
      v.cleanup();
    }
  });
});
