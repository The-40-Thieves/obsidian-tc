// THE-944: auto-select the bundled "local" cross-encoder as the LAST fallback in the ABSENT-block
// default precedence — model-tier ?? gateway ?? local — gated on no gateway URL being configured
// (the same condition "gateway yields null" already means). This file owns building a REAL,
// tsc-built copy of packages/reranker-local, same pattern and same isolation reasoning as
// test/reranker-local-resolution.test.ts: never relying on ambient repo state or cross-test-file
// ordering for whether the optional package resolves.
//
// GH #958 / THE-1085: this file used to build (and unconditionally `rm -rf`) the REAL
// `packages/reranker-local/dist` in place — see reranker-local-resolution.test.ts's header for the
// full incident. It no longer deletes that real directory, and only ever builds into it behind a
// cross-process lock (see ./reranker-local-stage.ts):
//
//   - GH #958 review round 2 (P1, finding 1): the "local unresolvable" case is proven with the REAL,
//     unmodified `resolveLocalRerankerModule` ladder ("the default resolver") wired through
//     `wireGatewaySeams`'s own `resolveLocalReranker` injection seam, but with its terminal import
//     step forced to fail — so it exercises the real ladder's integration code while staying fully
//     independent of whatever the real `packages/reranker-local/dist` currently holds (built and
//     left by the "via the real source-checkout route" describe below, possibly concurrently, in a
//     separate vitest worker process — file-local declaration order cannot coordinate across those);
//   - most "local resolves" cases are proven against a throwaway copy staged and built under this
//     file's own mkdtempSync root, injected the same way;
//   - the "via the real source-checkout route" case is the one INHERENTLY tied to the real, fixed
//     path (registry.ts's default, un-injected `resolveLocalRerankerModule` — see
//     reranker-local-resolution.test.ts's header for why it cannot be redirected). It reuses the
//     real dist read-only when present, or builds it in place and LEAVES it otherwise
//     (doctor-cli-bundle-reranker-resolution.test.ts's own rule for packages/shared/dist) — never
//     deleted, either way. If the real `dist/` exists but is PARTIAL (present directory, missing
//     `index.js`), this case is skipped rather than risking `tsc` mixing its output with whatever is
//     already there.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveLocalRerankerModule,
  resolveSourceCheckoutLocalRerankerPath,
} from "../src/providers/registry";
import type { ProviderDescriptor, ResolveContext } from "../src/providers/types";
import { wireGatewaySeams } from "../src/runtime/tool-wiring";
import {
  buildStagedRerankerLocal,
  cleanupTempRoot,
  type EnsureRealRerankerLocalDistResult,
  ensureRealRerankerLocalDist,
  snapshotDistTree,
  stageRerankerLocalSource,
  writeRerankerLocalAnchorOnly,
} from "./reranker-local-stage";

const HERE = dirname(fileURLToPath(import.meta.url));
const RERANKER_LOCAL_DIR = join(HERE, "..", "..", "reranker-local");
const REAL_DIST_DIR = join(RERANKER_LOCAL_DIR, "dist");
const REAL_DIST_ENTRY = join(REAL_DIST_DIR, "index.js");

// Read-only observation, taken before anything below runs (this file never DELETES the real dist,
// though it may build into it — see "via the real source-checkout route" below) — backs the
// regression guard in the outer afterAll (GH #958 review round 2, finding 4: a whole-tree snapshot,
// not just one file's mtime).
const REAL_DIST_EXISTED_AT_START = existsSync(REAL_DIST_ENTRY);
const REAL_DIST_SNAPSHOT_AT_START = REAL_DIST_EXISTED_AT_START
  ? snapshotDistTree(REAL_DIST_DIR)
  : undefined;

