// THE-526: `securityProfile: "hardened"` — one key that activates the least-privilege posture instead
// of hand-merging ~6 fields across 4 config sections. The profile is a BASE applied before validation;
// any explicitly-set field wins, so "hardened, but with my paths" is one key plus the overrides.
//
// Done-when: the profile alone yields the same effective SECURITY fields as examples/config.hardened.json
// (the readPaths/writePaths there are illustrative user paths, deliberately NOT part of a generic
// profile); explicit fields override it; the active profile is named at startup.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applySecurityProfile } from "../src/config/security-profile";

const hardenedExample = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../examples/config.hardened.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

describe("THE-526 applySecurityProfile", () => {
  it("hardened alone reproduces the hardened example's generic security posture", () => {
    const raw = applySecurityProfile({
      vaults: [{ id: "main", path: "/v" }],
      securityProfile: "hardened",
    });
    // deep-get helper keeps the strict-null checker happy on nested example lookups.
    const at = (o: unknown, ...keys: string[]): unknown =>
      keys.reduce<unknown>((cur, k) => (cur as Record<string, unknown> | undefined)?.[k], o);

    expect(at(raw, "acl", "strictReadDefault")).toBe(
      at(hardenedExample, "acl", "strictReadDefault"),
    ); // true
    expect(at(raw, "writes", "requireCas")).toBe(at(hardenedExample, "writes", "requireCas")); // true
    expect(at(raw, "snapshots", "enabled")).toBe(at(hardenedExample, "snapshots", "enabled")); // true
    expect(at(raw, "transports", "http", "enabled")).toBe(
      at(hardenedExample, "transports", "http", "enabled"),
    ); // false
  });

  it("lets an explicitly-set field override the profile (hardened, but with my choice)", () => {
    const raw = applySecurityProfile({
      vaults: [{ id: "main", path: "/v" }],
      securityProfile: "hardened",
      writes: { requireCas: false }, // operator opts out of CAS specifically
      acl: { readPaths: ["notes/**"] }, // "with my paths"
    });
    const writes = raw.writes as Record<string, unknown>;
    const acl = raw.acl as Record<string, unknown>;
    expect(writes.requireCas).toBe(false); // explicit wins
    expect(acl.strictReadDefault).toBe(true); // profile still fills the unset field
    expect(acl.readPaths).toEqual(["notes/**"]); // explicit paths preserved
  });

  it("is a no-op for trusted-local and for an absent profile", () => {
    const before = { vaults: [{ id: "main", path: "/v" }], acl: { strictReadDefault: false } };
    expect(applySecurityProfile({ ...before, securityProfile: "trusted-local" })).toEqual({
      ...before,
      securityProfile: "trusted-local",
    });
    expect(applySecurityProfile(before)).toEqual(before);
  });

  it("does not deep-merge arrays — an explicit path array replaces, never concatenates", () => {
    const raw = applySecurityProfile({
      vaults: [{ id: "main", path: "/v" }],
      securityProfile: "hardened",
      acl: { deletePaths: ["trash/**"] },
    });
    const acl = raw.acl as Record<string, unknown>;
    expect(acl.deletePaths).toEqual(["trash/**"]);
  });
});

// End-to-end through the real schema: hardened must parse into a config whose security fields match.
import { finalizeConfig } from "../src/config/load";

describe("THE-526 hardened profile through finalizeConfig", () => {
  it("produces the hardened security fields after full validation", () => {
    const cfg = finalizeConfig({
      vaults: [{ id: "main", path: "/v" }],
      securityProfile: "hardened",
    });
    expect(cfg.acl.strictReadDefault).toBe(true);
    expect(cfg.writes.requireCas).toBe(true);
    expect(cfg.snapshots.enabled).toBe(true);
    expect(cfg.transports.http.enabled).toBe(false);
    expect(cfg.securityProfile).toBe("hardened");
  });
});
