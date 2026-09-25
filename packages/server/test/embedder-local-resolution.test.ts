// THE-1122 — the "local" EMBEDDINGS resolution ladder and buildLocalEmbeddingProvider, mirroring
// packages/server/test/reranker-local-resolution.test.ts's shape for the reranker slot. Comment
// density is lighter here; the reasoning for the ladder's design (never throws on resolution
// failure, bounded/node_modules-aware source-checkout walk) is identical and spelled out there and
// in registry.ts's own comments.
//
// UNLIKE the reranker version, this file does NOT stage-and-build a throwaway copy of the optional
// package: packages/embedder-local's REAL dist/ is used directly (read-only) for both the
// source-checkout (route iii) and localModulePath (route i) success paths — cheap, since neither
// path here needs @huggingface/transformers or real model weights (buildLocalEmbeddingProvider's
// own embed() call is what would need those, and every test below injects a stub session loader).
// If packages/embedder-local has never been built (`bun run build` not yet run there), the
// route-(iii)/(i) success cases are skipped rather than failing — same policy as
// doctor-cli-bundle-reranker-resolution.test.ts for packages/shared/dist.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildLocalEmbeddingProvider,
  resolveLocalEmbedderModule,
  resolveSourceCheckoutLocalEmbedderPath,
} from "../src/providers/registry";
import type { EmbeddingsConfigLike, ResolveContext } from "../src/providers/types";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMBEDDER_LOCAL_DIR = join(HERE, "..", "..", "embedder-local");
const REAL_DIST_ENTRY = join(EMBEDDER_LOCAL_DIR, "dist", "index.js");
const REAL_DIST_BUILT = existsSync(REAL_DIST_ENTRY);

const BASE_CFG: EmbeddingsConfigLike = {
  provider: "local",
  model: "bge-small-en-v1.5",
  dimensions: 384,
};
// THE-1122 review: cacheDir is now REQUIRED (no CWD-relative fallback) — every real test below
// that isn't specifically testing the fail-closed cacheDir check itself needs one.
const TEST_CTX: ResolveContext = { cacheDir: "/tmp/embedder-local-test-cache" };

/** Stages an anchor-only tree (package.json with the right `name`, no `dist/`) so
 *  resolveSourceCheckoutLocalEmbedderPath's upward walk finds a real anchor while the built entry
 *  it computes from that anchor still does not exist — exercises the walk without needing (or
 *  risking) the real checkout's on-disk build state. */
function writeAnchorOnly(root: string): string {
  const pkgDir = join(root, "packages", "embedder-local");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@the-40-thieves/obsidian-tc-embedder-local" }),
  );
  return root;
}

