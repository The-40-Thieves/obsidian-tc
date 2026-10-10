// Background warmup of the "local" embedder. The first embed() with the local provider lazily
// downloads and loads the model, so without a warmup the first search_semantic (or the boot
// reconcile) pays that cost inside a tool call. The warmup rides deferBootWork: after the first
// client's `initialize` (or the cap), never ahead of it, cancellable on close, non-fatal on failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings/provider";
import { createEmbedderWarmup, embedderWarmupApplies } from "../src/embeddings/warmup";
import type { LocalEmbedderResolution } from "../src/providers/local-embedder-registry";
import { buildLocalEmbeddingProvider } from "../src/providers/registry";

function spyProvider(
  provider: string,
  embed: EmbeddingProvider["embed"] = async (texts) => texts.map(() => [0, 0, 0]),
): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return {
    id: `${provider}:m`,
    provider,
    model: "m",
    dimensions: 3,
    embed: vi.fn(embed),
  };
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe("embedderWarmupApplies", () => {
  it("is true only for the local model; every remote or unknown provider is excluded", () => {
    expect(embedderWarmupApplies("local")).toBe(true);
    for (const p of [
      "ollama",
      "openai",
      "voyage",
      "cohere",
      "bge-m3",
      "openai-compatible",
      "model-tier",
      "module",
      "something-new",
    ]) {
      expect(embedderWarmupApplies(p)).toBe(false);
    }
  });
});

describe("createEmbedderWarmup", () => {
  let log: Mock<(msg: string) => void>;
  beforeEach(() => {
    log = vi.fn<(msg: string) => void>();
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not start before initialize and starts after it, on a later macrotask", async () => {
    const p = spyProvider("local");
    const w = createEmbedderWarmup(p, log);
    let initialize!: () => void;
    const initialized = new Promise<void>((r) => {
      initialize = r;
    });
    w.schedule({ initialized, maxWaitMs: 30_000 });
    expect(w.status()).toEqual({ state: "pending" });
    await tick(20);
    expect(p.embed).not.toHaveBeenCalled();
    initialize();
    // Same tick as the resolution: the initialize response has not yet been followed by any work.
    expect(p.embed).not.toHaveBeenCalled();
    await tick(20);
    expect(p.embed).toHaveBeenCalledTimes(1);
    expect(w.status()).toEqual({ state: "ready" });
  });

  it("starts after the cap when no initialize ever arrives", async () => {
    const p = spyProvider("local");
    const w = createEmbedderWarmup(p, log);
    w.schedule({ initialized: new Promise<void>(() => {}), maxWaitMs: 30 });
    await tick(10);
    expect(p.embed).not.toHaveBeenCalled();
    await tick(60);
    expect(p.embed).toHaveBeenCalledTimes(1);
  });

  it("embeds one tiny query-role text (no vault content, no egress declaration needed)", async () => {
    const p = spyProvider("local");
    const w = createEmbedderWarmup(p, log);
    await w.run();
    const [texts, opts] = p.embed.mock.calls[0] as [string[], { input?: string }];
    expect(texts).toHaveLength(1);
    expect(texts[0]?.length).toBeLessThan(16);
    expect(opts).toEqual({ input: "query" });
  });

  it.each([
    "ollama",
    "openai",
    "voyage",
    "cohere",
    "bge-m3",
    "openai-compatible",
    "model-tier",
    "module",
  ])("never calls a %s provider: not-applicable, nothing scheduled", async (name) => {
    const p = spyProvider(name);
    const w = createEmbedderWarmup(p, log);
    expect(w.status()).toEqual({ state: "not-applicable" });
    w.schedule({ initialized: Promise.resolve(), maxWaitMs: 5 });
    await w.run();
    await tick(30);
    expect(p.embed).not.toHaveBeenCalled();
    expect(w.status()).toEqual({ state: "not-applicable" });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports loading while the model loads, then ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p = spyProvider("local", async (t) => {
      await gate;
      return t.map(() => [0, 0, 0]);
    });
    const w = createEmbedderWarmup(p, log);
    const done = w.run();
    expect(w.status()).toEqual({ state: "loading" });
    release();
    await done;
    expect(w.status()).toEqual({ state: "ready" });
  });

  it("a failing load is non-fatal: run() resolves, state is failed with the error, logged ONCE", async () => {
    const p = spyProvider("local", async () => {
      throw new Error("model download refused");
    });
    const w = createEmbedderWarmup(p, log);
    await expect(w.run()).resolves.toBeUndefined();
    expect(w.status()).toEqual({ state: "failed", error: "model download refused" });
    await w.run();
    await w.run();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("model download refused");
    // A failed warmup is not retried by itself: the next real embed() does its own retry.
    expect(p.embed).toHaveBeenCalledTimes(1);
  });

  it("cancel before start: the work never begins", async () => {
    const p = spyProvider("local");
    const w = createEmbedderWarmup(p, log);
    const cancel = w.schedule({ initialized: new Promise<void>(() => {}), maxWaitMs: 30 });
    cancel();
    await tick(80);
    expect(p.embed).not.toHaveBeenCalled();
    expect(w.status()).toEqual({ state: "pending" });
  });

  it("cancel() on close also stops a scheduled run and silences a late failure", async () => {
    let fail!: (e: Error) => void;
    const p = spyProvider(
      "local",
      () =>
        new Promise<number[][]>((_, rej) => {
          fail = rej;
        }),
    );
    const w = createEmbedderWarmup(p, log);
    w.schedule({ initialized: Promise.resolve(), maxWaitMs: 1_000 });
    await tick(20);
    expect(w.status().state).toBe("loading");
    w.cancel();
    fail(new Error("late failure after shutdown"));
    await tick(10);
    expect(log).not.toHaveBeenCalled();
  });

  it("cancel() before schedule's timers fire prevents the run", async () => {
    const p = spyProvider("local");
    const w = createEmbedderWarmup(p, log);
    w.schedule({ initialized: Promise.resolve(), maxWaitMs: 5 });
    w.cancel();
    await tick(40);
    expect(p.embed).not.toHaveBeenCalled();
  });
});

