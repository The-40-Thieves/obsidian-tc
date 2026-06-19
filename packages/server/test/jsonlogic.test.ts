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
