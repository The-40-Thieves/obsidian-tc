import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CACHE_MIGRATION_FILES, EXPERIENTIAL_MIGRATION_FILES } from "../src/db/migration-manifest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

describe("migration manifest completeness (audit #9)", () => {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const registered = [...CACHE_MIGRATION_FILES, ...EXPERIENTIAL_MIGRATION_FILES].sort();

  it("every .sql file on disk is registered in exactly one chain", () => {
    expect(registered).toEqual(onDisk);
  });

  it("the two chains are disjoint", () => {
    const overlap = CACHE_MIGRATION_FILES.filter((f) =>
      (EXPERIENTIAL_MIGRATION_FILES as readonly string[]).includes(f),
    );
    expect(overlap).toEqual([]);
  });
});
