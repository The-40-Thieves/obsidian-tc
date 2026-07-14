// The other half of the knnMinSim seam: does index_vault actually FORWARD the configured floor?
//
// Threading a config value through four layers (schema -> M2 deps -> IndexVaultArgs -> computeKnnEdges)
// is exactly the kind of change that typechecks while quietly dropping the value on the floor. The floor
// filter itself is covered in densify-knn-floor.test.ts; this file proves the number gets there.
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

// makeM2Vault now provisions the full cache.db migration chain (db/provision.ts), so vault_edges and
// its derived-edge columns already exist. An earlier version of this file replayed the vault_edges
// migrations by hand on top of it — which was correct when the M2 helper loaded only schema.sql, but
// collided ("table vault_edges already exists") once the helper switched to the real chain. The manual
// replay is now redundant; the vault is fully provisioned by makeM2Vault alone.
function migratedVault(files: Record<string, string>): any {
  return makeM2Vault({ files });
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
