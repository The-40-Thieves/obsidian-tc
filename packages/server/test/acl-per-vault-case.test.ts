// Per-vault filesystem case sensitivity for the folder ACL. RED on pre-fix main:
// `CASE_INSENSITIVE_FS` (acl.ts) is a per-PROCESS platform constant, so a vault whose
// filesystem's case behavior differs from the platform default is matched wrong:
//   - macOS on a case-sensitive APFS volume fails OPEN (platform says darwin => fold): a
//     readPaths:["Notes/*"] whitelist lets NOTES/private.md through, and a PUBLIC/ folder
//     escapes a "** needs read:secret" rule.
//   - a case-insensitive mount on Linux (WSL drvfs, exFAT, SMB, ext4 casefold) fails OPEN the
//     other way (platform says linux => no fold): SECRET/x.md needs no scope under a Secret/**
//     rule and RAW/x.md is not immutable under the raw/** immutable glob, even though on such a
//     mount they ARE those files.
// The fix detects case sensitivity per vault root at ACL build (vaults[].caseSensitive
// overrides), compiles each vault's FolderAcl with it, reports it per vault (caseByVault ->
// doctor), and carries it in the ACL fingerprint. The platform default and the detector are
// injectable so both directions are exercised on any host.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { describe, expect, it } from "vitest";
import { type AclConfigT, aclFingerprint, CASE_INSENSITIVE_FS, FolderAcl } from "../src/acl";
import { applyEnvOverlays } from "../src/config/load";
import { buildAcls } from "../src/runtime/acl-build";
import { VaultRegistry } from "../src/vault/registry";
import { makeTempDir, rmTemp } from "./tmp";

const OPEN: AclConfigT = { readOnly: false, defaultScopes: [], rules: [] };

/** Independent probe of the temp filesystem, so the case-2 test runs only where a temp dir is
 *  genuinely case-insensitive (this Windows box's NTFS; skipped on Linux CI's case-sensitive /tmp). */
function tempFsIsCaseInsensitive(): boolean | null {
  const dir = makeTempDir("obtc-case-probe-");
  try {
    const probe = join(dir, `CaSe-PrObE-${process.pid}`);
    writeFileSync(probe, "");
    try {
      statSync(join(dir, `cAsE-pRoBe-${process.pid}`));
      return true;
    } catch {
      return false;
    }
  } catch {
    return null;
  } finally {
    rmTemp(dir);
  }
}
const TEMP_CI = tempFsIsCaseInsensitive();

describe("case-sensitive volume under a case-insensitive platform default (case-sensitive APFS on macOS)", () => {
  // Simulated darwin: platformCaseInsensitive forces the platform default to "fold", while the
  // injected detector reports the truth about this vault's volume: case-SENSITIVE.
  const darwinOnSensitiveFs = {
    platformCaseInsensitive: true,
    detectCase: () => false as boolean | null,
  };

  it("a case-variant path does NOT satisfy the read whitelist", () => {
    const root = makeTempDir("obtc-case1-");
    try {
      const { aclByVault } = buildAcls(
        OPEN,
        [
          {
            id: "v",
            path: root,
            acl: { ...OPEN, readPaths: ["Notes/*"] },
          },
        ],
        darwinOnSensitiveFs,
      );
      const acl = aclByVault.get("v");
      expect(acl).toBeDefined();
      // RED: pre-fix the platform constant folds, so NOTES/private.md wrongly matches Notes/*.
      expect(acl?.matchedPathGlob("read", "NOTES/private.md")).toBeNull();
      expect(acl?.matchedPathGlob("read", "Notes/private.md")).toBe("Notes/*");
    } finally {
      rmTemp(root);
    }
  });

  it("a case-variant folder does NOT escape a rule's scope requirement", () => {
    const root = makeTempDir("obtc-case1-");
    try {
      const { aclByVault } = buildAcls(
        OPEN,
        [
          {
            id: "v",
            path: root,
            acl: {
              ...OPEN,
              rules: [
                { glob: "**", scopes: ["read:secret"] },
                { glob: "public/**", scopes: [] },
              ],
            },
          },
        ],
        darwinOnSensitiveFs,
      );
      const acl = aclByVault.get("v");
      // RED: pre-fix PUBLIC/x.md folds onto public/** and needs NO scope; on a case-sensitive
      // volume PUBLIC/ is not public/, so the catch-all rule's scope must apply.
      expect(acl?.scopesForPath("PUBLIC/x.md")).toEqual(["read:secret"]);
      expect(acl?.scopesForPath("public/x.md")).toEqual([]);
    } finally {
      rmTemp(root);
    }
  });

  it("the detected value is reported per vault, with its source", () => {
    const root = makeTempDir("obtc-case1-");
    try {
      const { caseByVault } = buildAcls(OPEN, [{ id: "v", path: root }], darwinOnSensitiveFs);
      expect(caseByVault.get("v")).toEqual({
        configured: "auto",
        detected: false,
        caseInsensitive: false,
        match: { allow: false, rules: false },
      });
    } finally {
      rmTemp(root);
    }
  });
});

