// auth.rotationGraceSeconds: default 0 (behaviour preserved), bounded at 7 days, and the schema
// no longer demands a static signing key (the registry can be the only one).
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { MAX_ROTATION_GRACE_SECONDS } from "../src/auth/signing-keys";
import { parseCliArgs } from "../src/cli/args";

const parse = (auth: Record<string, unknown>) =>
  ServerConfigSchema.safeParse({ vaults: [{ id: "m", path: "/v" }], auth });

describe("auth.rotationGraceSeconds", () => {
  it("defaults to 0, so an unconfigured deployment still retires the previous key at once", () => {
    const r = parse({ mode: "jwt", jwtSecret: "x".repeat(32) });
    expect(r.success && r.data.auth.rotationGraceSeconds).toBe(0);
  });

  it("accepts 0 through the 7-day cap", () => {
    for (const v of [0, 1, 3600, MAX_ROTATION_GRACE_SECONDS]) {
      const r = parse({ mode: "jwt", jwtSecret: "x".repeat(32), rotationGraceSeconds: v });
      expect(r.success && r.data.auth.rotationGraceSeconds).toBe(v);
    }
  });

  it("refuses negative, fractional, non-numeric and over-cap values", () => {
    for (const v of [-1, 1.5, "3600", MAX_ROTATION_GRACE_SECONDS + 1, Number.NaN, null]) {
      expect(
        parse({ mode: "jwt", jwtSecret: "x".repeat(32), rotationGraceSeconds: v }).success,
      ).toBe(false);
    }
  });

  it("the schema cap and the server constant agree (7 days)", () => {
    expect(MAX_ROTATION_GRACE_SECONDS).toBe(7 * 86_400);
  });

  it("--grace shares the cap, and --alg only takes the three algorithms", () => {
    expect(
      parseCliArgs(["auth", "rotate-key", "--grace", String(MAX_ROTATION_GRACE_SECONDS + 1)]),
    ).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "rotate-key", "--alg", "RS256"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "list", "--alg", "ES256"])).toMatchObject({ kind: "error" });
    for (const alg of ["HS256", "ES256", "EdDSA"]) {
      expect(parseCliArgs(["auth", "rotate-key", "--alg", alg, "c.json"])).toMatchObject({
        kind: "auth",
        sub: "rotate-key",
        alg,
        configPath: "c.json",
      });
    }
  });
});

describe("auth.mode jwt with no static key", () => {
  it("parses: the registry may hold the only key (the server refuses to boot if it holds none)", () => {
    expect(parse({ mode: "jwt" }).success).toBe(true);
  });
});
