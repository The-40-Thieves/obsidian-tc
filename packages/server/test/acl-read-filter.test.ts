import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { enforcePathAcl, evaluatePathAcl, pathScopesSatisfied } from "../src/vault/acl-path";
import {
  bridgeItemPath,
  filterBridgeItemsByAcl,
  readableByFolder,
  readableRel,
  readEnumerationUnrestricted,
} from "../src/vault/acl-read-filter";

const acl = (over: Partial<AclConfigT>): FolderAcl =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });

describe("acl-read-filter (D2)", () => {
  it("readEnumerationUnrestricted reflects acl / readPaths / strictReadDefault", () => {
    expect(readEnumerationUnrestricted(undefined, [])).toBe(true);
    expect(readEnumerationUnrestricted(acl({}), [])).toBe(true);
    expect(readEnumerationUnrestricted(acl({ strictReadDefault: true }), [])).toBe(false);
    expect(readEnumerationUnrestricted(acl({ readPaths: ["X/**"] }), [])).toBe(false);
  });

  it("keeps in-whitelist items and drops the rest", () => {
    const a = acl({ readPaths: ["Notes/**"] });
    const items = [{ path: "Notes/a.md" }, { path: "Secret/s.md" }];
    expect(filterBridgeItemsByAcl(a, [], items, { tool: "t" })).toEqual([{ path: "Notes/a.md" }]);
  });

  it("fails closed on an unattributable item when readPaths is defined", () => {
    const a = acl({ readPaths: ["Notes/**"] });
    expect(() => filterBridgeItemsByAcl(a, [], [{ line: 1 }], { tool: "t" })).toThrow();
  });

  it("returns items unchanged when readPaths undefined and strict off", () => {
    const items = [{ path: "Secret/s.md" }];
    expect(filterBridgeItemsByAcl(acl({}), [], items, { tool: "t" })).toEqual(items);
  });

  it("strictReadDefault fails reads closed (deny non-whitelisted, require attribution) with readPaths undefined", () => {
    const a = acl({ strictReadDefault: true });
    expect(() => filterBridgeItemsByAcl(a, [], [{ line: 1 }], { tool: "t" })).toThrow();
    expect(filterBridgeItemsByAcl(a, [], [{ path: "Any/x.md" }], { tool: "t" })).toEqual([]); // THE-268: strict now denies non-whitelisted reads too (fail-closed)
  });

  it("bridgeItemPath extracts the first present key and rejects bad paths", () => {
    expect(bridgeItemPath({ note_path: "A.md", path: "B.md" }, ["note_path", "path"])).toBe("A.md");
    expect(bridgeItemPath({})).toBeUndefined();
    expect(bridgeItemPath("nope")).toBeUndefined();
    expect(bridgeItemPath({ path: "../escape.md" })).toBeUndefined();
    // a bad value for an earlier key falls through to a later valid key
    expect(
      bridgeItemPath({ path: "../escape.md", note_path: "Notes/ok.md" }, ["path", "note_path"]),
    ).toBe("Notes/ok.md");
  });
});