describe("resolveLocalEmbedderModule — the ladder", () => {
  it("fails cleanly — never throws — when nothing resolves", async () => {
    const anchorRoot = mkdtempSync(join(tmpdir(), "obtc-embedder-local-unbuilt-"));
    try {
      writeAnchorOnly(anchorRoot);
      const sourceCheckout = resolveSourceCheckoutLocalEmbedderPath(anchorRoot);
      expect(sourceCheckout.skippedReason).toBeUndefined();
      expect(existsSync(sourceCheckout.path)).toBe(false); // anchor present, but no dist built

      const alwaysFailImport = async () => {
        throw new Error("injected: unresolvable");
      };
      const resolution = await resolveLocalEmbedderModule({}, {}, alwaysFailImport);
      expect(resolution.ok).toBe(false);
      expect(resolution.attempts.some((a) => a.route === "bare-specifier" && a.ok === false)).toBe(
        true,
      );
      expect(resolution.attempts.some((a) => a.route === "source-checkout" && a.ok === false)).toBe(
        true,
      );
    } finally {
      try {
        rmTemp(anchorRoot);
      } catch (e) {
        console.warn(`[embedder-local-resolution.test.ts] failed to clean up ${anchorRoot}:`, e);
      }
    }
  });

  it("resolves via the automatic source-checkout fallback (route iii) against the REAL built package", async (ctx) => {
    if (!REAL_DIST_BUILT) {
      ctx.skip(
        `packages/embedder-local/dist/index.js not built — run "bun run build" in packages/embedder-local first`,
      );
      return;
    }
    const resolution = await resolveLocalEmbedderModule({}, {});
    expect(resolution.ok).toBe(true);
    const succeeded = resolution.attempts.find((a) => a.ok);
    expect(succeeded?.route).toBe("source-checkout");
    expect(typeof resolution.mod?.createEmbeddingProvider).toBe("function");
  });

  it("resolves via an explicit localModulePath override (route i) pointed at the same real dist", async (ctx) => {
    if (!REAL_DIST_BUILT) {
      ctx.skip("packages/embedder-local/dist/index.js not built");
      return;
    }
    const resolution = await resolveLocalEmbedderModule({ localModulePath: REAL_DIST_ENTRY }, {});
    expect(resolution.ok).toBe(true);
    expect(resolution.attempts[0]).toMatchObject({ route: "localModulePath", ok: true });
  });

  it("the REAL module's real createEmbeddingProvider returns dims/model from its catalog with a stubbed session loader", async (ctx) => {
    if (!REAL_DIST_BUILT) {
      ctx.skip("packages/embedder-local/dist/index.js not built");
      return;
    }
    const resolution = await resolveLocalEmbedderModule({ localModulePath: REAL_DIST_ENTRY }, {});
    expect(resolution.ok).toBe(true);
    const stubExtractor = async (texts: string[]) => ({
      tolist: () => texts.map(() => [0.1, 0.2, 0.3]),
    });
    const stubLoadSession = async () => ({ extractor: stubExtractor });
    const provider = resolution.mod?.createEmbeddingProvider(
      { model: "all-MiniLM-L6-v2" },
      stubLoadSession as any,
    );
    expect(provider?.model).toBe("all-MiniLM-L6-v2");
    expect(provider?.dimensions).toBe(384);
    const vecs = await provider?.embed(["hello"]);
    expect(vecs).toEqual([[0.1, 0.2, 0.3]]);
  });
});

