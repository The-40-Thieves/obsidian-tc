// THE-944: auto-select the bundled "local" cross-encoder as the LAST fallback in the ABSENT-block
// default precedence — model-tier ?? gateway ?? local — gated on no gateway URL being configured
// (the same condition "gateway yields null" already means). This file owns building
// packages/reranker-local's dist, same pattern and same isolation reasoning as
// test/reranker-local-resolution.test.ts: never relying on ambient repo state or cross-test-file
// ordering for whether the optional package resolves.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { wireGatewaySeams } from "../src/runtime/tool-wiring";

const HERE = dirname(fileURLToPath(import.meta.url));
const RERANKER_LOCAL_DIR = join(HERE, "..", "..", "reranker-local");
const DIST_DIR = join(RERANKER_LOCAL_DIR, "dist");
const DIST_ENTRY = join(DIST_DIR, "index.js");

const prevGatewayUrl = process.env.OBSIDIAN_TC_GATEWAY_URL;
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevGatewayUrl === undefined) delete process.env.OBSIDIAN_TC_GATEWAY_URL;
  else process.env.OBSIDIAN_TC_GATEWAY_URL = prevGatewayUrl;
});

function ollamaEmbeddings() {
  return ServerConfigSchema.parse({
    vaults: [{ id: "main", path: "/v" }],
    embeddings: { provider: "ollama" },
  }).embeddings;
}

function modelTierEmbeddings() {
  return ServerConfigSchema.parse({
    vaults: [{ id: "main", path: "/v" }],
    embeddings: {
      provider: "model-tier",
      dimensions: 4,
      modelTier: {
        dense: { baseUrl: "http://dense" },
        full: { baseUrl: "http://model-tier-full" },
      },
    },
  }).embeddings;
}

describe("wireGatewaySeams — THE-944 auto-select 'local' (no gateway configured)", () => {
  describe("before packages/reranker-local is built", () => {
    beforeAll(() => {
      rmSync(DIST_DIR, { recursive: true, force: true });
    });

    it("no model-tier, no gateway, local unresolvable -> reranker stays null (RRF-only), unchanged", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      expect(existsSync(DIST_ENTRY)).toBe(false);
      const { reranker } = await wireGatewaySeams(ollamaEmbeddings());
      expect(reranker).toBeNull();
    });
  });

  describe("once packages/reranker-local is built", () => {
    beforeAll(() => {
      execFileSync("bun", ["install", "--frozen-lockfile"], {
        cwd: RERANKER_LOCAL_DIR,
        stdio: "pipe",
      });
      execFileSync("bun", ["run", "build"], { cwd: RERANKER_LOCAL_DIR, stdio: "pipe" });
      expect(existsSync(DIST_ENTRY)).toBe(true);
    }, 180_000);

    afterAll(() => {
      // Don't leave a built artifact for other test files (notably reranker-slot-wiring.test.ts's
      // "wireGatewaySeams ... degrades" test, which asserts the OPPOSITE) to accidentally depend on.
      rmSync(DIST_DIR, { recursive: true, force: true });
    });

    it("no model-tier, no gateway -> auto-selects 'local' via the real source-checkout route", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const { reranker } = await wireGatewaySeams(ollamaEmbeddings());
      expect(reranker).not.toBeNull();
      expect(typeof reranker).toBe("function");
    });

    it("a gateway URL configured -> gateway wins; local auto-select never fires", async () => {
      process.env.OBSIDIAN_TC_GATEWAY_URL = "http://gw";
      const hits: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          hits.push(String(url));
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }),
      );
      const { reranker } = await wireGatewaySeams(ollamaEmbeddings());
      expect(reranker).not.toBeNull();
      await reranker?.("q", ["a"], 1, []);
      // Hits the gateway, not local inference (which would never call fetch("http://gw/rerank")).
      expect(hits).toEqual(["http://gw/rerank"]);
    });

    it("model-tier configured -> model-tier wins over the now-resolvable local package", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const hits: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          hits.push(String(url));
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }),
      );
      const { reranker } = await wireGatewaySeams(modelTierEmbeddings());
      await reranker?.("q", ["a"], 1, []);
      expect(hits).toEqual(["http://model-tier-full/v1/rerank"]);
    });

    it("a DECLARED reranker block still wins over auto-select entirely (unaffected by THE-944)", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const rerankerCfg = ServerConfigSchema.parse({
        vaults: [{ id: "main", path: "/v" }],
        reranker: {
          provider: "cohere-compatible",
          model: "rerank-v3.5",
          baseUrl: "http://declared/v2",
        },
      }).reranker;
      const hits: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          hits.push(String(url));
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }),
      );
      const { reranker } = await wireGatewaySeams(ollamaEmbeddings(), rerankerCfg);
      await reranker?.("q", ["a"], 1, []);
      expect(hits).toEqual(["http://declared/v2/rerank"]);
    });
  });
});

// THE-944 review round 2 (G3): boot must SKIP auto-select entirely on a platform with no
// onnxruntime-node native prebuild — never wire a reranker guaranteed to throw on first use.
// Uses the injected `resolveLocalReranker` (always resolves, matching a fully-working deployment)
// alongside `platformOverride`, so these tests are decoupled from packages/reranker-local/dist's
// real on-disk state entirely — the platform check must short-circuit BEFORE resolution is ever
// attempted, so a stub that WOULD succeed proves the skip is real, not incidental.
describe("wireGatewaySeams — THE-944 review round 2 (G3): boot skips auto-select on an unsupported platform", () => {
  it("darwin-x64: reranker stays null and resolution is NEVER attempted, even though it would succeed", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const resolveLocalReranker = vi.fn(async () => ({
      ok: true as const,
      mod: { createReranker: () => async () => [] },
      attempts: [{ route: "bare-specifier" as const, target: "x", ok: true }],
    }));
    const { reranker } = await wireGatewaySeams(
      ollamaEmbeddings(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveLocalReranker,
      { platform: "darwin", arch: "x64" },
    );
    expect(reranker).toBeNull();
    expect(resolveLocalReranker).not.toHaveBeenCalled();
  });

  it("musl linux: same skip, same never-attempted proof", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const resolveLocalReranker = vi.fn(async () => ({
      ok: true as const,
      mod: { createReranker: () => async () => [] },
      attempts: [],
    }));
    const { reranker } = await wireGatewaySeams(
      ollamaEmbeddings(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveLocalReranker,
      { platform: "linux", arch: "x64", isMuslRuntime: () => true },
    );
    expect(reranker).toBeNull();
    expect(resolveLocalReranker).not.toHaveBeenCalled();
  });

  it("logs the remedy naming the platform, only when config alone would have auto-selected", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { platform: "darwin", arch: "x64" },
      );
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = String(consoleSpy.mock.calls[0]?.[0]);
      expect(logged).toMatch(/auto-select: skipped/);
      expect(logged).toMatch(/darwin-x64/);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does NOT log on an unsupported platform when a gateway is configured — platform is not why it's skipped", async () => {
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://gw";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })),
      );
      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { platform: "darwin", arch: "x64" },
      );
      expect(reranker).not.toBeNull(); // gateway wins, as always
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does NOT log on a SUPPORTED platform even though config alone would auto-select (nothing to remedy)", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const resolveLocalReranker = vi.fn(async () => ({
        ok: true as const,
        mod: { createReranker: () => async () => [] },
        attempts: [],
      }));
      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveLocalReranker,
        { platform: "linux", arch: "x64", isMuslRuntime: () => false },
      );
      expect(reranker).not.toBeNull();
      expect(resolveLocalReranker).toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
