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
