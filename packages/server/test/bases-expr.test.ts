// THE-281 — Bases DSL subset evaluator unit tests.

import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import {
  type BasesNoteCtx,
  basesTruthy,
  classifyBaseFilter,
  evaluateBasesExpr,
  evaluateBasesFilter,
} from "../src/formats/bases-expr";

const ctx: BasesNoteCtx = {
  path: "projects/alpha.md",
  frontmatter: { status: "active", priority: 3, aliases: ["A", "Alpha"], done: false },
  tags: ["project", "project/sub"],
  links: ["notes/beta", "gamma"],
};

const ev = (src: string, c: BasesNoteCtx = ctx): unknown => evaluateBasesExpr(src, c);

describe("bases-expr evaluator (THE-281)", () => {
  it("literals, precedence, unary", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("-2 + 5")).toBe(3);
    expect(ev("!false && true")).toBe(true);
    expect(ev('"a" + "b"')).toBe("ab");
    expect(ev("[1, 2, 3].length()")).toBe(3);
  });

  it("property namespaces + bare identifiers", () => {
    expect(ev("note.status")).toBe("active");
    expect(ev("status")).toBe("active");
    expect(ev("file.name")).toBe("alpha");
    expect(ev("file.folder")).toBe("projects");
    expect(ev("priority >= 3")).toBe(true);
    expect(ev("missing == null")).toBe(true);
  });

  it("string + list methods", () => {
    expect(ev("note.status.upper()")).toBe("ACTIVE");
    expect(ev('"hello".contains("ell")')).toBe(true);
    expect(ev('note.status.startsWith("act")')).toBe(true);
    expect(ev('aliases.contains("Alpha")')).toBe(true);
    expect(ev('aliases.join("-")')).toBe("A-Alpha");
    expect(ev("missing.upper()")).toBe(null); // missing property -> null, not an error
  });

  it("file methods: hasTag / inFolder / hasLink", () => {
    expect(ev('file.hasTag("project")')).toBe(true);
    expect(ev('file.hasTag("#project")')).toBe(true);
    expect(ev('file.hasTag("nope")')).toBe(false);
    expect(ev('file.inFolder("projects")')).toBe(true);
    expect(ev('file.inFolder("other")')).toBe(false);
    expect(ev('file.hasLink("gamma")')).toBe(true);
    expect(ev('file.hasLink("notes/beta")')).toBe(true);
    expect(ev('file.hasLink("delta")')).toBe(false);
  });

  it("globals: if / date / min / max / list / number", () => {
    expect(ev('if(status == "active", "yes", "no")')).toBe("yes");
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev("max(3, 1, 2)")).toBe(3);
    expect(ev('number("42") + 1')).toBe(43);
    expect(ev('date("2026-01-02") > date("2026-01-01")')).toBe(true);
    expect(String(ev('date("2026-01-01") + "1d"')).startsWith("2026-01-02")).toBe(true);
  });

  it("unsupported constructs throw the typed refusal", () => {
    for (const bad of ["aliases.map(value)", "unknownFn(1)", 'note["x"]', "file.size"]) {
      try {
        ev(bad);
        throw new Error(`expected throw for ${bad}`);
      } catch (e) {
        expect(e, bad).toBeInstanceOf(ObsidianTcError);
        expect((e as ObsidianTcError).code, bad).toBe("unsupported_base_filter");
      }
    }
  });

  it("filter combinators + classification", () => {
    expect(evaluateBasesFilter('file.hasTag("project")', ctx)).toBe(true);
    expect(
      evaluateBasesFilter({ and: ['file.hasTag("project")', 'status == "active"'] }, ctx),
    ).toBe(true);
    expect(evaluateBasesFilter({ not: ['status == "done"'] }, ctx)).toBe(true);
    expect(evaluateBasesFilter({ or: ['status == "done"', "priority > 1"] }, ctx)).toBe(true);
    expect(classifyBaseFilter("x == 1")).toBe("dsl");
    expect(classifyBaseFilter({ and: ["a == 1", { or: ["b == 2"] }] })).toBe("dsl");
    expect(classifyBaseFilter({ "==": [{ var: "x" }, 1] })).toBe("jsonlogic");
    expect(classifyBaseFilter({ and: ["a == 1", { "==": [{ var: "x" }, 1] }] })).toBe("mixed");
    expect(classifyBaseFilter(undefined)).toBe("absent");
    expect(basesTruthy([])).toBe(false);
    expect(basesTruthy("x")).toBe(true);
  });
});
