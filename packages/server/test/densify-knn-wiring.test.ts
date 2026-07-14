// The other half of the knnMinSim seam: does index_vault actually FORWARD the configured floor?
//
// Threading a config value through four layers (schema -> M2 deps -> IndexVaultArgs -> computeKnnEdges)
// is exactly the kind of change that typechecks while quietly dropping the value on the floor. The floor
// filter itself is covered in densify-knn-floor.test.ts; this file proves the number gets there.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Typed to computeKnnEdges' real shape, so mock.calls[0][2] is the opts object, not a zero-arg tuple.
const knnSpy = vi.hoisted(() =>
  vi.fn((_db: unknown, _vaultId: string, _opts?: { k?: number; minSim?: number }) => [] as never[]),
);

vi.mock("../src/search/derived-edges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/derived-edges")>();
  return { ...actual, computeKnnEdges: knnSpy };
});

const { indexVault } = await import("../src/search/indexer");
const { makeM2Vault } = await import("./m2-helpers");

// vault_edges comes from MIGRATIONS, not schema.sql — and its vault_id column and its derived-edge
// columns each come from a LATER one. The M2 test vault loads only schema.sql, so without them the
// indexer's edge block is skipped entirely (tableExists -> false) and this test would pass VACUOUSLY:
// asserting the builder got the right floor while it was never called at all.
//
// Selected by name rather than hardcoded, so a future vault_edges migration is picked up automatically
// instead of silently leaving this vault a schema version behind. The full migration set cannot be
// replayed here — the initial migration would collide with the tables schema.sql already created.
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations", import.meta.url));
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql") && f.includes("vault_edges"))
  .sort();

function migratedVault(files: Record<string, string>): any {
  const v = makeM2Vault({ files });
  for (const m of MIGRATIONS) {
    v.db.exec(readFileSync(`${MIGRATIONS_DIR}/${m}`, "utf8"));
  }
  return v;
}

describe("index_vault forwards the configured kNN floor", () => {
  beforeEach(() => knnSpy.mockClear());

  it("passes densify.knnMinSim (and knnK) straight through to computeKnnEdges", async () => {
    const v = migratedVault({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta" });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { knnEdges: true, knnK: 3, knnMinSim: 0.8 },
    });
    expect(knnSpy).toHaveBeenCalledTimes(1);
    expect(knnSpy.mock.calls[0]?.[2]).toEqual({ k: 3, minSim: 0.8 });
    v.cleanup();
  });

  it("defaults the floor to 0 when config omits it — unchanged behavior for existing vaults", async () => {
    const v = migratedVault({ "a.md": "# A\n\nalpha" });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { knnEdges: true },
    });
    expect(knnSpy.mock.calls[0]?.[2]).toEqual({ k: 8, minSim: 0 });
    v.cleanup();
  });

  it("does not call the kNN builder at all when knnEdges is off", async () => {
    const v = migratedVault({ "a.md": "# A\n\nalpha" });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true },
    });
    expect(knnSpy).not.toHaveBeenCalled();
    v.cleanup();
  });
});
