import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLegacyEnvAliases,
  CURRENT_NAMES,
  LEGACY_NAMES,
  matchResourceScheme,
  pickHomeDir,
  readMetaKey,
} from "../src/legacy-names";

describe("legacy names: the rename from obsidian-tc keeps every old name working", () => {
  it("pairs a current and a legacy value for every renamed identifier", () => {
    expect(Object.keys(LEGACY_NAMES).sort()).toEqual(Object.keys(CURRENT_NAMES).sort());
    for (const key of Object.keys(CURRENT_NAMES) as (keyof typeof CURRENT_NAMES)[]) {
      expect(CURRENT_NAMES[key]).not.toBe(LEGACY_NAMES[key]);
    }
    expect(CURRENT_NAMES.envPrefix).toBe("RELIQUARY_TC_");
    expect(LEGACY_NAMES.envPrefix).toBe("OBSIDIAN_TC_");
  });

  describe("applyLegacyEnvAliases", () => {
    it("copies an old-prefix variable to the new prefix when the new one is unset", () => {
      const env: Record<string, string | undefined> = { OBSIDIAN_TC_CONFIG: "/a.json" };
      const aliased = applyLegacyEnvAliases(env);
      expect(env.RELIQUARY_TC_CONFIG).toBe("/a.json");
      expect(aliased).toEqual(["OBSIDIAN_TC_CONFIG"]);
    });

    it("lets the new name win when both are set", () => {
      const env: Record<string, string | undefined> = {
        OBSIDIAN_TC_CONFIG: "/old.json",
        RELIQUARY_TC_CONFIG: "/new.json",
      };
      expect(applyLegacyEnvAliases(env)).toEqual([]);
      expect(env.RELIQUARY_TC_CONFIG).toBe("/new.json");
    });

    it("treats an empty new value as set, so an explicit blank is not overridden", () => {
      const env: Record<string, string | undefined> = {
        OBSIDIAN_TC_TOKEN: "secret",
        RELIQUARY_TC_TOKEN: "",
      };
      expect(applyLegacyEnvAliases(env)).toEqual([]);
      expect(env.RELIQUARY_TC_TOKEN).toBe("");
    });

    it("ignores the bare prefix and undefined values", () => {
      const env: Record<string, string | undefined> = {
        OBSIDIAN_TC_: "x",
        OBSIDIAN_TC_UNSET: undefined,
      };
      expect(applyLegacyEnvAliases(env)).toEqual([]);
      expect("RELIQUARY_TC_" in env).toBe(false);
      expect("RELIQUARY_TC_UNSET" in env).toBe(false);
    });

    it("is idempotent", () => {
      const env: Record<string, string | undefined> = { OBSIDIAN_TC_A: "1" };
      expect(applyLegacyEnvAliases(env)).toEqual(["OBSIDIAN_TC_A"]);
      expect(applyLegacyEnvAliases(env)).toEqual([]);
    });
  });

  describe("matchResourceScheme", () => {
    it("accepts both schemes and reports which one matched", () => {
      expect(matchResourceScheme("reliquary-tc://main/a.md")).toEqual({
        rest: "main/a.md",
        legacy: false,
      });
      expect(matchResourceScheme("obsidian-tc://main/a.md")).toEqual({
        rest: "main/a.md",
        legacy: true,
      });
    });

    it("rejects a foreign scheme", () => {
      expect(matchResourceScheme("file:///etc/passwd")).toBeNull();
      expect(matchResourceScheme("reliquary-tcx://main/a.md")).toBeNull();
    });
  });

  describe("pickHomeDir", () => {
    const home = join("home", "u");
    const fresh = join(home, ".reliquary-tc");
    const old = join(home, ".obsidian-tc");
    it("uses the new folder when it exists", () => {
      const exists = (p: string) => p === fresh || p === old;
      expect(pickHomeDir(home, exists)).toEqual({ dir: fresh, legacy: false });
    });

    it("falls back to the old folder when only it exists", () => {
      const exists = (p: string) => p === old;
      expect(pickHomeDir(home, exists)).toEqual({ dir: old, legacy: true });
    });

    it("picks the new folder on a fresh install", () => {
      expect(pickHomeDir(home, () => false)).toEqual({ dir: fresh, legacy: false });
    });
  });

  describe("readMetaKey", () => {
    it("prefers the current key and falls back to the legacy one", () => {
      const current = CURRENT_NAMES.provenanceMetaKey;
      const legacy = LEGACY_NAMES.provenanceMetaKey;
      expect(readMetaKey({ [current]: 1, [legacy]: 2 }, "provenanceMetaKey")).toBe(1);
      expect(readMetaKey({ [legacy]: 2 }, "provenanceMetaKey")).toBe(2);
      expect(readMetaKey({}, "provenanceMetaKey")).toBeUndefined();
      expect(readMetaKey(undefined, "provenanceMetaKey")).toBeUndefined();
    });
  });
});
