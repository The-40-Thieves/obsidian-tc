import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import {
  bridgeItemPath,
  filterBridgeItemsByAcl,
  readEnumerationUnrestricted,
} from "../src/vault/acl-read-filter";

const acl = (over: Partial<AclConfigT>): FolderAcl =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });

describe("acl-read-filter (D2)", () => {
  it("readEnumerationUnrestricted reflects acl / readPaths / strictReadDefault", () => {
    expect(readEnumerationUnrestricted(undefined)).toBe(true);
    expect(readEnumerationUnrestricted(acl({}))).toBe(true);
    expect(readEnumerationUnrestricted(acl({ strictReadDefault: true }))).toBe(false);
    expect(readEnumerationUnrestricted(acl({ readPaths: ["X/**"] }))).toBe(false);
  });

  it("keeps in-whitelist items and drops the rest", () => {
    const a = acl({ readPaths: ["Notes/**"] });
    const items = [{ path: "Notes/a.md" }, { path: "Secret/s.md" }];
    expect(filterBridgeItemsByAcl(a, items, { tool: "t" })).toEqual([{ path: "Notes/a.md" }]);
  });

  it("fails closed on an unattributable item when readPaths is defined", () => {
    const a = acl({ readPaths: ["Notes/**"] });
    expect(() => filterBridgeItemsByAcl(a, [{ line: 1 }], { tool: "t" })).toThrow();
  });

  it("returns items unchanged when readPaths undefined and strict off", () => {
    const items = [{ path: "Secret/s.md" }];
    expect(filterBridgeItemsByAcl(acl({}), items, { tool: "t" })).toEqual(items);
  });

  it("strictReadDefault forces attribution even with readPaths undefined", () => {
    const a = acl({ strictReadDefault: true });
    expect(() => filterBridgeItemsByAcl(a, [{ line: 1 }], { tool: "t" })).toThrow();
    expect(filterBridgeItemsByAcl(a, [{ path: "Any/x.md" }], { tool: "t" })).toEqual([
      { path: "Any/x.md" },
    ]);
  });

  it("bridgeItemPath extracts the first present key and rejects bad paths", () => {
    expect(bridgeItemPath({ note_path: "A.md", path: "B.md" }, ["note_path", "path"])).toBe("A.md");
    expect(bridgeItemPath({})).toBeUndefined();
    expect(bridgeItemPath("nope")).toBeUndefined();
    expect(bridgeItemPath({ path: "../escape.md" })).toBeUndefined();
  });
});
