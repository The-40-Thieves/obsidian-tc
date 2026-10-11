import { tmpdir } from "node:os";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { resolveLibsqlSync } from "../src/db/sync-config";

const cfg = (storage?: Record<string, unknown>) =>
  ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: tmpdir() }],
    ...(storage !== undefined ? { storage } : {}),
  });

describe("resolveLibsqlSync", () => {
  it("is undefined when storage.sync is not configured", () => {
    expect(resolveLibsqlSync(cfg(), {})).toBeUndefined();
    expect(resolveLibsqlSync(cfg({}), {})).toBeUndefined();
  });

  it("returns the url alone when no token variable is named", () => {
    expect(resolveLibsqlSync(cfg({ sync: { url: "http://127.0.0.1:8080" } }), {})).toEqual({
      url: "http://127.0.0.1:8080",
    });
  });

  it("reads the token from the variable the config names", () => {
    const got = resolveLibsqlSync(
      cfg({ sync: { url: "https://x.turso.io", authTokenEnv: "TURSO_TOKEN" } }),
      { TURSO_TOKEN: "tok-123" },
    );
    expect(got).toEqual({ url: "https://x.turso.io", authToken: "tok-123" });
  });

  it.each([
    ["unset", {}],
    ["empty", { TURSO_TOKEN: "" }],
  ])("throws naming the variable (never a value) when it is %s", (_label, env) => {
    const c = cfg({ sync: { url: "https://x.turso.io", authTokenEnv: "TURSO_TOKEN" } });
    expect(() => resolveLibsqlSync(c, env)).toThrow(/TURSO_TOKEN/);
    // Another variable's value in the environment must not leak into the message either.
    let message = "";
    try {
      resolveLibsqlSync(c, { ...env, OTHER: "secret-value" });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("TURSO_TOKEN");
    expect(message).not.toContain("secret-value");
  });
});
