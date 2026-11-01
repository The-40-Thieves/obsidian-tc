// GH #1433 rec 4, step 2: how `embeddings.host` is selected. Only provider "local" reads it; the
// child host is built lazily by buildLocalEmbeddingProvider (its spawn happens on the first embed,
// tested in embedder-host-child-process.test.ts); and cli.ts hands the child process off before any
// argument parsing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createChildProcessHost: vi.fn() }));
vi.mock("../src/embeddings/host/child-process", () => ({
  createChildProcessHost: mocks.createChildProcessHost,
}));

import { buildLocalEmbeddingProvider, resolveEmbeddings } from "../src/providers/registry";
import type { EmbeddingsConfigLike } from "../src/providers/types";

const BASE: EmbeddingsConfigLike = {
  provider: "local",
  model: "bge-small-en-v1.5",
  dimensions: 384,
  quantized: true,
  threads: 2,
} as EmbeddingsConfigLike;

beforeEach(() => {
  mocks.createChildProcessHost.mockReset();
});

describe("embeddings.host selection", () => {
  it("the default (in-process) never builds a child host", () => {
    buildLocalEmbeddingProvider(BASE, { cacheDir: "/nonexistent-cache-dir" });
    expect(mocks.createChildProcessHost).not.toHaveBeenCalled();
  });

  it("child-process builds one child host at build time, with the local init options, and embeds through it", async () => {
    const stub = { embed: vi.fn(async () => [[7]]) };
    mocks.createChildProcessHost.mockReturnValue({
      kind: "child-process",
      ...stub,
      recycle: async () => {},
      stats: async () => ({ state: "idle", restarts: 0, recycles: 0 }),
      close: async () => {},
    });
    const provider = buildLocalEmbeddingProvider(
      { ...BASE, host: "child-process" } as EmbeddingsConfigLike,
      { cacheDir: "/cache-dir" },
    );
    expect(mocks.createChildProcessHost).toHaveBeenCalledTimes(1);
    expect(mocks.createChildProcessHost.mock.calls[0]?.[0]).toMatchObject({
      init: {
        model: "bge-small-en-v1.5",
        quantized: true,
        threads: 2,
        // Built with the platform `join` in the provider, so the expectation must be too (win32).
        modelsRoot: join("/cache-dir", "models", "embedder-local"),
        cacheDir: "/cache-dir",
      },
    });
    expect(await provider.embed(["x"])).toEqual([[7]]);
    expect(stub.embed).toHaveBeenCalledTimes(1);
  });

  it("refuses embeddings.host child-process with any provider other than local, naming the key", () => {
    expect(() =>
      resolveEmbeddings(
        {
          provider: "openai",
          host: "child-process",
          model: "text-embedding-3-small",
        } as EmbeddingsConfigLike,
        {},
      ),
    ).toThrow(/embeddings\.host/);
  });
});

describe("cli.ts embedder child short-circuit", () => {
  it("hands the process to the child before argument parsing, and exits when the child returns", () => {
    const cli = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
    const gate = cli.indexOf('process.env.OBSIDIAN_TC_EMBEDDER_HOST === "1"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(cli.indexOf("parseCliArgs(process.argv"));
    const block = cli.slice(gate, gate + 400);
    expect(block).toContain("runEmbedderChild");
    expect(block).toContain("process.exit(0)");
  });
});

describe("embeddings.host documentation", () => {
  // Fix round (INFO 8): the fragment read "53 MiB against 2.1 GiB" as a saving. The parent+child total
  // after the batch is about the same, so the fragment must say so, and say what the gain is.
  it("the changes fragment states the parent+child total plainly, not as a saving", () => {
    const fragment = readFileSync(
      fileURLToPath(new URL("../../../changes/embeddings-child-host.md", import.meta.url)),
      "utf8",
    );
    expect(fragment).toContain("2.28 GiB");
    expect(fragment).toContain("2.08 GiB");
    expect(fragment).toMatch(/about the same|slightly higher/);
  });

  // Fix round (MEDIUM 9): the operator-facing page names the host key, its default and what it costs.
  it("documents embeddings.host on the embeddings docs page (in-process default, child-process opt-in, local only)", () => {
    const page = readFileSync(
      fileURLToPath(
        new URL("../../../docs/src/content/docs/configuration/embeddings.md", import.meta.url),
      ),
      "utf8",
    );
    expect(page).toMatch(/\| `host` \|[^\n]*in-process[^\n]*child-process[^\n]*local/);
  });
});
