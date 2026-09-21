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
//   - the "local unresolvable" case is proven with an INJECTED resolver that always fails —
//     `wireGatewaySeams`'s own `resolveLocalReranker` param exists exactly for this (see its doc
//     comment in tool-wiring.ts: "a test that needs a DETERMINISTIC 'local never resolves' ...
//     should inject a stub here instead of depending on ambient filesystem state"), never proven by
//     deleting a real build to force the outcome;
//   - most "local resolves" cases are proven against a throwaway copy staged and built under this
//     file's own mkdtempSync root, injected the same way;
//   - the "via the real source-checkout route" case is the one INHERENTLY tied to the real, fixed
//     path (registry.ts's default, un-injected `resolveLocalRerankerModule` — see
//     reranker-local-resolution.test.ts's header for why it cannot be redirected). Skipping it
//     whenever the real dist happened to be absent (this ticket's first cut) meant it never ran on
//     CI at all. It now reuses the real dist read-only when present, or builds it in place and
//     LEAVES it otherwise (doctor-cli-bundle-reranker-resolution.test.ts's own rule for
//     packages/shared/dist) — never deleted, either way.
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveLocalRerankerModule } from "../src/providers/registry";
import type { ProviderDescriptor, ResolveContext } from "../src/providers/types";
import { wireGatewaySeams } from "../src/runtime/tool-wiring";
import {
  buildStagedRerankerLocal,
  ensureRealRerankerLocalDist,
  stageRerankerLocalSource,
} from "./reranker-local-stage";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const RERANKER_LOCAL_DIR = join(HERE, "..", "..", "reranker-local");
const REAL_DIST_ENTRY = join(RERANKER_LOCAL_DIR, "dist", "index.js");

// Read-only observation, taken before anything below runs (this file never DELETES
// REAL_DIST_ENTRY, though it may build into it — see "via the real source-checkout route" below) —
// backs the regression guard in the outer afterAll.
const REAL_DIST_EXISTED_AT_START = existsSync(REAL_DIST_ENTRY);
const REAL_DIST_MTIME_AT_START = REAL_DIST_EXISTED_AT_START
  ? statSync(REAL_DIST_ENTRY).mtimeMs
  : undefined;

/** Always fails, deterministically — the injected substitute for "local is unresolvable", per this
 *  file's header. */
const resolveLocalRerankerAlwaysFails = async () => ({ ok: false as const, attempts: [] });

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
  // the real checkout: if it already had a build, that build must be BYTE-IDENTICAL afterward (this
  // file never deletes or rebuilds an existing one); if it didn't, this file may have built one
  // itself (see the "via the real source-checkout route" describe below) and LEFT it — that build
  // must still be there, but there is no prior mtime to compare it against.
  afterAll(() => {
    if (REAL_DIST_EXISTED_AT_START) {
      expect(existsSync(REAL_DIST_ENTRY)).toBe(true);
      expect(statSync(REAL_DIST_ENTRY).mtimeMs).toBe(REAL_DIST_MTIME_AT_START);
    } else {
      expect(existsSync(REAL_DIST_ENTRY)).toBe(true);
    }
  });

  describe("local unresolvable (injected — no real dist involved either way)", () => {
    it("no model-tier, no gateway, local unresolvable -> reranker stays null (RRF-only), unchanged", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const { reranker } = await wireGatewaySeams(
        ollamaEmbeddings(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resolveLocalRerankerAlwaysFails,
      );
      expect(reranker).toBeNull();
    });
  });

  // Reuses the real dist read-only if it's there, else builds it in place (behind a lock) and
  // leaves it — see file header and ./reranker-local-stage.ts's own comment on why this ONE case
  // cannot use a staged copy instead.
  describe("via the real source-checkout route (against the REAL checkout)", () => {
    beforeAll(async () => {
      await ensureRealRerankerLocalDist(RERANKER_LOCAL_DIR);
    }, 180_000);

    it("no model-tier, no gateway -> auto-selects 'local' via the real source-checkout route", async () => {
      delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      const { reranker } = await wireGatewaySeams(ollamaEmbeddings());
      expect(reranker).not.toBeNull();
      expect(typeof reranker).toBe("function");
    });
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
      try {
        rmTemp(stageRoot);
      } catch {
        // best effort
      }
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