describe("case-insensitive mount under a case-sensitive platform default (WSL drvfs / exFAT / SMB on Linux)", () => {
  // Simulated linux: the platform default says "no fold", but the REAL probe of this vault's
  // temp dir answers for the mount. Runs only where the temp filesystem truly is
  // case-insensitive (NTFS here); on a case-sensitive host the sensitive behavior is correct
  // and the darwin-on-sensitive-FS suite above covers the matching.
  it.skipIf(TEMP_CI !== true)(
    "a case-variant path carries its rule's scope and the raw folder stays immutable",
    () => {
      const root = makeTempDir("obtc-case2-");
      try {
        const { aclByVault, caseByVault } = buildAcls(
          OPEN,
          [
            {
              id: "v",
              path: root,
              wiki: { folder: "wiki", rawFolder: "raw" },
              acl: { ...OPEN, rules: [{ glob: "Secret/**", scopes: ["read:secret"] }] },
            },
          ],
          { platformCaseInsensitive: false },
        );
        const acl = aclByVault.get("v");
        expect(acl).toBeDefined();
        // RED pre-fix on Linux: platform says case-sensitive, so SECRET/x.md matches no rule and
        // RAW/x.md no immutable glob — on a case-insensitive mount both ARE the gated files.
        expect(acl?.scopesForPath("SECRET/x.md")).toEqual(["read:secret"]);
        expect(acl?.immutableGlobFor("RAW/x.md")).not.toBeNull();
        expect(caseByVault.get("v")?.detected).toBe(true);
        expect(caseByVault.get("v")?.match).toEqual({ allow: true, rules: true });
      } finally {
        rmTemp(root);
      }
    },
  );
});

describe("fail-closed when detection fails", () => {
  it("whitelists match case-sensitively while rule scopes and immutable globs fold", () => {
    const root = makeTempDir("obtc-case3-");
    try {
      const { aclByVault, caseByVault } = buildAcls(
        OPEN,
        [
          {
            id: "v",
            path: root,
            wiki: { folder: "wiki", rawFolder: "raw" },
            acl: {
              ...OPEN,
              readPaths: ["Notes/**"],
              rules: [{ glob: "Secret/**", scopes: ["read:secret"] }],
            },
          },
        ],
        { platformCaseInsensitive: false, detectCase: () => null },
      );
      const acl = aclByVault.get("v");
      // The one posture a wrong guess cannot bypass: the allow side can only UNDER-match (deny a
      // legitimate path), the scope/immutable side can only OVER-apply (demand a scope, refuse a
      // write, on a path that did not need it).
      expect(caseByVault.get("v")?.detected).toBeNull();
      expect(caseByVault.get("v")?.match).toEqual({ allow: false, rules: true });
      expect(acl?.matchedPathGlob("read", "NOTES/x.md")).toBeNull();
      expect(acl?.scopesForPath("SECRET/x.md")).toEqual(["read:secret"]);
      expect(acl?.immutableGlobFor("RAW/x.md")).not.toBeNull();
    } finally {
      rmTemp(root);
    }
  });
});

