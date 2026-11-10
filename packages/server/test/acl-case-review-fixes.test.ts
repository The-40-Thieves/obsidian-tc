// Review follow-ups on per-vault case sensitivity. The root probe answers for one directory, but
// NTFS and ext4 casefold set case behavior per directory, and an unprobeable root has no answer at
// all. Wherever case-sensitive and case-insensitive matching disagree on a path, the decision now
// comes from how that path's own directories treat case, and from the restrictive side when they
// are mixed or cannot be probed.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AclConfigT, CASE_INSENSITIVE_FS, FolderAcl } from "../src/acl";
import { buildAcls } from "../src/runtime/acl-build";
import { buildLinkMap } from "../src/tools/m7/knowledge/wiki-link-map";
import { pathCaseFolding } from "../src/vault/case-sensitivity";
import { VaultRegistry } from "../src/vault/registry";
import { makeTempDir, rmTemp } from "./tmp";

const OPEN: AclConfigT = { readOnly: false, defaultScopes: [], rules: [] };
const EXEMPT_PUBLIC: AclConfigT = {
  ...OPEN,
  rules: [
    { glob: "**", scopes: ["read:secret"] },
    { glob: "public/**", scopes: [] },
  ],
};

function tempFsIsCaseInsensitive(): boolean {
  const dir = makeTempDir("obtc-case-review-probe-");
  try {
    writeFileSync(join(dir, "CaSe-PrObE"), "");
    try {
      statSync(join(dir, "cAsE-pRoBe"));
      return true;
    } catch {
      return false;
    }
  } finally {
    rmTemp(dir);
  }
}
const TEMP_CI = tempFsIsCaseInsensitive();

function withRoot(fn: (root: string) => void): void {
  const root = makeTempDir("obtc-case-review-");
  try {
    fn(root);
  } finally {
    rmTemp(root);
  }
}

describe("rule scopes never drop a requirement on a case-only match", () => {
  it("unknown case behavior: a case-insensitive-only exemption keeps the catch-all scope", () => {
    withRoot((root) => {
      const { aclByVault } = buildAcls(OPEN, [{ id: "v", path: root, acl: EXEMPT_PUBLIC }], {
        platformCaseInsensitive: false,
        detectCase: () => null,
      });
      const acl = aclByVault.get("v");
      expect(acl?.scopesForPath("Public/secret.md")).toEqual(["read:secret"]);
      expect(acl?.scopesForPath("public/secret.md")).toEqual([]);
    });
  });

  it("an ACL compiled with the unknown split and no filesystem keeps the union", () => {
    const acl = new FolderAcl({ ...EXEMPT_PUBLIC, caseMatch: { allow: false, rules: true } });
    expect(acl.scopesForPath("Public/secret.md")).toEqual(["read:secret"]);
  });

  it("the filesystem decides when the folder exists: exempt only where it folds", () => {
    withRoot((root) => {
      mkdirSync(join(root, "public"));
      writeFileSync(join(root, "public", "secret.md"), "");
      const { aclByVault } = buildAcls(OPEN, [{ id: "v", path: root, acl: EXEMPT_PUBLIC }], {
        detectCase: () => null,
      });
      expect(aclByVault.get("v")?.scopesForPath("Public/secret.md")).toEqual(
        TEMP_CI ? [] : ["read:secret"],
      );
    });
  });
});

