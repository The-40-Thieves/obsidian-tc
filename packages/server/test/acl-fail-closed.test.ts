import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { evaluatePathAcl } from "../src/vault/acl-path";
import { readableRel } from "../src/vault/acl-read-filter";

function acl(over: Record<string, unknown> = {}): FolderAcl {
  return new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });
}

describe("THE-268 default-deny + strictReadDefault", () => {
  it("hard-denies .obsidian secrets on read even with no allowlist", () => {
    expect(evaluatePathAcl(acl(), "read", ".obsidian/plugins/p/data.json").allowed).toBe(false);
    expect(readableRel(acl(), ".obsidian/plugins/p/data.json")).toBe(false);
  });

  it("hard-denies .obsidian/.git on write and delete", () => {
    expect(evaluatePathAcl(acl(), "write", ".obsidian/app.json").allowed).toBe(false);
    expect(evaluatePathAcl(acl(), "delete", ".git/config").allowed).toBe(false);
  });

  it("exempts the bookmark/workspace config files", () => {
    expect(evaluatePathAcl(acl(), "read", ".obsidian/bookmarks.json").allowed).toBe(true);
    expect(evaluatePathAcl(acl(), "write", ".obsidian/workspaces.json").allowed).toBe(true);
  });

  it("does not deny .obsidian-tc (session traces live there)", () => {
    expect(evaluatePathAcl(acl(), "write", ".obsidian-tc/traces/s.jsonl").allowed).toBe(true);
  });

  it("still allows ordinary notes by default", () => {
    expect(evaluatePathAcl(acl(), "read", "notes/a.md").allowed).toBe(true);
    expect(readableRel(acl(), "notes/a.md")).toBe(true);
  });

  it("strictReadDefault fails the read path closed when readPaths is undefined", () => {
    const a = acl({ strictReadDefault: true });
    expect(evaluatePathAcl(a, "read", "notes/a.md").allowed).toBe(false);
    expect(readableRel(a, "notes/a.md")).toBe(false);
  });

  it("strictReadDefault does not affect writes", () => {
    const a = acl({ strictReadDefault: true });
    expect(evaluatePathAcl(a, "write", "notes/a.md").allowed).toBe(true);
  });
});