// Set only by the "via the real source-checkout route" describe below, and only when IT actually
// built the real dist — GH #958 review round 2, finding 3.
let builtRealDistThisRun = false;

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
  // GH #958 / THE-1085 regression guard. Two shapes, matching the two ways this file may have left
  // the real checkout: if it already had a build, the WHOLE tree must be byte-for-byte unchanged
  // afterward (this file never deletes or rebuilds an existing one); if it didn't, and this run
  // built one itself (see the "via the real source-checkout route" describe below), that build must
  // still be there (no prior snapshot to compare against). If neither — absent at start, and
  // nothing in this run built it (a filtered run) — there is nothing to assert.
  afterAll(() => {
    if (REAL_DIST_EXISTED_AT_START) {
      expect(snapshotDistTree(REAL_DIST_DIR)).toEqual(REAL_DIST_SNAPSHOT_AT_START);
    } else if (builtRealDistThisRun) {
      expect(existsSync(REAL_DIST_ENTRY)).toBe(true);
    }
  });

  describe("local unresolvable — independent of the real checkout", () => {
    it("no model-tier, no gateway, local unresolvable -> reranker stays null (RRF-only), unchanged", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;

      // Staged anchor-only tree (no dist) — proves resolveSourceCheckoutLocalRerankerPath's own
      // walk behaves correctly, independent of the real checkout (GH #958 review round 2, findings
      // 1 and 5).
      const anchorRoot = mkdtempSync(join(tmpdir(), "obtc-reranker-auto-select-unbuilt-"));
      try {
        const startDir = writeRerankerLocalAnchorOnly(anchorRoot);
        const sourceCheckout = resolveSourceCheckoutLocalRerankerPath(startDir);
        expect(sourceCheckout.skippedReason).toBeUndefined();
        expect(existsSync(sourceCheckout.path)).toBe(false);
      } finally {
        cleanupTempRoot(anchorRoot, "reranker-auto-select.test.ts");
      }

      // The REAL, unmodified resolveLocalRerankerModule ladder ("the default resolver"), with only
      // its terminal import step forced to fail — genuinely exercises the ladder's integration code
      // (existsSync checks, route ordering, attempt bookkeeping) while staying deterministic
      // regardless of whatever the real packages/reranker-local/dist currently holds (built and
      // left by the "via the real source-checkout route" describe below, possibly concurrently).
      const alwaysFailImport = async () => {
        throw new Error("injected (GH #958 negative case): unresolvable");
      };
      const resolveDefaultButUnresolvable = (c: ProviderDescriptor, ctx: ResolveContext) =>
        resolveLocalRerankerModule(c, ctx, alwaysFailImport);

      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveDefaultButUnresolvable,
      );
      expect(reranker).toBeNull();
    });
  });

  // Reuses the real dist read-only if it's there, else builds it in place (behind a lock) and
  // leaves it, or skips outright if a partial build is already sitting there — see file header and
  // ./reranker-local-stage.ts's own comment on why this ONE case cannot use a staged copy instead.
  describe("via the real source-checkout route (against the REAL checkout)", () => {
    it("no model-tier, no gateway -> auto-selects 'local' via the real source-checkout route", async (ctx) => {
      const ensured: EnsureRealRerankerLocalDistResult =
        await ensureRealRerankerLocalDist(RERANKER_LOCAL_DIR);
      if (ensured.status === "partial") {
        ctx.skip(
          `packages/reranker-local/dist exists but index.js is missing (a partial build already ` +
            `sitting there) — refusing to build into it: ${ensured.distDir}`,
        );
        return;
      }
      builtRealDistThisRun = ensured.built;

      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const { reranker } = await wireGatewaySeams(ollamaEmbeddings());
      expect(reranker).not.toBeNull();
      expect(typeof reranker).toBe("function");
    }, 450_000);
  });

  describe("once packages/reranker-local is built (a staged, throwaway copy)", () => {
    let stageRoot: string;
    let stagedDistEntry: string;
    let resolveStagedLocalReranker: (
      c: ProviderDescriptor,
      ctx: ResolveContext,
    ) => ReturnType<typeof resolveLocalRerankerModule>;

    beforeAll(() => {
      // Unique per file: reranker-local-resolution.test.ts stages its OWN copy under its own root,
      // so the two can run in parallel without racing each other (unlike the real dist they both
      // used to share).
      stageRoot = mkdtempSync(join(tmpdir(), "obtc-reranker-auto-select-"));
      const stagedPkg = stageRerankerLocalSource(RERANKER_LOCAL_DIR, stageRoot);
      stagedDistEntry = buildStagedRerankerLocal(stagedPkg);
      expect(existsSync(stagedDistEntry)).toBe(true);
      resolveStagedLocalReranker = (c, ctx) =>
        resolveLocalRerankerModule({ ...c, localModulePath: stagedDistEntry }, ctx);
    }, 180_000);

    afterAll(() => {
      cleanupTempRoot(stageRoot, "reranker-auto-select.test.ts");
    });

    it("no model-tier, no gateway -> auto-selects 'local' (staged package, injected resolver)", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveStagedLocalReranker,
      );
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
      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveStagedLocalReranker,
      );
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
      const { reranker } = await wireGatewaySeams(
        modelTierEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveStagedLocalReranker,
      );
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
      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        rerankerCfg,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveStagedLocalReranker,
      );
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
