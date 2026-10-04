import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTH_MIGRATION_FILES,
  CACHE_MIGRATION_FILES,
  EXPERIENTIAL_MIGRATION_FILES,
  OAUTH_MIGRATION_FILES,
  versionOf,
} from "../src/db/migration-manifest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

describe("migration manifest completeness (audit #9)", () => {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const registered = [
    ...CACHE_MIGRATION_FILES,
    ...EXPERIENTIAL_MIGRATION_FILES,
    ...AUTH_MIGRATION_FILES,
    ...OAUTH_MIGRATION_FILES,
  ].sort();

  it("every .sql file on disk is registered in exactly one chain", () => {
    expect(registered).toEqual(onDisk);
  });

  it("the four chains are disjoint", () => {
    const overlap = (a: readonly string[], b: readonly string[]) => a.filter((f) => b.includes(f));
    expect(overlap(CACHE_MIGRATION_FILES, EXPERIENTIAL_MIGRATION_FILES)).toEqual([]);
    expect(overlap(CACHE_MIGRATION_FILES, AUTH_MIGRATION_FILES)).toEqual([]);
    expect(overlap(EXPERIENTIAL_MIGRATION_FILES, AUTH_MIGRATION_FILES)).toEqual([]);
    for (const other of [
      CACHE_MIGRATION_FILES,
      EXPERIENTIAL_MIGRATION_FILES,
      AUTH_MIGRATION_FILES,
    ]) {
      expect(overlap(OAUTH_MIGRATION_FILES, other)).toEqual([]);
    }
  });

  it("no migration VERSION is shared between chains (auth.db has its own numbering)", () => {
    const versions = (files: readonly string[]) => files.map(versionOf);
    const cache = versions(CACHE_MIGRATION_FILES);
    const auth = versions(AUTH_MIGRATION_FILES);
    expect(auth.filter((v) => cache.includes(v))).toEqual([]);
    expect(auth.filter((v) => versions(EXPERIENTIAL_MIGRATION_FILES).includes(v))).toEqual([]);
    expect(auth.length).toBeGreaterThan(0);
    // oauth.db has its own numbering too.
    const oauth = versions(OAUTH_MIGRATION_FILES);
    for (const other of [cache, auth, versions(EXPERIENTIAL_MIGRATION_FILES)]) {
      expect(oauth.filter((v) => other.includes(v))).toEqual([]);
    }
    expect(oauth.length).toBeGreaterThan(0);
  });
});
