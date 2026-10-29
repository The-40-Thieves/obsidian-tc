import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { makeTempDir, rmTemp } from "./tmp";

const mocks = vi.hoisted(() => ({
  initOtel: vi.fn(),
  shutdown: vi.fn(),
  beforeTelemetry: vi.fn(),
  storesClosed: vi.fn(),
  cleanups: [] as (() => void)[],
}));
vi.mock("../src/otel/tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/otel/tracing")>()),
  initOtel: mocks.initOtel,
}));
vi.mock("../src/telemetry/wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telemetry/wiring")>();
  return {
    ...actual,
    wireTelemetry: (...args: Parameters<typeof actual.wireTelemetry>) => {
      mocks.beforeTelemetry();
      return actual.wireTelemetry(...args);
    },
  };
});
vi.mock("../src/runtime/stores", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/stores")>();
  return {
    ...actual,
    wireStoresBehindBootstrapBarrier: async (
      ...args: Parameters<typeof actual.wireStoresBehindBootstrapBarrier>
    ) => {
      const stores = await actual.wireStoresBehindBootstrapBarrier(...args);
      const close = stores.close;
      mocks.cleanups.push(close);
      stores.close = () => {
        mocks.storesClosed();
        close();
      };
      return stores;
    },
  };
});

const dirs: string[] = [];
function config() {
  const root = makeTempDir("otc-boot-cleanup-");
  dirs.push(root);
  const result = configFromVaultPath(root);
  result.cacheDir = `${root}/cache`;
  result.embeddings.provider = "ollama";
  result.embeddings.model = "test-model";
  result.embeddings.dimensions = 8;
  result.transports.http.enabled = false;
  return result;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.initOtel.mockResolvedValue({ enabled: false, shutdown: mocks.shutdown });
  mocks.shutdown.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of mocks.cleanups.splice(0)) close();
  for (const dir of dirs.splice(0)) rmTemp(dir);
});

describe("boot cleanup across ownership handoffs", () => {
  it("releases stores when OTEL construction fails before core ownership starts", async () => {
    const failure = new Error("OTEL construction failed");
    mocks.initOtel.mockRejectedValue(failure);
    const cleaned: string[] = [];
    await expect(
      buildServerRuntime(config(), undefined, (name) => cleaned.push(name)),
    ).rejects.toBe(failure);
    expect(cleaned).toEqual(["stores"]);
    expect(mocks.storesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });

  it("releases OTEL then stores after telemetry fails, preserving the error when cleanup rejects", async () => {
    const failure = new Error("telemetry construction failed");
    mocks.beforeTelemetry.mockImplementation(() => {
      throw failure;
    });
    mocks.shutdown.mockRejectedValue(new Error("OTEL cleanup failed"));
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cleaned: string[] = [];
    await expect(
      buildServerRuntime(config(), undefined, (name) => cleaned.push(name)),
    ).rejects.toBe(failure);
    expect(cleaned).toEqual(["otel", "stores"]);
    expect(mocks.storesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("OTEL cleanup failed"));
  });

  it("hands ownership to core without double-closing on a core construction failure", async () => {
    const input = config();
    input.embeddings.provider = "unknown-test-provider" as typeof input.embeddings.provider;
    const cleaned: string[] = [];
    await expect(
      buildServerRuntime(input, undefined, (name) => cleaned.push(name)),
    ).rejects.toThrow(/unknown embeddings provider/);
    expect(cleaned).toEqual(["governance", "otel", "stores"]);
    expect(mocks.storesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });

  it("retains ownership until core argument evaluation finishes", async () => {
    const input = config();
    const failure = new Error("provenance configuration failed");
    input.provenance.enabled = true;
    Object.defineProperty(input.provenance, "host", {
      get() {
        throw failure;
      },
    });
    const cleaned: string[] = [];
    await expect(buildServerRuntime(input, undefined, (name) => cleaned.push(name))).rejects.toBe(
      failure,
    );
    expect(cleaned).toEqual(["otel", "stores"]);
    expect(mocks.storesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });

  it("retains OTEL ownership after core succeeds and a later transport rejects", async () => {
    const input = config();
    input.observability.prometheus.enabled = true;
    input.observability.prometheus.bind = "0.0.0.0";
    const cleaned: string[] = [];
    await expect(
      buildServerRuntime(input, undefined, (name) => cleaned.push(name)),
    ).rejects.toThrow(/refuses a non-localhost bind/);
    expect(cleaned).toEqual(["watcher", "leaderElection", "governance", "otel", "stores"]);
    expect(mocks.storesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });
});
