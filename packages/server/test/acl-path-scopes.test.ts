// P1.4 (audit THE-562): rule-scopes are now load-bearing — a path's declared scopes must be a
// subset of the caller's granted scopes. pathScopesSatisfied is the pure predicate; enforcePathAcl
// applies it when the central dispatch stage passes the caller's grantedScopes.
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { pathScopesSatisfied } from "../src/vault/acl-path";

function acl(over: Record<string, unknown> = {}): FolderAcl {
  return new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });
}

describe("P1.4 rule-scope enforcement (pathScopesSatisfied)", () => {
  it("no ACL -> satisfied (nothing to enforce)", () => {
    expect(pathScopesSatisfied(undefined, "finance/q.md", [])).toBe(true);
  });

  it("a path with no matching rule and empty defaultScopes requires nothing (shipped-config no-op)", () => {
    expect(pathScopesSatisfied(acl(), "notes/a.md", [])).toBe(true);
  });

  it("denies when the caller lacks a scope the path's rule declares", () => {
    const a = acl({ rules: [{ glob: "finance/**", scopes: ["read:finance"] }] });
    expect(pathScopesSatisfied(a, "finance/q1.md", ["read:notes"])).toBe(false);
  });

  it("allows when the caller holds the path's rule scope", () => {
    const a = acl({ rules: [{ glob: "finance/**", scopes: ["read:finance"] }] });
    expect(pathScopesSatisfied(a, "finance/q1.md", ["read:notes", "read:finance"])).toBe(true);
  });

  it("a non-matching path is unaffected by another folder's rule scope", () => {
    const a = acl({ rules: [{ glob: "finance/**", scopes: ["read:finance"] }] });
    expect(pathScopesSatisfied(a, "notes/a.md", ["read:notes"])).toBe(true);
  });

  it("is wildcard-aware — a caller holding * satisfies any required scope", () => {
    const a = acl({ rules: [{ glob: "finance/**", scopes: ["read:finance"] }] });
    expect(pathScopesSatisfied(a, "finance/q1.md", ["*"])).toBe(true);
  });

  it("honors last-match-wins (a later rule's scopes govern)", () => {
    const a = acl({
      rules: [
        { glob: "finance/**", scopes: ["read:finance"] },
        { glob: "finance/public/**", scopes: [] },
      ],
    });
    // finance/public/x.md matches both; the later (empty) rule wins -> no scope required.
    expect(pathScopesSatisfied(a, "finance/public/x.md", [])).toBe(true);
    // finance/private/x.md matches only the first -> read:finance required.
    expect(pathScopesSatisfied(a, "finance/private/x.md", [])).toBe(false);
  });

  it("enforces defaultScopes on a path no rule matches", () => {
    const a = acl({ defaultScopes: ["read:notes"] });
    expect(pathScopesSatisfied(a, "notes/a.md", [])).toBe(false);
    expect(pathScopesSatisfied(a, "notes/a.md", ["read:notes"])).toBe(true);
  });
});
