// checkNote: pure rules over a resolved effective set. Every warning code, the type list rules, tag
// matching (case-insensitive, `x/*` nested, `x` exact), exact aliases, the skip list and the cap.
import { afterEach, describe, expect, it } from "vitest";
import { capConventionWarnings, checkNote } from "../src/conventions/check";
import { resolveConventions } from "../src/conventions/resolve";
import type { ConventionWarning } from "../src/conventions/schema";
import { parseNoteLenient } from "../src/vault/frontmatter";
import { makeTestVault, type TestVault } from "./m1-helpers";

let v: TestVault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

const RULES = `---
conventions:
  frontmatter:
    required: [type]
    values:
      type: [meeting, research]
      status: [draft, current]
      tags: [project, "area/*"]
      aliases: [Home]
    types:
      meeting:
        required: [date]
        values:
          status: [scheduled, held]
          tags: [meeting, "project/*"]
---
`;

/** Resolve the effective rules of a vault whose root SCHEMA.md is `schema`, for a note at `note`. */
function effectiveFor(schema: string, note = "n.md") {
  v = makeTestVault({ files: { "SCHEMA.md": schema, [note]: "x" } });
  return resolveConventions(
    { vaultId: v.id, root: v.root, acl: v.acl, grantedScopes: ["*"] },
    note,
  );
}

/** The frontmatter of a note exactly as the vault parses it (YAML dates stay text). */
const fmOf = (raw: string) => parseNoteLenient(raw, "n.md").frontmatter;
const codes = (ws: ConventionWarning[]) => ws.map((w) => `${w.code}:${w.property ?? ""}`);

describe("checkNote: rule codes", () => {
  const eff = effectiveFor(RULES);

  it("a conforming note has no warnings", () => {
    const fm = fmOf("---\ntype: meeting\nstatus: held\ndate: 2026-10-24\ntags: [meeting]\n---\n");
    expect(checkNote(eff, "meetings/m.md", fm)).toEqual([]);
  });

  it("missing_required names the field and the layer that required it", () => {
    const [w] = checkNote(eff, "n.md", fmOf("---\nstatus: draft\n---\n"));
    expect(w).toMatchObject({
      code: "missing_required",
      property: "type",
      level: "warn",
      source: "SCHEMA.md",
    });
  });

  it("value_not_allowed carries the values found and the allowed list", () => {
    const [w] = checkNote(eff, "n.md", fmOf("---\ntype: research\nstatus: stale\n---\n"));
    expect(w).toMatchObject({
      code: "value_not_allowed",
      property: "status",
      values: ["stale"],
      allowed: ["draft", "current"],
      source: "SCHEMA.md",
    });
  });

  it("value_not_scalar flags a map value", () => {
    const ws = checkNote(eff, "n.md", fmOf("---\ntype: research\nstatus:\n  a: 1\n---\n"));
    expect(codes(ws)).toContain("value_not_scalar:status");
  });

  it("type_not_scalar flags a list of several types", () => {
    const fm = fmOf("---\ntype: [meeting, research]\n---\n");
    expect(codes(checkNote(eff, "n.md", fm))).toEqual(["type_not_scalar:type"]);
  });
});

describe("checkNote: type rules", () => {
  const eff = effectiveFor(RULES);

  it("a one-element type list is read as that type", () => {
    const fm = fmOf("---\ntype: [meeting]\nstatus: held\n---\n");
    expect(checkNote(eff, "n.md", fm).map((w) => w.code)).toEqual(["missing_required"]);
  });

  it("a list of several types applies only the global rules", () => {
    // meeting would require `date`; with no single type only the global `type` rule applies.
    const fm = fmOf("---\ntype: [meeting, research]\n---\n");
    const ws = checkNote(eff, "n.md", fm);
    expect(codes(ws)).toEqual(["type_not_scalar:type"]);
  });

  it("a type-specific value beats the global one for that type", () => {
    const meeting = fmOf("---\ntype: meeting\ndate: 2026-10-24\nstatus: scheduled\n---\n");
    expect(checkNote(eff, "n.md", meeting)).toEqual([]);
    const research = fmOf("---\ntype: research\nstatus: scheduled\n---\n");
    expect(codes(checkNote(eff, "n.md", research))).toEqual(["value_not_allowed:status"]);
  });

  it("type-specific required fields are added to the global ones", () => {
    const ws = checkNote(eff, "n.md", fmOf("---\ntype: meeting\n---\n"));
    expect(ws).toEqual([
      expect.objectContaining({ code: "missing_required", property: "date", source: "SCHEMA.md" }),
    ]);
  });
});

