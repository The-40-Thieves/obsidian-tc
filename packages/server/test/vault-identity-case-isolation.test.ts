// A vault_identity row matched only through the platform-default (lowercased) spelling of a root is
// trusted only when that spelling and the configured root are provably one directory. On a
// case-sensitive filesystem `vault` and `Vault` are two vaults: one must never be re-keyed onto or
// rebound to the other's rows.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/types";
import { resolveAndApplyVaultIdentity } from "../src/vault/identity";
import { canonicalizeVaultRoot } from "../src/vault/registry";
import { makeTempDir, rmTemp } from "./tmp";
import { identityStores, seedIdentity } from "./vault-identity-stores";

// A host whose platform default folds case (macOS, Windows) serving a case-sensitive vault.
vi.mock("../src/acl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/acl")>()),
  CASE_INSENSITIVE_FS: true,
}));
const probe = vi.hoisted(() => ({ folds: false }));
vi.mock("../src/vault/case-sensitivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/vault/case-sensitivity")>()),
  detectFsCaseSensitivity: () => probe.folds,
}));

const sameDir = (a: string, b: string): boolean => {
  const x = statSync(a, { bigint: true });
  const y = statSync(b, { bigint: true });
  return x.dev === y.dev && x.ino === y.ino;
};

/** `<base>/Vault` plus the directory its all-lowercase spelling names, when the two can differ. */
function distinctCaseVariants(fn: (upper: string, lower: string) => void): boolean {
  const base = makeTempDir("obtc-identity-isolation-");
  try {
    if (process.platform === "win32") {
      try {
        execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", base, "enable"], {
          stdio: "ignore",
        });
      } catch {
        // No per-directory case sensitivity here: the variants fold and the case is skipped.
      }
    }
    const upper = join(base, "Vault");
    mkdirSync(upper);
    const root = canonicalizeVaultRoot(upper);
    const lower = root.toLowerCase();
    let created: string | undefined;
    for (let d = lower; !existsSync(d); d = dirname(d)) created = d;
    mkdirSync(lower, { recursive: true });
    try {
      if (sameDir(root, lower)) return false;
      fn(root, lower);
      return true;
    } finally {
      if (created !== undefined) rmSync(created, { recursive: true, force: true });
    }
  } finally {
    rmTemp(base);
  }
}

const rows = (db: Database) =>
  db.prepare("SELECT vault_id, root_realpath FROM vault_identity ORDER BY vault_id").all();

describe("a lowercased root match is not taken on trust", () => {
  it("a different vault whose root lowercases to a recorded one is not a rename", (ctx) => {
    const ran = distinctCaseVariants((upper, lower) => {
      const { cacheDb, edb } = identityStores();
      seedIdentity(cacheDb, "a", lower);
      expect(resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "b", path: upper }])).toEqual([]);
      expect(rows(cacheDb)).toEqual([
        { vault_id: "a", root_realpath: lower },
        { vault_id: "b", root_realpath: upper },
      ]);
    });
    if (!ran) ctx.skip();
  });

  it("an id moved to a case-variant directory is still a collision", (ctx) => {
    const ran = distinctCaseVariants((upper, lower) => {
      const { cacheDb, edb } = identityStores();
      seedIdentity(cacheDb, "a", lower);
      expect(() => resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "a", path: upper }])).toThrow(
        /already recorded against a different path/,
      );
    });
    if (!ran) ctx.skip();
  });
});

// Each root folds case inside itself, but their shared parent does not: `Vault` and `vault` are two
// directories, so folding either root's spelling would make them one identity.
describe("a root that folds inside a case-sensitive parent keeps its own spelling", () => {
  const folding = (fn: (upper: string, lower: string) => void) => () => {
    probe.folds = true;
    try {
      return distinctCaseVariants(fn);
    } finally {
      probe.folds = false;
    }
  };

  it("a second vault at the other spelling is not a rename of the first", (ctx) => {
    const ran = folding((upper, lower) => {
      const { cacheDb, edb } = identityStores();
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "a", path: lower }]);
      expect(resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "b", path: upper }])).toEqual([]);
      expect(rows(cacheDb)).toEqual([
        { vault_id: "a", root_realpath: lower },
        { vault_id: "b", root_realpath: upper },
      ]);
    })();
    if (!ran) ctx.skip();
  });

  it("an id moved to the other spelling is a collision, not the same vault", (ctx) => {
    const ran = folding((upper, lower) => {
      const { cacheDb, edb } = identityStores();
      resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "a", path: lower }]);
      expect(() => resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "a", path: upper }])).toThrow(
        /already recorded against a different path/,
      );
    })();
    if (!ran) ctx.skip();
  });
});
