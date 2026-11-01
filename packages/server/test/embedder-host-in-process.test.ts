// GH #1433 rec 4, step 1: the EmbedderHost seam. The in-process adapter must be behaviour-identical
// to the memoized session() it wraps, and the owner-keyed registry must close only the hosts its own
// owner built, bound a close that never settles, and let one failing close not skip the rest.
import { describe, expect, it, vi } from "vitest";
import { createInProcessHost, type LoadedEmbedder } from "../src/embeddings/host/in-process";
import { closeOwnedHosts, registerHost } from "../src/embeddings/host/registry";
import type { EmbedderHost } from "../src/embeddings/host/types";
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

function fakeHost(
  name: string,
  closed: string[],
  close: () => Promise<void> = async () => {},
): EmbedderHost {
  return {
    kind: "in-process",
    embed: async () => [],
    recycle: async () => {},
    stats: async () => ({ state: "idle", restarts: 0, recycles: 0 }),
    snapshot: () => ({ state: "idle", restarts: 0, recycles: 0 }),
    close: async () => {
      closed.push(name);
      await close();
    },
  };
}

describe("in-process EmbedderHost", () => {
  it("loads once across N embeds and passes the loaded embedder's results through unchanged", async () => {
    const stub = stubEmbedder();
    let loads = 0;
    // The loader owns memoization (the provider's session() memo); the host calls it per embed.
    let memo: Promise<LoadedEmbedder> | undefined;
    const host = createInProcessHost(() => {
      memo ??= (async () => {
        loads += 1;
        return stub;
      })();
      return memo;
    });
    const first = await host.embed(["a"]);
    const second = await host.embed(["bb", "ccc"]);
    await host.embed(["dddd"]);
    expect(loads).toBe(1);
    expect(stub.calls).toBe(3);
    expect(second).toEqual([[2], [3]]);
    expect(first).toEqual([[1]]);
  });

  it("the host does not memoize: the loader is called on every embed (memoization belongs to the loader)", async () => {
    const stub = stubEmbedder();
    let loads = 0;
    const host = createInProcessHost(async () => {
      loads += 1;
      return stub;
    });
    await host.embed(["a"]);
    await host.embed(["b"]);
    await host.embed(["c"]);
    expect(loads).toBe(3);
    expect(stub.calls).toBe(3);
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
    let memo: Promise<LoadedEmbedder> | undefined;
    const host = createInProcessHost(() => {
      memo ??= (async () => {
        loads += 1;
        return stub;
      })();
      return memo;
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
  it("closeOwnedHosts closes every host of its owner and never throws when one close throws", async () => {
    const closed: string[] = [];
    const owner = {};
    registerHost(owner, fakeHost("first", closed));
    registerHost(
      owner,
      fakeHost("broken", closed, async () => {
        throw new Error("close failed");
      }),
    );
    registerHost(owner, fakeHost("last", closed));
    await expect(closeOwnedHosts(owner)).resolves.toBeUndefined();
    expect(closed).toEqual(expect.arrayContaining(["first", "broken", "last"]));
  });

  it("closing one owner's hosts leaves another owner's host open", async () => {
    const closed: string[] = [];
    const ownerA = {};
    const ownerB = {};
    registerHost(ownerA, fakeHost("a", closed));
    registerHost(ownerB, fakeHost("b", closed));
    await closeOwnedHosts(ownerA);
    expect(closed).toEqual(["a"]);
    await closeOwnedHosts(ownerB);
    expect(closed).toEqual(["a", "b"]);
  });

  it("a never-resolving close is bounded by the deadline, so shutdown cannot hang", async () => {
    vi.useFakeTimers();
    try {
      const closed: string[] = [];
      const owner = {};
      registerHost(
        owner,
        fakeHost("stuck", closed, () => new Promise<void>(() => {})),
      );
      let settled = false;
      const done = closeOwnedHosts(owner).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(settled).toBe(true);
      expect(closed).toEqual(["stuck"]);
    } finally {
      vi.useRealTimers();
    }
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

  it("the provider session memo loads the package once across N embeds", async () => {
    const c: EmbeddingsConfigLike = {
      provider: "local",
      model: "bge-small-en-v1.5",
      dimensions: 384,
    };
    let resolves = 0;
    const stubProvider = {
      id: "local:stub",
      model: "bge-small-en-v1.5",
      dimensions: 384,
      embed: async (texts: string[]) => texts.map(() => [1, 2, 3]),
    };
    const resolveModule = async () => {
      resolves += 1;
      return {
        ok: true as const,
        mod: { createEmbeddingProvider: () => stubProvider },
        attempts: [],
        inSourceCheckout: false,
      };
    };
    const provider = buildLocalEmbeddingProvider(
      c,
      { cacheDir: "/tmp/embedder-host-memo" },
      resolveModule,
    );
    await provider.embed(["a"]);
    await provider.embed(["b"]);
    await provider.embed(["c"]);
    expect(resolves).toBe(1);
  });
});
