// The ACL identity is a branded type (vault/acl-identity.ts). A wrapper entry point that decides on
// an identity demands the brand, so a plain string (a display name, a stored path) does not compile
// into it. The @ts-expect-error lines are the RED cases: each one fails the typecheck if the brand is
// ever dropped from its parameter. The runtime half holds the mint to its three producer files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { IndexVaultArgs } from "../src/search/indexing/types";
import { type AclPath, mintAclPath } from "../src/vault/acl-identity";
import type { WalkReadable } from "../src/vault/acl-read-filter";
import {
  type ResolvedVaultPath,
  resolveVaultPathChecked,
  type WalkEntry,
} from "../src/vault/paths";
import type { readableStoredRow } from "../src/vault/stored-acl-path";
import { makeTempDir, rmTemp } from "./tmp";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

// The predicates the brand guards. Each is a real no-op, so the calls in the test run.
const isR: IndexVaultArgs["isReadable"] = () => true;
const decide: Parameters<typeof readableStoredRow>[2] = () => true;
const w: WalkReadable = () => true;

/** The only files that may call the mint, and the only file that may write `as AclPath`. */
const MINT_PRODUCERS = new Set([
  "packages/server/src/vault/paths.ts",
  "packages/server/src/vault/stored-acl-path.ts",
  "packages/server/src/vault/acl-identity.ts",
]);

describe("AclPath brand: the type gate", () => {
  it("wrapper entry points reject a raw string and accept an identity", () => {
    const root = makeTempDir("obtc-acl-brand-");
    try {
      const p: AclPath = mintAclPath("pages/a.md");
      expect(p).toBe("pages/a.md");

      // @ts-expect-error a plain string is not an ACL identity
      const bad: AclPath = "pages/a.md";
      expect(bad).toBeDefined();

      // @ts-expect-error a display name is not handed to isReadable
      isR("wiki/a.md");
      isR(mintAclPath("pages/a.md"));

      // @ts-expect-error a stored path is not an identity
      decide("wiki/a.md");

      // @ts-expect-error the first argument is the display name, the second must be the identity
      w("wiki/a.md", "pages/a.md");
      w("wiki/a.md", resolveVaultPathChecked(root, "pages/a.md").aclRel);

      expectTypeOf<WalkEntry["aclRel"]>().toEqualTypeOf<AclPath>();
      expectTypeOf<ResolvedVaultPath["aclRel"]>().toEqualTypeOf<AclPath>();
    } finally {
      rmTemp(root);
    }
  });
});

describe("AclPath brand: the mint has one set of producers", () => {
  it("mintAclPath( is called only by the identity producers, and `as AclPath` only in acl-identity.ts", () => {
    const files = execFileSync("git", ["ls-files", "packages/server/src/**/*.ts"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    // A scan that finds nothing must fail, not pass: the floors pin its reach.
    expect(files.length).toBeGreaterThanOrEqual(300);

    const mintSites: string[] = [];
    const castSites: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(REPO, f), "utf8");
      const mints = text.match(/\bmintAclPath\(/g)?.length ?? 0;
      for (let i = 0; i < mints; i++) mintSites.push(f);
      if (/\bas AclPath\b/.test(text)) castSites.push(f);
    }

    expect(mintSites.length).toBeGreaterThanOrEqual(3);
    expect(mintSites.filter((f) => !MINT_PRODUCERS.has(f))).toEqual([]);
    expect(castSites.filter((f) => f !== "packages/server/src/vault/acl-identity.ts")).toEqual([]);
  });
});