describe("checkNote: tags and aliases", () => {
  const eff = effectiveFor(RULES);

  it("tags match case-insensitively", () => {
    const fm = fmOf("---\ntype: research\ntags: [PROJECT]\n---\n");
    expect(checkNote(eff, "n.md", fm)).toEqual([]);
  });

  it("`area/*` matches any nested tag under area, case-insensitively", () => {
    const fm = fmOf("---\ntype: research\ntags: [Area/Sub/Deep]\n---\n");
    expect(checkNote(eff, "n.md", fm)).toEqual([]);
  });

  it("`area/*` does not match `area` itself", () => {
    const fm = fmOf("---\ntype: research\ntags: [area]\n---\n");
    expect(codes(checkNote(eff, "n.md", fm))).toEqual(["value_not_allowed:tags"]);
  });

  it("`project` matches exactly, not `projects`", () => {
    const fm = fmOf("---\ntype: research\ntags: [projects]\n---\n");
    expect(codes(checkNote(eff, "n.md", fm))).toEqual(["value_not_allowed:tags"]);
  });

  it("aliases match exactly, case-sensitively", () => {
    expect(checkNote(eff, "n.md", fmOf("---\ntype: research\naliases: [Home]\n---\n"))).toEqual([]);
    expect(
      codes(checkNote(eff, "n.md", fmOf("---\ntype: research\naliases: [home]\n---\n"))),
    ).toEqual(["value_not_allowed:aliases"]);
  });

  it("other values are case-sensitive, and page values are trimmed and NFC-normalised", () => {
    expect(codes(checkNote(eff, "n.md", fmOf("---\ntype: Research\n---\n")))).toEqual([
      "value_not_allowed:type",
    ]);
    expect(checkNote(eff, "n.md", fmOf('---\ntype: " research "\n---\n'))).toEqual([]);
  });
});

describe("checkNote: skip list and cap", () => {
  const eff = effectiveFor(RULES);
  const bad = fmOf("---\nstatus: nope\n---\n");

  it.each([
    ["SCHEMA.md"],
    ["a/SCHEMA.md"],
    ["notes/data.txt"],
    ["a/.hidden/n.md"],
    ["raw/source.md"],
  ])("%s is not checked", (path) => {
    const scoped = { ...eff, rawFolders: ["raw"] };
    expect(checkNote(scoped, path, bad)).toEqual([]);
  });

  it("the wiki's generated index.md and log.md are not checked", () => {
    const scoped = { ...eff, wikiFolders: ["wiki"] };
    expect(checkNote(scoped, "wiki/index.md", bad)).toEqual([]);
    expect(checkNote(scoped, "wiki/log.md", bad)).toEqual([]);
    expect(checkNote(scoped, "wiki/page.md", bad).length).toBeGreaterThan(0);
  });

  it("warnings are capped at 50 and the rest counted in warnings_omitted", () => {
    const many: ConventionWarning[] = Array.from({ length: 60 }, (_, i) => ({
      path: `n${i}.md`,
      code: "value_not_allowed",
      message: "x",
      source: "SCHEMA.md",
      level: "warn",
    }));
    const out = capConventionWarnings(many);
    expect(out.warnings).toHaveLength(50);
    expect(out.warnings_omitted).toBe(10);
    expect(capConventionWarnings(many.slice(0, 3))).toEqual({ warnings: many.slice(0, 3) });
  });
});
