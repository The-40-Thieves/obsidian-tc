// THE-496: the ACL fingerprint is the SECURITY-CRITICAL half of the query-cache key — the only thing
// that keeps caller A's cached results from reaching caller B. It must be identical for identical
// effective ACLs (config + caller scopes) and provably different otherwise. The read predicate is a
// pure function of the ACL config + granted scopes, so fingerprinting those is sound and cheap.
import { describe, expect, it } from "vitest";
import { type AclConfigT, aclFingerprint } from "../src/acl";

const cfg = (over: Partial<AclConfigT> = {}): AclConfigT => ({
  readOnly: false,
  defaultScopes: [],
  rules: [],
  ...over,
});

describe("THE-496 aclFingerprint", () => {
  it("is identical for identical (config, scopes)", () => {
    const c = cfg({
      rules: [{ glob: "projects/**", scopes: ["read:notes"] }],
      readPaths: ["a/**"],
    });
    expect(aclFingerprint(c, ["read:notes"])).toBe(aclFingerprint(c, ["read:notes"]));
  });

  it("differs when the caller's granted scopes differ (no cross-caller leak)", () => {
    const c = cfg({ rules: [{ glob: "secret/**", scopes: ["read:secret"] }] });
    expect(aclFingerprint(c, ["read:*"])).not.toBe(aclFingerprint(c, ["read:notes"]));
  });

  it("differs when the ACL config differs", () => {
    expect(aclFingerprint(cfg({ readPaths: ["a/**"] }), ["s"])).not.toBe(
      aclFingerprint(cfg({ readPaths: ["b/**"] }), ["s"]),
    );
    expect(aclFingerprint(cfg({ strictReadDefault: true }), ["s"])).not.toBe(
      aclFingerprint(cfg({ strictReadDefault: false }), ["s"]),
    );
    expect(aclFingerprint(cfg({ readOnly: true }), ["s"])).not.toBe(
      aclFingerprint(cfg({ readOnly: false }), ["s"]),
    );
  });

  it("is order-INSENSITIVE for sets (scopes, path whitelists)", () => {
    // granted scopes are a set
    expect(aclFingerprint(cfg(), ["a", "b"])).toBe(aclFingerprint(cfg(), ["b", "a"]));
    // dedup
    expect(aclFingerprint(cfg(), ["a", "a", "b"])).toBe(aclFingerprint(cfg(), ["a", "b"]));
    // path whitelist is membership -> order-insensitive
    expect(aclFingerprint(cfg({ readPaths: ["x/**", "y/**"] }), ["s"])).toBe(
      aclFingerprint(cfg({ readPaths: ["y/**", "x/**"] }), ["s"]),
    );
    // scopes WITHIN a rule are a set
    expect(aclFingerprint(cfg({ rules: [{ glob: "p/**", scopes: ["a", "b"] }] }), ["s"])).toBe(
      aclFingerprint(cfg({ rules: [{ glob: "p/**", scopes: ["b", "a"] }] }), ["s"]),
    );
  });

  it("is order-SENSITIVE for the rules array (last-match-wins semantics)", () => {
    const ruleA = { glob: "**", scopes: ["read:none"] };
    const ruleB = { glob: "projects/**", scopes: ["read:all"] };
    // [ruleA, ruleB] and [ruleB, ruleA] resolve a path in projects/ to DIFFERENT scopes -> must differ
    expect(aclFingerprint(cfg({ rules: [ruleA, ruleB] }), ["s"])).not.toBe(
      aclFingerprint(cfg({ rules: [ruleB, ruleA] }), ["s"]),
    );
  });

  it("returns a fixed-width hex digest usable as a cache key", () => {
    const fp = aclFingerprint(cfg(), ["s"]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});