describe("the ACL fingerprint carries the vault's case behavior", () => {
  it("same config, different case behavior => different fingerprint", () => {
    const sensitive = new FolderAcl({ ...OPEN, caseMatch: { allow: false, rules: false } });
    const insensitive = new FolderAcl({ ...OPEN, caseMatch: { allow: true, rules: true } });
    // RED: pre-fix aclFingerprint ignores the case behavior, so persisted acl_path_sets rows and
    // prewarm files computed under one would be served under the other.
    expect(sensitive.fingerprint(["read:notes"])).not.toBe(insensitive.fingerprint(["read:notes"]));
    // The explicit side must differ from the platform default, or the comparison is vacuous:
    // on a case-SENSITIVE platform { allow: false, rules: false } IS the absent-caseMatch value.
    const nonDefault = !CASE_INSENSITIVE_FS;
    expect(
      aclFingerprint({ ...OPEN, caseMatch: { allow: nonDefault, rules: nonDefault } }, ["s"]),
    ).not.toBe(aclFingerprint(OPEN, ["s"]));
  });
});

describe("RELIQUARY_TC_VAULT_CASE_SENSITIVE env overlay", () => {
  it("wins over the config value for the one vault; refuses several vaults and junk", () => {
    const raw = { vaults: [{ id: "main", path: "E:/tmp/vault", caseSensitive: false }] };
    const overlaid = applyEnvOverlays(structuredClone(raw), {
      RELIQUARY_TC_VAULT_CASE_SENSITIVE: "true",
    });
    expect(VaultConfigSchema.parse((overlaid.vaults as unknown[])[0]).caseSensitive).toBe(true);
    expect(() =>
      applyEnvOverlays(
        {
          vaults: [
            { id: "a", path: "x" },
            { id: "b", path: "y" },
          ],
        },
        { RELIQUARY_TC_VAULT_CASE_SENSITIVE: "true" },
      ),
    ).toThrow(/cannot pick one of 2/);
    expect(() =>
      applyEnvOverlays(
        { vaults: [{ id: "main", path: "x" }] },
        { RELIQUARY_TC_VAULT_CASE_SENSITIVE: "maybe" },
      ),
    ).toThrow(/auto, true or false/);
  });
});

describe("vaults[].caseSensitive config override", () => {
  it('parses "auto", true and false; rejects anything else', () => {
    const base = { id: "v", path: "/tmp/v" };
    expect(VaultConfigSchema.parse(base).caseSensitive).toBeUndefined();
    expect(VaultConfigSchema.parse({ ...base, caseSensitive: "auto" }).caseSensitive).toBe("auto");
    expect(VaultConfigSchema.parse({ ...base, caseSensitive: true }).caseSensitive).toBe(true);
    expect(VaultConfigSchema.parse({ ...base, caseSensitive: false }).caseSensitive).toBe(false);
    expect(() => VaultConfigSchema.parse({ ...base, caseSensitive: "sometimes" })).toThrow();
  });

  it("wins over detection and lands on the resolved vault", () => {
    const root = makeTempDir("obtc-case4-");
    try {
      const registry = new VaultRegistry([
        { id: "forced", path: root, caseSensitive: true },
        { id: "auto", path: root },
      ]);
      // RED: ResolvedVault carries no case sensitivity at all pre-fix.
      expect(registry.resolve("forced").caseInsensitive).toBe(false);
      expect(registry.resolve("auto").caseInsensitive).toBe(TEMP_CI);
    } finally {
      rmTemp(root);
    }
  });

  it("compiles the vault's FolderAcl with the override", () => {
    const root = makeTempDir("obtc-case4-");
    try {
      mkdirSync(join(root, "Notes"));
      writeFileSync(join(root, "Notes", "x.md"), "");
      const { aclByVault, caseByVault } = buildAcls(
        OPEN,
        [
          {
            id: "v",
            path: root,
            caseSensitive: false,
            acl: { ...OPEN, readPaths: ["Notes/**"] },
          },
        ],
        { platformCaseInsensitive: false, detectCase: () => false },
      );
      expect(caseByVault.get("v")?.configured).toBe(false);
      expect(caseByVault.get("v")?.match).toEqual({ allow: true, rules: true });
      // The override sets the vault-level fact; a case-only match is still settled by the
      // directories themselves, so it holds only where the folder really folds.
      expect(aclByVault.get("v")?.matchedPathGlob("read", "NOTES/x.md")).toBe(
        TEMP_CI ? "Notes/**" : null,
      );
    } finally {
      rmTemp(root);
    }
  });
});
