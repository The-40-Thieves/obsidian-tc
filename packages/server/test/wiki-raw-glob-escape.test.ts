// A raw folder is configured by NAME, and a folder name may hold `*`, `?`, `[` or a backslash. Built
// into an immutable glob unescaped, `my*raw` would lock every `myXraw` too (and `my?raw`, `my[a]raw`
// would stop locking themselves). The immutable globs must match the literal folder and only it.
import { describe, expect, it } from "vitest";
import { escapeGlob, globMatch } from "../src/acl";
import { buildAcls } from "../src/runtime/acl-build";
import { evaluatePathAcl } from "../src/vault/acl-path";
import { immutableGlobsFor } from "../src/vault/raw-folder";

const CFG = { readOnly: false, defaultScopes: [], rules: [] };
const NAMES = ["my*raw", "my?raw", "my[a]raw", "a**b", "[x]", "*", "q?"];
// A backslash cannot be in a folder name (vault paths use `/` and normalise `\`), but a glob built from
// one must still be literal.

const writable = (name: string, rel: string): boolean => {
  const acl = buildAcls(CFG, [
    { id: "v", wiki: { folder: "wiki", rawFolder: name } },
  ]).aclByVault.get("v");
  return evaluatePathAcl(acl, "write", rel).allowed;
};

describe("immutable globs are literal", () => {
  for (const name of NAMES) {
    it(`${JSON.stringify(name)}: itself and everything under it is immutable`, () => {
      expect(writable(name, name)).toBe(false);
      expect(writable(name, `${name}/a.md`)).toBe(false);
      expect(writable(name, `${name}/deep/er/a.md`)).toBe(false);
    });
  }

  it("a name with * does not lock its wildcard matches", () => {
    expect(writable("my*raw", "myXraw/a.md")).toBe(true);
    expect(writable("my*raw", "myraw/a.md")).toBe(true);
    expect(writable("my*raw", "my/raw/a.md")).toBe(true);
  });

  it("a name with ? does not lock its single-character matches", () => {
    expect(writable("my?raw", "myXraw/a.md")).toBe(true);
  });

  it("a name with [ is the literal bracketed text, not a class", () => {
    expect(writable("my[a]raw", "myaraw/a.md")).toBe(true);
  });

  it("a backslash in a name is itself escaped, never an escape", () => {
    expect(globMatch(escapeGlob("my\\raw"), "my\\raw")).toBe(true);
    expect(globMatch(escapeGlob("my\\raw"), "myraw")).toBe(false);
  });

  it("a name with ** does not cross a separator", () => {
    expect(writable("a**b", "aXb/c.md")).toBe(true);
    expect(writable("a**b", "a/x/b/c.md")).toBe(true);
  });

  it("escapeGlob round-trips through globMatch for every name", () => {
    for (const name of NAMES) {
      expect(globMatch(escapeGlob(name), name)).toBe(true);
      expect(globMatch(`${escapeGlob(name)}/**`, `${name}/x/y.md`)).toBe(true);
    }
    expect(immutableGlobsFor("my*raw")).toEqual(["my\\*raw", "my\\*raw/**"]);
  });

  it("an unescaped glob still means a glob (user ACL globs are unchanged)", () => {
    expect(globMatch("notes/*", "notes/a.md")).toBe(true);
    expect(globMatch("notes/**", "notes/a/b.md")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
  });
});