// The read predicate every search / enumeration surface filters with. It must decide exactly what
// read_note / read_notes decide (enforcePathAcl "read" with the caller's scopes) or a result can
// name a note the read path refuses.
describe("readableRel: rule-scopes and parity with enforcePathAcl", () => {
  const ruled = acl({ rules: [{ glob: "secret/**", scopes: ["read:secret"] }] });

  it("denies a rule-scoped path to a caller lacking the scope, allows it with the scope", () => {
    expect(readableRel(ruled, "secret/b.md", ["read:notes"])).toBe(false);
    expect(readableRel(ruled, "secret/b.md", ["read:notes", "read:secret"])).toBe(true);
    expect(readableRel(ruled, "pub/a.md", ["read:notes"])).toBe(true);
  });

  it("honors the wildcard grants pathScopesSatisfied honors", () => {
    expect(readableRel(ruled, "secret/b.md", ["*"])).toBe(true);
    expect(readableRel(ruled, "secret/b.md", ["read:*"])).toBe(true);
  });

  it("requires ALL of a rule's scopes, and last-match-wins can lift a nested requirement", () => {
    const a = acl({
      rules: [
        { glob: "secret/**", scopes: ["read:secret", "read:finance"] },
        { glob: "secret/public/**", scopes: [] },
      ],
    });
    expect(readableRel(a, "secret/x.md", ["read:secret"])).toBe(false);
    expect(readableRel(a, "secret/x.md", ["read:secret", "read:finance"])).toBe(true);
    expect(readableRel(a, "secret/public/x.md", [])).toBe(true);
  });

  it("defaultScopes gate paths no rule matches", () => {
    const a = acl({ defaultScopes: ["read:notes"] });
    expect(readableRel(a, "any.md", [])).toBe(false);
    expect(readableRel(a, "any.md", ["read:notes"])).toBe(true);
  });

  it("scope and whitelist are independent: both must pass", () => {
    const a = acl({
      readPaths: ["secret/**", "pub/**"],
      rules: [{ glob: "secret/**", scopes: ["read:secret"] }],
    });
    expect(readableRel(a, "secret/b.md", [])).toBe(false);
    expect(readableRel(a, "secret/b.md", ["read:secret"])).toBe(true);
    expect(readableRel(a, "open/c.md", ["read:secret"])).toBe(false);
  });

  it("accepts any iterable of scopes, not only a Set", () => {
    expect(readableRel(ruled, "secret/b.md", new Set(["read:secret"]))).toBe(true);
    expect(readableRel(ruled, "secret/b.md", ["read:secret"][Symbol.iterator]())).toBe(true);
  });

  it("agrees with enforcePathAcl(read, scopes) on every path x scope-set x ACL shape", () => {
    const shapes = [
      acl({}),
      ruled,
      acl({ strictReadDefault: true }),
      acl({
        readPaths: ["pub/**", "secret/**"],
        rules: [{ glob: "secret/**", scopes: ["read:secret"] }],
      }),
      acl({
        defaultScopes: ["read:notes"],
        rules: [{ glob: "secret/**", scopes: ["read:secret", "read:notes"] }],
      }),
    ];
    const paths = ["pub/a.md", "secret/b.md", "open/c.md", ".obsidian/app.json", ".git/config"];
    const root = mkdtempSync(join(tmpdir(), "obtc-readable-"));
    const scopeSets = [[], ["read:notes"], ["read:secret"], ["read:notes", "read:secret"], ["*"]];
    for (const a of shapes)
      for (const p of paths)
        for (const scopes of scopeSets) {
          let allowed = true;
          try {
            enforcePathAcl(a, "read", p, root, scopes);
          } catch {
            allowed = false;
          }
          expect(readableRel(a, p, scopes), `${p} scopes=${scopes.join(",")}`).toBe(allowed);
          expect(
            evaluatePathAcl(a, "read", p).allowed && pathScopesSatisfied(a, p, scopes),
            `evaluate+scopes ${p}`,
          ).toBe(allowed);
        }
  });

  it("readableByFolder is the scope-free half: folder whitelist only", () => {
    expect(readableByFolder(ruled, "secret/b.md")).toBe(true);
    expect(readableByFolder(acl({ readPaths: ["pub/**"] }), "secret/b.md")).toBe(false);
    expect(readableByFolder(ruled, ".obsidian/app.json")).toBe(false);
  });

  it("readEnumerationUnrestricted is false for a caller lacking a declared scope", () => {
    expect(readEnumerationUnrestricted(ruled, [])).toBe(false);
    expect(readEnumerationUnrestricted(ruled, ["read:secret"])).toBe(true);
    expect(readEnumerationUnrestricted(ruled, ["*"])).toBe(true);
    // no rule-scopes declared anywhere: unchanged from before.
    expect(readEnumerationUnrestricted(acl({}), [])).toBe(true);
  });

  it("filterBridgeItemsByAcl drops a rule-scoped item for a caller lacking the scope", () => {
    const items = [{ path: "pub/a.md" }, { path: "secret/b.md" }];
    expect(() => filterBridgeItemsByAcl(ruled, [], items, { tool: "t" })).not.toThrow();
    expect(filterBridgeItemsByAcl(ruled, [], items, { tool: "t" })).toEqual([{ path: "pub/a.md" }]);
    expect(filterBridgeItemsByAcl(ruled, ["read:secret"], items, { tool: "t" })).toEqual(items);
  });
});
