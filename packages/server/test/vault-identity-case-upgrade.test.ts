// A vault_identity row recorded before per-vault case detection was normalized with the PLATFORM
// default. When the vault's own filesystem folds differently, the same vault normalizes to a
// different string; that is the same vault, so it must upgrade in place instead of colliding.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CASE_INSENSITIVE_FS } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { normalizeRealpathForIdentity, resolveAndApplyVaultIdentity } from "../src/vault/identity";
import { canonicalizeVaultRoot } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

vi.mock("../src/vault/case-sensitivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/case-sensitivity")>();
  // The vault's filesystem folds the OTHER way from the host platform's default.
  return { ...actual, detectFsCaseSensitivity: () => !CASE_INSENSITIVE_FS };
});

const EXPERIENTIAL_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({
  version: versionOf(f),
  sql: readFileSync(fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)), "utf8"),
}));

function stores(): { cacheDb: Database; edb: Database } {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const edb = openMemoryDb();
  runMigrations(edb, EXPERIENTIAL_CHAIN);
  return { cacheDb, edb };
}

function seedLegacy(db: Database, id: string, root: string): void {
  db.prepare(
    "INSERT INTO vault_identity (vault_id, root_realpath, root_canonical, created_at, updated_at) VALUES (?, ?, 1, 0, 0)",
  ).run(id, normalizeRealpathForIdentity(root, CASE_INSENSITIVE_FS));
}

const recorded = (db: Database): { vault_id: string; root_realpath: string }[] =>
  db.prepare("SELECT vault_id, root_realpath FROM vault_identity").all() as {
    vault_id: string;
    root_realpath: string;
  }[];

describe("vault identity rows recorded under the platform-default normalization", () => {
  it("the same id and path upgrades in place instead of refusing the boot", () => {
    const dir = makeTempDir("Vault-Identity-Case-");
    try {
      const root = canonicalizeVaultRoot(dir);
      const { cacheDb, edb } = stores();
      seedLegacy(cacheDb, "main", root);
      expect(resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "main", path: root }])).toEqual([]);
      expect(recorded(cacheDb)).toEqual([
        {
          vault_id: "main",
          root_realpath: normalizeRealpathForIdentity(root, !CASE_INSENSITIVE_FS),
        },
      ]);
    } finally {
      rmTemp(dir);
    }
  });

  it("a renamed id still finds the legacy row by path", () => {
    const dir = makeTempDir("Vault-Identity-Case-");
    try {
      const root = canonicalizeVaultRoot(dir);
      const { cacheDb, edb } = stores();
      seedLegacy(cacheDb, "old-id", root);
      const notices = resolveAndApplyVaultIdentity(cacheDb, edb, [{ id: "new-id", path: root }]);
      expect(notices.map((n) => [n.oldId, n.newId])).toEqual([["old-id", "new-id"]]);
      expect(recorded(cacheDb)).toEqual([
        {
          vault_id: "new-id",
          root_realpath: normalizeRealpathForIdentity(root, !CASE_INSENSITIVE_FS),
        },
      ]);
    } finally {
      rmTemp(dir);
    }
  });
});
