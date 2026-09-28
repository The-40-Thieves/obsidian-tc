import { tmpdir } from "node:os";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { enforcePathAcl } from "../src/vault/acl-path";

// Per-path ACL helper. acl_denied is also exercised end-to-end through dispatch
// in notes-tools.test.ts; here we pin the helper's own branches, including the
// read_only_mode code that the dispatch global kill-switch (forbidden) pre-empts
// for scope-mutating tools but which remains the defense-in-depth M1 code.
function acl(over: Partial<ConstructorParameters<typeof FolderAcl>[0]> = {}): FolderAcl {
  return new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });
}

describe("enforcePathAcl", () => {
  it("allows any op when no ACL is present", () => {
    expect(() => enforcePathAcl(undefined, "write", "x.md", tmpdir())).not.toThrow();
  });

  it("an omitted whitelist leaves that op kind unrestricted", () => {
    const a = acl({ writePaths: ["notes/**"] }); // readPaths omitted
    expect(() => enforcePathAcl(a, "read", "anywhere/x.md", tmpdir())).not.toThrow();
    expect(() => enforcePathAcl(a, "write", "notes/x.md", tmpdir())).not.toThrow();
  });

  it("a whitelist miss is acl_denied", () => {
    const a = acl({ writePaths: ["notes/**"] });
    try {
      enforcePathAcl(a, "write", "secret/x.md", tmpdir());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("acl_denied");
    }
  });

  it("a read-only vault denies write/delete with read_only_mode but allows read", () => {
    const a = acl({ readOnly: true });
    expect(() => enforcePathAcl(a, "read", "x.md", tmpdir())).not.toThrow();
    for (const op of ["write", "delete"] as const) {
      try {
        enforcePathAcl(a, op, "x.md", tmpdir());
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as ObsidianTcError).code).toBe("read_only_mode");
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// GH #994 second security review, M1: acl_denied's `details.path` is built from the caller's own
// (resolved-but-unscanned) path, thrown BEFORE memoryDefense ever runs — commit_capture's
// `pathAcl: (input) => [{ op: "write", path: input.target_path }]` feeds `input.target_path`
// straight into enforceCentralPathAcl -> enforcePathAcl, which denies-and-throws on the raw value.
// A secret-shaped target_path that also happens to land outside the ACL (the default-denied
// .obsidian/.git/.trash set, or a configured whitelist miss) leaks that secret through the error
// envelope every caller of this function shares. Fixed at the shared `enforcePathAcl` layer, not
// per tool, so every one of the ~120 handler-side call sites benefits along with the central
// dispatch stage. Built at runtime (never a literal) so the corpus/secret-scanners in this repo's
// own CI never flag the test file itself.
// ---------------------------------------------------------------------------------------------

function fakeGithubTokenForAclTest(): string {
  const body = Array.from(
    { length: 36 },
    (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[i % 36],
  ).join("");
  return `gh${"p"}_${body}`;
}

describe("enforcePathAcl never echoes a secret-shaped raw path (GH #994 M1)", () => {
  it("a default-denied path (.obsidian/**) redacts the secret out of acl_denied's details.path", () => {
    const token = fakeGithubTokenForAclTest();
    const a = acl();
    let caught: unknown;
    try {
      enforcePathAcl(a, "write", `.obsidian/${token}.md`, tmpdir());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObsidianTcError);
    const e = caught as ObsidianTcError;
    expect(e.code).toBe("acl_denied");
    expect(JSON.stringify(e.toJSON())).not.toContain(token);
    expect(String(e.details?.path)).not.toContain(token);
  });

  it("a write-whitelist miss redacts the secret out of acl_denied's details.path", () => {
    const token = fakeGithubTokenForAclTest();
    const a = acl({ writePaths: ["notes/**"] });
    let caught: unknown;
    try {
      enforcePathAcl(a, "write", `secret/${token}.md`, tmpdir());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObsidianTcError);
    const e = caught as ObsidianTcError;
    expect(e.code).toBe("acl_denied");
    expect(JSON.stringify(e.toJSON())).not.toContain(token);
    expect(String(e.details?.path)).not.toContain(token);
  });

  it("a scope-denial (grantedScopes) redacts the secret out of acl_denied's details.path", () => {
    const a = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [{ glob: "**", scopes: ["write:secret-scope"] }],
    });
    const token = fakeGithubTokenForAclTest();
    let caught: unknown;
    try {
      enforcePathAcl(a, "write", `${token}.md`, tmpdir(), []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObsidianTcError);
    const e = caught as ObsidianTcError;
    expect(e.code).toBe("acl_denied");
    expect(JSON.stringify(e.toJSON())).not.toContain(token);
    expect(String(e.details?.path)).not.toContain(token);
  });
});

describe("FolderAcl.scopesForPath is last-match-wins", () => {
  it("the last matching rule overrides earlier ones", () => {
    const a = new FolderAcl({
      readOnly: false,
      defaultScopes: ["read:notes"],
      rules: [
        { glob: "**", scopes: ["read:notes", "write:notes"] },
        { glob: "vault/secret/**", scopes: ["read:notes"] },
      ],
    });
    expect(a.scopesForPath("vault/public/a.md")).toEqual(["read:notes", "write:notes"]);
    expect(a.scopesForPath("vault/secret/b.md")).toEqual(["read:notes"]);
    expect(a.scopesForPath("outside.md")).toEqual(["read:notes", "write:notes"]);
  });
});
