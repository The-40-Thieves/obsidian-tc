import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { applyLogic, evaluatesTruthy } from "../src/search/jsonlogic";

const data = {
  status: "active",
  priority: 3,
  tags: ["a", "b"],
  meta: { owner: "sam" },
  title: "Quarterly plan",
};

describe("applyLogic", () => {
  it("resolves var with dotted paths and defaults", () => {
    expect(applyLogic({ var: "status" }, data)).toBe("active");
    expect(applyLogic({ var: "meta.owner" }, data)).toBe("sam");
    expect(applyLogic({ var: ["missing", "fallback"] }, data)).toBe("fallback");
    expect(applyLogic({ var: "missing" }, data)).toBeNull();
  });

  it("evaluates comparisons (loose and strict)", () => {
    expect(applyLogic({ "==": [{ var: "status" }, "active"] }, data)).toBe(true);
    expect(applyLogic({ "==": [{ var: "priority" }, "3"] }, data)).toBe(true); // loose
    expect(applyLogic({ "===": [{ var: "priority" }, "3"] }, data)).toBe(false); // strict
    expect(applyLogic({ ">": [{ var: "priority" }, 2] }, data)).toBe(true);
    expect(applyLogic({ "<=": [{ var: "priority" }, 3] }, data)).toBe(true);
  });

  it("evaluates and / or / ! with truthiness", () => {
    expect(
      applyLogic(
        { and: [{ "==": [{ var: "status" }, "active"] }, { ">": [{ var: "priority" }, 1] }] },
        data,
      ),
    ).toBe(true);
    expect(applyLogic({ or: [false, { "==": [{ var: "status" }, "x"] }, true] }, data)).toBe(true);
    expect(applyLogic({ "!": [{ var: "missing" }] }, data)).toBe(true);
  });

  it("evaluates in over arrays and strings", () => {
    expect(applyLogic({ in: ["a", { var: "tags" }] }, data)).toBe(true);
    expect(applyLogic({ in: ["z", { var: "tags" }] }, data)).toBe(false);
    expect(applyLogic({ in: ["plan", { var: "title" }] }, data)).toBe(true);
  });

  it("reports missing keys", () => {
    expect(applyLogic({ missing: ["status", "nope"] }, data)).toEqual(["nope"]);
  });

  it("throws jsonlogic_error on an unknown operator", () => {
    try {
      applyLogic({ frobnicate: [1, 2] }, data);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("jsonlogic_error");
    }
  });

  it("throws jsonlogic_error when an object has multiple operator keys", () => {
    expect(() => applyLogic({ "==": [1, 1], ">": [2, 1] }, data)).toThrow(ObsidianTcError);
  });
});

describe("evaluatesTruthy", () => {
  it("coerces the result to a boolean for filtering", () => {
    expect(evaluatesTruthy({ "==": [{ var: "status" }, "active"] }, data)).toBe(true);
    expect(evaluatesTruthy({ var: "missing" }, data)).toBe(false);
  });
});

describe("jsonlogic op budget (THE-293)", () => {
  it("rejects a wide flat expression over the op budget", () => {
    const rule = { and: Array.from({ length: 10_001 }, () => true) } as unknown as Parameters<
      typeof evaluatesTruthy
    >[0];
    try {
      evaluatesTruthy(rule, data);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("jsonlogic_error");
      expect((e as ObsidianTcError).message).toContain("operation budget");
    }
  });

  it("evaluates a normal-width expression and the budget is fresh per call", () => {
    const rule = { and: Array.from({ length: 5000 }, () => true) } as unknown as Parameters<
      typeof evaluatesTruthy
    >[0];
    expect(evaluatesTruthy(rule, data)).toBe(true);
    expect(evaluatesTruthy(rule, data)).toBe(true);
  });
});

describe("THE-201 extended operators", () => {
  const ev = (rule: unknown, d: Record<string, unknown> = {}) => applyLogic(rule, d);

  it("if — chained conditional", () => {
    expect(ev({ if: [{ ">": [{ var: "n" }, 10] }, "big", "small"] }, { n: 20 })).toBe("big");
    expect(ev({ if: [false, "a", false, "b", "else"] })).toBe("else");
  });

  it("min / max / substr / merge / missing_some", () => {
    expect(ev({ min: [3, 1, 2] })).toBe(1);
    expect(ev({ max: [3, 1, 2] })).toBe(3);
    expect(ev({ substr: ["hello", 1, 3] })).toBe("ell");
    expect(ev({ substr: ["hello", -2] })).toBe("lo");
    expect(ev({ merge: [[1, 2], [3], 4] })).toEqual([1, 2, 3, 4]);
    expect(ev({ missing_some: [1, ["a", "b"]] }, { a: 1 })).toEqual([]);
    expect(ev({ missing_some: [2, ["a", "b"]] }, { a: 1 })).toEqual(["b"]);
  });

  it("all / some / none over an array-valued field", () => {
    const d = { tags: ["x", "y", "z"] };
    expect(ev({ all: [{ var: "tags" }, { "!=": [{ var: "" }, ""] }] }, d)).toBe(true);
    expect(ev({ some: [{ var: "tags" }, { "==": [{ var: "" }, "y"] }] }, d)).toBe(true);
    expect(ev({ none: [{ var: "tags" }, { "==": [{ var: "" }, "q"] }] }, d)).toBe(true);
    expect(ev({ all: [[], { var: "" }] })).toBe(false);
  });

  it("map / filter / reduce", () => {
    expect(ev({ map: [[1, 2, 3], { "*": [{ var: "" }, 2] }] })).toEqual([2, 4, 6]);
    expect(ev({ filter: [[1, 2, 3, 4], { ">": [{ var: "" }, 2] }] })).toEqual([3, 4]);
    expect(
      ev({ reduce: [[1, 2, 3], { "+": [{ var: "current" }, { var: "accumulator" }] }, 0] }),
    ).toBe(6);
  });

  it("unknown operator still raises jsonlogic_error", () => {
    expect(() => ev({ bogus: [1] })).toThrow(ObsidianTcError);
  });
});
