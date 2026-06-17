import { describe, expect, it } from "vitest";
import { argsHash } from "../src/hash";

describe("argsHash", () => {
  it("is 32 hex chars (16 bytes)", () => {
    expect(argsHash("read_note", { path: "a.md" })).toMatch(/^[0-9a-f]{32}$/);
  });
  it("is independent of key order", () => {
    expect(argsHash("t", { a: 1, b: 2 })).toBe(argsHash("t", { b: 2, a: 1 }));
  });
  it("changes with tool name and args", () => {
    expect(argsHash("t", { a: 1 })).not.toBe(argsHash("u", { a: 1 }));
    expect(argsHash("t", { a: 1 })).not.toBe(argsHash("t", { a: 2 }));
  });
});
