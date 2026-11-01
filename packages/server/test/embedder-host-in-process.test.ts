// GH #1433 rec 4, step 1: the EmbedderHost seam. The in-process adapter must be behaviour-identical
// to the memoized session() it wraps, and the process-level registry must close every live host on
// shutdown without letting one failing close skip the rest.
import { describe, expect, it } from "vitest";
import { createInProcessHost, type LoadedEmbedder } from "../src/embeddings/host/in-process";
import { closeAllHosts, registerHost } from "../src/embeddings/host/registry";
import { buildLocalEmbeddingProvider } from "../src/providers/registry";
import type { EmbeddingsConfigLike } from "../src/providers/types";

function stubEmbedder(): LoadedEmbedder & { calls: number } {
  const stub = {
    calls: 0,
    embed: async (texts: string[]) => {
      stub.calls += 1;
      return texts.map((t) => [t.length]);
    },
  };
  return stub;
}

describe("in-process EmbedderHost", () => {
  it("loads once across N embeds and passes the loaded embedder's results through unchanged", async () => {
    const stub = stubEmbedder();
    let loads = 0;
    const host = createInProcessHost(async () => {
      loads += 1;
      return stub;
    });
    const first = await host.embed(["a"]);
    const second = await host.embed(["bb", "ccc"]);
    await host.embed(["dddd"]);
    expect(loads).toBe(1);
    expect(stub.calls).toBe(3);
    expect(second).toEqual([[2], [3]]);
    expect(first).toEqual([[1]]);
  });

  it("does not memoize a rejected load: the next embed retries, as the local session() does", async () => {
    const stub = stubEmbedder();
    let loads = 0;
    const host = createInProcessHost(async () => {
      loads += 1;
      if (loads === 1) throw new Error("transient: package not built yet");
      return stub;
    });
    await expect(host.embed(["x"])).rejects.toThrow("transient");
    await expect(host.embed(["x"])).resolves.toEqual([[1]]);
    expect(loads).toBe(2);
    expect((await host.stats()).state).toBe("ready");
  });

  it("recycle() is a counted no-op: no reload, no restart, recycles increments", async () => {
    let loads = 0;
    const stub = stubEmbedder();
    const host = createInProcessHost(async () => {
      loads += 1;
      return stub;
    });
    await host.embed(["x"]);
    await expect(host.recycle("reconcile")).resolves.toBeUndefined();
    await host.embed(["y"]);
    expect(loads).toBe(1);
    expect(host.kind).toBe("in-process");
    expect(await host.stats()).toMatchObject({ restarts: 0, recycles: 1 });
  });
});

describe("EmbedderHost registry", () => {
  it("closeAllHosts closes every registered host and never throws when one close throws", async () => {
    const closed: string[] = [];
    const makeHost = (name: string, close: () => Promise<void>) =>
      registerHost({
        kind: "in-process",
        embed: async () => [],
        recycle: async () => {},
        stats: async () => ({ state: "idle", restarts: 0, recycles: 0 }),
        close: async () => {
          closed.push(name);
          await close();
        },
      });
    makeHost("first", async () => {});
    makeHost("broken", async () => {
      throw new Error("close failed");
    });
    makeHost("last", async () => {});
    await expect(closeAllHosts()).resolves.toBeUndefined();
    expect(closed).toEqual(expect.arrayContaining(["first", "broken", "last"]));
  });
});

describe("buildLocalEmbeddingProvider through the host seam", () => {
  it("keeps the provider id, provider, model and dimensions exactly as before", () => {
    const c: EmbeddingsConfigLike = {
      provider: "local",
      model: "bge-small-en-v1.5",
      dimensions: 384,
    };
    const provider = buildLocalEmbeddingProvider(c, { cacheDir: "/nonexistent-cache-dir" });
    expect(provider.id).toBe("local:bge-small-en-v1.5:q8");
    expect(provider.provider).toBe("local");
    expect(provider.model).toBe("bge-small-en-v1.5");
    expect(provider.dimensions).toBe(384);
  });
});