describe("one in-flight load shared by the warmup and the first real embed", () => {
  const stubResolution = (counts: { resolve: number; create: number; embed: number }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolveModule = async (): Promise<LocalEmbedderResolution> => {
      counts.resolve++;
      await gate;
      return {
        ok: true,
        attempts: [],
        inSourceCheckout: false,
        mod: {
          createEmbeddingProvider: () => {
            counts.create++;
            return {
              id: "x",
              model: "bge-small-en-v1.5",
              dimensions: 3,
              embed: async (texts: string[]) => {
                counts.embed++;
                return texts.map(() => [0, 0, 0]);
              },
            };
          },
        },
      };
    };
    return { resolveModule, release };
  };

  it("a concurrent first search and the warmup resolve and create the model once", async () => {
    const counts = { resolve: 0, create: 0, embed: 0 };
    const { resolveModule, release } = stubResolution(counts);
    const provider = buildLocalEmbeddingProvider(
      { provider: "local", model: "bge-small-en-v1.5", dimensions: 3 },
      { cacheDir: "/tmp/warmup-test-cache" },
      resolveModule,
    );
    const w = createEmbedderWarmup(provider, vi.fn());
    const warm = w.run();
    const search = provider.embed(["how do I find notes"], { input: "query" });
    release();
    await Promise.all([warm, search]);
    expect(counts).toEqual({ resolve: 1, create: 1, embed: 2 });
    expect(w.status()).toEqual({ state: "ready" });
  });

  it("the boot reconcile racing the warmup also loads once", async () => {
    const counts = { resolve: 0, create: 0, embed: 0 };
    const { resolveModule, release } = stubResolution(counts);
    const provider = buildLocalEmbeddingProvider(
      { provider: "local", model: "bge-small-en-v1.5", dimensions: 3 },
      { cacheDir: "/tmp/warmup-test-cache" },
      resolveModule,
    );
    const w = createEmbedderWarmup(provider, vi.fn());
    const reconcile = provider.embed(["chunk a", "chunk b"], {
      input: "document",
      sourcePaths: [],
    });
    const warm = w.run();
    release();
    await Promise.all([warm, reconcile]);
    expect(counts.resolve).toBe(1);
    expect(counts.create).toBe(1);
  });

  it("a failed warmup does not wedge the provider: the next real embed retries and succeeds", async () => {
    let attempts = 0;
    const provider = buildLocalEmbeddingProvider(
      { provider: "local", model: "bge-small-en-v1.5", dimensions: 3 },
      { cacheDir: "/tmp/warmup-test-cache" },
      async () => {
        attempts++;
        if (attempts === 1) return { ok: false, attempts: [], inSourceCheckout: false };
        return {
          ok: true,
          attempts: [],
          inSourceCheckout: false,
          mod: {
            createEmbeddingProvider: () => ({
              id: "x",
              model: "m",
              dimensions: 3,
              embed: async (t: string[]) => t.map(() => [0, 0, 0]),
            }),
          },
        };
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = createEmbedderWarmup(provider, vi.fn());
    await w.run();
    expect(w.status().state).toBe("failed");
    await expect(provider.embed(["q"], { input: "query" })).resolves.toHaveLength(1);
  });
});

describe("the boot path wires it", () => {
  const src = readFileSync(join(__dirname, "..", "src", "runtime", "server-runtime.ts"), "utf8");
  it("start() schedules the warmup behind the same initialize promise, and close() cancels it", () => {
    expect(src).toMatch(/embedderWarmup\.schedule\(\{\s*initialized/);
    expect(src).toMatch(/embedderWarmup\.cancel\(\)/);
    expect(src).toMatch(/getEmbedderWarmup: \(\) => embedderWarmup\.status\(\)/);
  });
});