describe("buildLocalEmbeddingProvider", () => {
  it("returns the provider object SYNCHRONOUSLY — id/provider/model/dimensions from config alone, no resolveModule call yet", () => {
    let called = false;
    const resolveModule = async () => {
      called = true;
      return { ok: false as const, attempts: [], inSourceCheckout: false };
    };
    const provider = buildLocalEmbeddingProvider(BASE_CFG, TEST_CTX, resolveModule);
    expect(provider.provider).toBe("local");
    expect(provider.model).toBe("bge-small-en-v1.5");
    expect(provider.dimensions).toBe(384);
    // THE-1122 review: quantized folds into id — BASE_CFG leaves it unset, which defaults to q8
    // (true), same as the schema's own `.default(true)` and embedder-local's own internal default.
    expect(provider.id).toBe("local:bge-small-en-v1.5:q8");
    expect(called).toBe(false);
  });

  it("folds quantized: false into id as fp32, distinguishing it from the q8 default (THE-1122 review)", () => {
    const provider = buildLocalEmbeddingProvider(
      { ...BASE_CFG, quantized: false },
      TEST_CTX,
      async () => ({ ok: false as const, attempts: [], inSourceCheckout: false }),
    );
    expect(provider.id).toBe("local:bge-small-en-v1.5:fp32");
  });

  it("refuses a config that sets a field this provider does not read (baseUrl)", () => {
    expect(() =>
      buildLocalEmbeddingProvider({ ...BASE_CFG, baseUrl: "http://example.com" }, TEST_CTX),
    ).toThrow(/embeddings\.baseUrl/);
  });

  // THE-1122 review: root-cause fix for "obsidian-tc index writes model weights to CWD" — no
  // fallback, fail closed naming the config key, so a caller that forgot to thread cacheDir finds
  // out immediately (a thrown build() error) rather than silently scattering files wherever the
  // process happened to start (and potentially EACCES-crashing from an unwritable cwd like `/`).
  it("fails closed, naming the config key, when cacheDir is absent — no CWD-relative fallback", () => {
    expect(() => buildLocalEmbeddingProvider(BASE_CFG, {})).toThrow(/cacheDir/);
  });

  it("never writes outside the configured cacheDir, regardless of process cwd", async () => {
    const scratchCacheDir = mkdtempSync(join(tmpdir(), "obtc-embedder-cachedir-test-"));
    const elsewhereCwd = mkdtempSync(join(tmpdir(), "obtc-embedder-cwd-elsewhere-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(elsewhereCwd);
      const stubProvider = {
        id: "local:stub",
        model: "bge-small-en-v1.5",
        dimensions: 384,
        embed: async (texts: string[]) => texts.map(() => [1, 2, 3]),
      };
      const resolveModule = async () => ({
        ok: true as const,
        mod: { createEmbeddingProvider: () => stubProvider },
        attempts: [],
        inSourceCheckout: false,
      });
      const provider = buildLocalEmbeddingProvider(
        BASE_CFG,
        { cacheDir: scratchCacheDir },
        resolveModule,
      );
      await provider.embed(["a"]);
      // Nothing written under the cwd this process happened to be started from — every real file
      // a genuine (non-stubbed) resolution would write lands under scratchCacheDir instead.
      expect(readdirSync(elsewhereCwd)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      try {
        rmTemp(scratchCacheDir);
        rmTemp(elsewhereCwd);
      } catch (e) {
        console.warn("[embedder-local-resolution.test.ts] cleanup failed:", e);
      }
    }
  });

  it("embed() resolves through the injected module and returns its vectors", async () => {
    const stubProvider = {
      id: "local:stub",
      model: "bge-small-en-v1.5",
      dimensions: 384,
      embed: async (texts: string[]) => texts.map(() => [1, 2, 3]),
    };
    const resolveModule = async () => ({
      ok: true as const,
      mod: { createEmbeddingProvider: () => stubProvider },
      attempts: [],
      inSourceCheckout: false,
    });
    const provider = buildLocalEmbeddingProvider(BASE_CFG, TEST_CTX, resolveModule);
    const vecs = await provider.embed(["a", "b"]);
    expect(vecs).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });

  it("embed() rejects (never silently degrades) when resolution fails, naming the doctor remedy", async () => {
    const resolveModule = async () => ({
      ok: false as const,
      attempts: [{ route: "bare-specifier" as const, target: "x", ok: false, error: "boom" }],
      inSourceCheckout: false,
    });
    const provider = buildLocalEmbeddingProvider(BASE_CFG, TEST_CTX, resolveModule);
    await expect(provider.embed(["a"])).rejects.toThrow(/could not resolve/);
  });

  it("a failed resolution is NOT memoized — a later call that fixes the environment succeeds", async () => {
    let attempt = 0;
    const stubProvider = {
      id: "local:stub",
      model: "bge-small-en-v1.5",
      dimensions: 384,
      embed: async (texts: string[]) => texts.map(() => [9]),
    };
    const resolveModule = async () => {
      attempt++;
      if (attempt === 1) return { ok: false as const, attempts: [], inSourceCheckout: false };
      return {
        ok: true as const,
        mod: { createEmbeddingProvider: () => stubProvider },
        attempts: [],
        inSourceCheckout: false,
      };
    };
    const provider = buildLocalEmbeddingProvider(BASE_CFG, TEST_CTX, resolveModule);
    await expect(provider.embed(["a"])).rejects.toThrow();
    const vecs = await provider.embed(["a"]);
    expect(vecs).toEqual([[9]]);
  });
});
