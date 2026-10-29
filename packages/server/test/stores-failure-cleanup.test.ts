import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionExperientialDb } from "../src/db/experiential";
import type { Database } from "../src/db/types";
import { type StoresDeps, wireStores } from "../src/runtime/stores";
import { makeTempDir, rmTemp } from "./tmp";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  provisionCache: vi.fn(),
  migrate: vi.fn(),
  identity: vi.fn(),
}));
vi.mock("../src/db/open", () => ({ openDatabase: mocks.open }));
vi.mock("../src/db/provision", () => ({ provisionCacheDb: mocks.provisionCache }));
vi.mock("../src/db/migrate", () => ({ runMigrations: mocks.migrate }));
vi.mock("../src/vault/identity", () => ({
  resolveAndApplyVaultIdentity: mocks.identity,
  formatVaultRenameNotice: () => "",
}));

const dirs: string[] = [];
const order: string[] = [];
function database(name: string) {
  return {
    exec: vi.fn(),
    prepare: vi.fn(),
    close: vi.fn(() => {
      order.push(name);
    }),
  } satisfies Database;
}
function deps(): StoresDeps {
  const cacheDir = makeTempDir("otc-store-failure-");
  dirs.push(cacheDir);
  return {
    cacheDir,
    version: "test",
    experiential: {
      logRetrievals: false,
      captureEpisodes: false,
      captureContent: false,
      activationRerank: false,
    },
    experientialMigrations: [],
    vaults: [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  order.length = 0;
  mocks.identity.mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmTemp(dir);
});

describe("store construction failure ownership", () => {
  it("closes an experiential handle when migration fails and preserves the migration error", async () => {
    const db = database("experiential");
    const failure = new Error("migration failed");
    mocks.migrate.mockImplementation(() => {
      throw failure;
    });
    db.close.mockImplementation(() => {
      throw new Error("close failed");
    });
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(provisionExperientialDb("unused", [], { open: async () => db })).rejects.toBe(
      failure,
    );
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("close failed"));
  });

  it("closes cache when its provisioning fails before the second database opens", async () => {
    const cache = database("cache");
    const failure = new Error("cache migration failed");
    mocks.open.mockResolvedValue(cache);
    mocks.provisionCache.mockImplementation(() => {
      throw failure;
    });
    await expect(wireStores(deps())).rejects.toBe(failure);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["cache"]);
  });

  it("closes cache when opening experiential storage rejects", async () => {
    const cache = database("cache");
    const failure = new Error("second open failed");
    mocks.open.mockResolvedValueOnce(cache).mockRejectedValueOnce(failure);
    await expect(wireStores(deps())).rejects.toBe(failure);
    expect(order).toEqual(["cache"]);
  });

  it("unwinds experiential then cache exactly once when experiential migration fails", async () => {
    const cache = database("cache");
    const experiential = database("experiential");
    const failure = new Error("experiential migration failed");
    mocks.open.mockResolvedValueOnce(cache).mockResolvedValueOnce(experiential);
    mocks.migrate.mockImplementation(() => {
      throw failure;
    });
    await expect(wireStores(deps())).rejects.toBe(failure);
    expect(order).toEqual(["experiential", "cache"]);
    expect(experiential.close).toHaveBeenCalledTimes(1);
  });

  it("unwinds both stores after identity resolution fails even when the first close throws", async () => {
    const cache = database("cache");
    const experiential = database("experiential");
    const failure = new Error("identity failed");
    mocks.open.mockResolvedValueOnce(cache).mockResolvedValueOnce(experiential);
    mocks.identity.mockImplementation(() => {
      throw failure;
    });
    experiential.close.mockImplementation(() => {
      order.push("experiential");
      throw new Error("experiential close failed");
    });
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(wireStores(deps())).rejects.toBe(failure);
    expect(order).toEqual(["experiential", "cache"]);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("experiential close failed"));
  });

  it("does not close an already released experiential handle again on normal close", async () => {
    const cache = database("cache");
    const experiential = database("experiential");
    mocks.open.mockResolvedValueOnce(cache).mockResolvedValueOnce(experiential);
    const stores = await wireStores(deps());
    stores.close();
    stores.close();
    expect(order).toEqual(["experiential", "cache"]);
    expect(cache.close).toHaveBeenCalledTimes(1);
    expect(experiential.close).toHaveBeenCalledTimes(1);
  });

  it("attempts both live stores exactly once on normal close and reports their failures", async () => {
    const cache = database("cache");
    const experiential = database("experiential");
    const cacheFailure = new Error("cache close failed");
    const experientialFailure = new Error("experiential close failed");
    cache.close.mockImplementation(() => {
      order.push("cache");
      throw cacheFailure;
    });
    experiential.close.mockImplementation(() => {
      order.push("experiential");
      throw experientialFailure;
    });
    mocks.open.mockResolvedValueOnce(cache).mockResolvedValueOnce(experiential);
    const input = deps();
    input.experiential.activationRerank = true;
    const stores = await wireStores(input);
    expect(stores.experientialOpen).toBe(true);
    expect(stores.close).toThrow(
      new AggregateError([experientialFailure, cacheFailure], "Failed to close stores"),
    );
    expect(stores.close).not.toThrow();
    expect(order).toEqual(["experiential", "cache"]);
    expect(cache.close).toHaveBeenCalledTimes(1);
    expect(experiential.close).toHaveBeenCalledTimes(1);
  });
});
