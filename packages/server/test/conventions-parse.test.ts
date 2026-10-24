// SCHEMA.md `conventions:` block: parsing is forgiving. A malformed layer is a warning and no layer
// (or a partial one), never a throw, and a SCHEMA.md with no `conventions:` key is no layer at all.
import { describe, expect, it } from "vitest";
import { parseConventionsLayer } from "../src/conventions/parse";
import { SCHEMA_LIMITS } from "../src/tools/m7/knowledge/wiki-schema";

const BLOCK = `---
conventions:
  frontmatter:
    type_key: kind
    required: [type]
    values:
      type: [meeting, research]
      tags: [project, meeting, "area/*"]
    types:
      meeting:
        required: [status, date]
        values: { status: [scheduled, held], tags: [meeting, "project/*"] }
---
# Rules
`;

const S = "a/SCHEMA.md";

describe("parseConventionsLayer", () => {
  it("reads a valid block: type key, global and per-type rules", () => {
    const r = parseConventionsLayer(BLOCK, S);
    expect(r.warnings).toEqual([]);
    expect(r.layer).toMatchObject({
      path: S,
      version: 1,
      inherit: true,
      typeKey: "kind",
      required: ["type"],
      values: {
        type: ["meeting", "research"],
        tags: ["project", "meeting", "area/*"],
      },
      types: {
        meeting: {
          required: ["status", "date"],
          values: { status: ["scheduled", "held"], tags: ["meeting", "project/*"] },
        },
      },
    });
  });

  it("a SCHEMA.md with no conventions key is no layer and no warning", () => {
    expect(parseConventionsLayer("---\ntitle: x\n---\nbody\n", S)).toEqual({
      layer: null,
      warnings: [],
      legacyOnly: false,
    });
    expect(parseConventionsLayer("# plain prose\n", S)).toMatchObject({
      layer: null,
      warnings: [],
    });
  });

  it("bad YAML is a warning and no layer, never a throw", () => {
    const r = parseConventionsLayer("---\nconventions: [unclosed\n  bad: : :\n---\n", S);
    expect(r.layer).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("not read");
  });

  it("a file over the byte cap is not read", () => {
    const big = `---\nconventions:\n  frontmatter:\n    required: [type]\n---\n${"x".repeat(SCHEMA_LIMITS.fileBytes)}`;
    const r = parseConventionsLayer(big, S);
    expect(r.layer).toBeNull();
    expect(r.warnings.join(" ")).toContain("larger than");
  });

  it("a conventions value that is not a map is ignored with a warning", () => {
    const r = parseConventionsLayer("---\nconventions: [a, b]\n---\n", S);
    expect(r.layer).toBeNull();
    expect(r.warnings.join(" ")).toContain("must be a map");
  });

  it("future keys are named and ignored, the rest of the layer still counts", () => {
    const r = parseConventionsLayer(
      "---\nconventions:\n  filenames: {pattern: x}\n  placement: inbox\n  frontmatter:\n    required: [type]\n---\n",
      S,
    );
    expect(r.layer?.required).toEqual(["type"]);
    const text = r.warnings.join(" | ");
    expect(text).toContain("filenames");
    expect(text).toContain("placement");
    expect(text).toContain("not supported yet; ignored");
  });

  it("a non-scalar value is dropped with a warning and the scalars are kept", () => {
    const r = parseConventionsLayer(
      "---\nconventions:\n  frontmatter:\n    values:\n      status: [draft, {a: 1}, current]\n---\n",
      S,
    );
    expect(r.layer?.values.status).toEqual(["draft", "current"]);
    expect(r.warnings.join(" ")).toContain("dropped");
  });

  it("booleans and numbers are scalars and are read as their text", () => {
    const r = parseConventionsLayer(
      "---\nconventions:\n  frontmatter:\n    values:\n      published: [true, false, 2]\n---\n",
      S,
    );
    expect(r.layer?.values.published).toEqual(["true", "false", "2"]);
    expect(r.warnings).toEqual([]);
  });

  it("a higher version than this server reads is ignored with a warning", () => {
    const r = parseConventionsLayer(
      "---\nconventions:\n  version: 2\n  frontmatter:\n    required: [type]\n---\n",
      S,
    );
    expect(r.layer).toBeNull();
    expect(r.warnings.join(" ")).toContain("version");
  });

  it("a legacy-only SCHEMA.md is flagged so the caller can hint, and yields no layer", () => {
    const r = parseConventionsLayer("---\ntypes:\n  concept:\n    required: [summary]\n---\n", S);
    expect(r.layer).toBeNull();
    expect(r.legacyOnly).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("inherit defaults to true and false is read as false", () => {
    expect(parseConventionsLayer(BLOCK, S).layer?.inherit).toBe(true);
    const off = parseConventionsLayer(
      "---\nconventions:\n  inherit: false\n  frontmatter:\n    required: [type]\n---\n",
      S,
    );
    expect(off.layer?.inherit).toBe(false);
  });

  it("an explicit [] or null is kept as a removal marker, not dropped", () => {
    const r = parseConventionsLayer(
      "---\nconventions:\n  frontmatter:\n    required: []\n    values:\n      status:\n      tags: [x]\n---\n",
      S,
    );
    expect(r.layer?.required).toEqual([]);
    expect(r.layer?.values.status).toEqual([]);
    expect(r.layer?.values.tags).toEqual(["x"]);
  });

  it("YAML dates stay strings, so a date value compares as the text written", () => {
    const r = parseConventionsLayer(
      "---\nconventions:\n  frontmatter:\n    values:\n      due: [2026-10-24]\n---\n",
      S,
    );
    expect(r.layer?.values.due).toEqual(["2026-10-24"]);
  });
});