describe("allow-lists accept a case-only match only where the path's directories fold", () => {
  const cfg: AclConfigT = { ...OPEN, readPaths: ["Notes/private/**"] };

  it("a case-sensitive folder under a case-insensitive root stays distinct", () => {
    // The vault root folds, but Notes/ is case-sensitive: Notes/Private/ is its own folder.
    const acl = new FolderAcl({ ...cfg, caseMatch: { allow: true, rules: true } }, undefined, {
      caseFolding: () => null,
    });
    expect(acl.matchedPathGlob("read", "Notes/Private/secret.md")).toBeNull();
    expect(acl.matchedPathGlob("read", "Notes/private/secret.md")).toBe("Notes/private/**");
  });

  it("a path whose directories all fold reaches the allowed file", () => {
    const acl = new FolderAcl({ ...cfg, caseMatch: { allow: false, rules: true } }, undefined, {
      caseFolding: () => true,
    });
    expect(acl.matchedPathGlob("read", "NOTES/Private/secret.md")).toBe("Notes/private/**");
  });

  it("rule scopes follow the directories too", () => {
    const folding = (answer: boolean | null) =>
      new FolderAcl(EXEMPT_PUBLIC, undefined, { caseFolding: () => answer });
    expect(folding(true).scopesForPath("Public/x.md")).toEqual([]);
    expect(folding(false).scopesForPath("Public/x.md")).toEqual(["read:secret"]);
    expect(folding(null).scopesForPath("Public/x.md")).toEqual(["read:secret"]);
  });

  it("through buildAcls on the real filesystem, whatever the root probe claimed", () => {
    withRoot((root) => {
      mkdirSync(join(root, "Notes", "private"), { recursive: true });
      writeFileSync(join(root, "Notes", "private", "a.md"), "");
      const { aclByVault } = buildAcls(OPEN, [{ id: "v", path: root, acl: cfg }], {
        detectCase: () => true,
      });
      expect(aclByVault.get("v")?.matchedPathGlob("read", "NOTES/Private/a.md")).toBe(
        TEMP_CI ? "Notes/private/**" : null,
      );
    });
  });
});

describe("immutable globs", () => {
  it("a case-only match is immutable when the filesystem cannot be asked", () => {
    const acl = new FolderAcl({
      ...OPEN,
      immutablePaths: ["raw/**"],
      caseMatch: { allow: false, rules: false },
    });
    expect(acl.immutableGlobFor("RAW/x.md")).toBe("raw/**");
  });
});

describe("pathCaseFolding", () => {
  it("asks each directory the path passes through", () => {
    withRoot((root) => {
      mkdirSync(join(root, "Notes"));
      writeFileSync(join(root, "Notes", "Page.md"), "");
      expect(pathCaseFolding(root, "Notes/Page.md")).toBe(TEMP_CI);
      // A new file in an existing folder: that folder's behavior decides.
      expect(pathCaseFolding(root, "Notes/New.md")).toBe(TEMP_CI);
      // Folders that do not exist yet have no behavior to report.
      expect(pathCaseFolding(root, "Notes/New/Thing.md")).toBeNull();
      expect(pathCaseFolding(root, "../outside.md")).toBeNull();
    });
  });

  it("an empty root it cannot probe is unknown", () => {
    withRoot((root) => {
      expect(pathCaseFolding(root, "Secret/x.md")).toBeNull();
    });
  });
});

describe("vaults[].caseSensitive means what it says", () => {
  it("true is case-sensitive, false folds", () => {
    withRoot((root) => {
      const { caseByVault } = buildAcls(
        OPEN,
        [
          { id: "sensitive", path: root, caseSensitive: true },
          { id: "folding", path: root, caseSensitive: false },
        ],
        { detectCase: () => null },
      );
      expect(caseByVault.get("sensitive")?.caseInsensitive).toBe(false);
      expect(caseByVault.get("sensitive")?.match).toEqual({ allow: false, rules: false });
      expect(caseByVault.get("folding")?.caseInsensitive).toBe(true);
      const registry = new VaultRegistry([{ id: "s", path: root, caseSensitive: true }]);
      expect(registry.resolve("s").caseInsensitive).toBe(false);
    });
  });
});

describe("link map related_wiki_page", () => {
  it("classifies the wiki folder with the vault's case behavior, not the host's", () => {
    const ci = !CASE_INSENSITIVE_FS;
    const map = buildLinkMap({
      ranked: [
        { path: "Wiki/Page.md", evidence: [{ kind: "semantic", score: 0.9 }], excluded: false },
      ],
      scan: { notes: ["Wiki/Page.md"], mentions: [], linkers: [] },
      sources: [],
      wikiFolder: "wiki",
      caseInsensitive: ci,
      isExcluded: () => false,
    });
    expect(map.link_from.some((e) => e.path === "Wiki/Page.md")).toBe(ci);
  });
});
