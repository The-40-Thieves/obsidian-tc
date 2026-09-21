// THE-705 round 2 (adversarial review, confirmed finding 1 + required fix 3): a REAL success-path
// test for the "local" reranker's resolution ladder — every other reranker-related test in this
// suite injects a stub resolver, which is exactly what let the first cut's dead "bun add ..." advice
// ship unnoticed (the real resolution path was never exercised). This file owns building a REAL
// tsc-built copy of packages/reranker-local (small/fast — no model weights involved) and proves
// BOTH halves in one deterministic sequence:
//
//   1. the ladder degrades cleanly — `ok: false`, and `resolveReranker`/`buildLocalReranker` return
//      `null`, never throw — when nothing resolves.
//   2. once built, the SAME registry entry point (`resolveReranker`) returns a working `Reranker`,
//      reached via route (iii)'s automatic source-checkout fallback AND via an explicit
//      `localModulePath` override (route (i), same mechanics), with a STUBBED inference pipeline
//      (no @huggingface/transformers import, no model weights) — proving the real module's real
//      exported `createReranker` wiring (tokenize -> model -> rank) works end-to-end.
//
// GH #958 / THE-1085: this file used to build (and unconditionally `rm -rf`) the REAL
// `packages/reranker-local/dist` — a developer's own build, destroyed by simply running `bun run
// test` after following the doctor remedy from #947/THE-1079. It never deletes that real directory
// anymore, and only ever builds into it behind a cross-process lock (see ./reranker-local-stage.ts):
//
//   - GH #958 review round 2 (P1, finding 1): the "not built yet" case used to be gated on the real
//     dist's absence at collection time (`it.skipIf`) — but vitest runs test FILES in separate
//     worker processes, and reranker-auto-select.test.ts's "route (iii)" describe may be building
//     and LEAVING the real dist at the exact moment this file's own negative case runs. File-local
//     declaration order cannot coordinate across processes. This case is now fully INDEPENDENT of
//     the real checkout: it stages its own anchor-only tree (no dist) for
//     `resolveSourceCheckoutLocalRerankerPath`'s injectable `startDir`, and forces
//     `resolveLocalRerankerModule`'s terminal import step to fail via its own injectable
//     `importModule` param — so the outcome never depends on what the real dist currently holds;
//   - the "automatic route (iii), no config at all" case is the one assertion INHERENTLY tied to
//     that real, fixed path (registry.ts computes `SOURCE_CHECKOUT_LOCAL_RERANKER_PATH` once, from
//     ITS OWN real `import.meta.url` — there is no per-call override). It reuses the real dist
//     read-only when present, or builds it in place and LEAVES it otherwise
//     (doctor-cli-bundle-reranker-resolution.test.ts's own rule for packages/shared/dist) — never
//     deleted, either way. If the real `dist/` exists but is PARTIAL (present directory, missing
//     `index.js` — a developer's own killed/in-progress build), this case is skipped rather than
//     risking `tsc` mixing its output with whatever is already there (finding 4);
//   - every other "once built" assertion runs unconditionally, against a throwaway copy staged and
//     built under this file's own `mkdtempSync` root — proving the same route (i) "localModulePath"
//     mechanics without ever touching the real checkout.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveLocalRerankerModule,
  resolveReranker,
  resolveSourceCheckoutLocalRerankerPath,
} from "../src/providers/registry";
import {
  buildStagedRerankerLocal,
  type EnsureRealRerankerLocalDistResult,
  ensureRealRerankerLocalDist,
  snapshotDistTree,
  stageRerankerLocalSource,
  writeRerankerLocalAnchorOnly,
} from "./reranker-local-stage";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const RERANKER_LOCAL_DIR = join(HERE, "..", "..", "reranker-local");
const REAL_DIST_DIR = join(RERANKER_LOCAL_DIR, "dist");
const REAL_DIST_ENTRY = join(REAL_DIST_DIR, "index.js");

// Read-only observation, taken before anything below runs (this file never DELETES the real dist,
// though it may build into it — see the "route (iii)" describe below) — backs the regression guard
// in the outer afterAll (GH #958 review round 2, finding 4: a whole-tree snapshot, not just one
// file's mtime).
const REAL_DIST_EXISTED_AT_START = existsSync(REAL_DIST_ENTRY);
const REAL_DIST_SNAPSHOT_AT_START = REAL_DIST_EXISTED_AT_START
  ? snapshotDistTree(REAL_DIST_DIR)
  : undefined;

// Set only by the "route (iii)" describe below, and only when IT actually built the real dist —
// GH #958 review round 2, finding 3: a filtered run (e.g. `-t 'fails cleanly'`) that never executes
// that describe at all must not then fail the outer guard for demanding a dist nothing in this run
// produced.
let builtRealDistThisRun = false;

describe("local reranker — REAL resolution ladder (THE-705 round 2)", () => {
  // GH #958 / THE-1085 regression guard. Two shapes, matching the two ways this file may have left
  // the real checkout: if it already had a build, the WHOLE tree must be byte-for-byte unchanged
  // afterward (this file never deletes or rebuilds an existing one); if it didn't, and this run
  // built one itself, that build must still be there (no prior snapshot to compare against). If
  // neither — absent at start, and nothing in this run built it (a filtered run) — there is nothing
  // to assert.
  afterAll(() => {
    if (REAL_DIST_EXISTED_AT_START) {
      expect(snapshotDistTree(REAL_DIST_DIR)).toEqual(REAL_DIST_SNAPSHOT_AT_START);
    } else if (builtRealDistThisRun) {
      expect(existsSync(REAL_DIST_ENTRY)).toBe(true);
    }
  });

  it("fails cleanly — never throws — when the package cannot be resolved anywhere packages/server looks", async () => {
    // Independent of the real checkout's on-disk state (see file header) — stages its own
    // anchor-only tree (no dist) for the source-checkout PATH computation, and forces every import
    // attempt to fail for the LADDER's outcome, so this never races (or is raced by) the "route
    // (iii)" describe below building and leaving the real dist.
    const anchorRoot = mkdtempSync(join(tmpdir(), "obtc-reranker-local-unbuilt-"));
    try {
      const startDir = writeRerankerLocalAnchorOnly(anchorRoot);
      const sourceCheckout = resolveSourceCheckoutLocalRerankerPath(startDir);
      expect(sourceCheckout.skippedReason).toBeUndefined();
      expect(sourceCheckout.candidates.length).toBeGreaterThan(0);
      expect(existsSync(sourceCheckout.path)).toBe(false);

      // The REAL, unmodified resolveLocalRerankerModule ladder ("the default resolver") — only its
      // terminal import step is forced to fail, via the injectable `importModule` param it already
      // exposes for exactly this. This still exercises the real ladder's integration code
      // (bare-specifier attempt, the real fixed source-checkout path's existsSync check, attempt
      // bookkeeping), while the OUTCOME stays deterministic regardless of whether the real
      // packages/reranker-local/dist currently exists (built-and-left by a concurrently running
      // sibling file, or not).
      const alwaysFailImport = async () => {
        throw new Error("injected (GH #958 negative case): unresolvable");
      };
      const resolution = await resolveLocalRerankerModule(
        { provider: "local" },
        {},
        alwaysFailImport,
      );
      expect(resolution.ok).toBe(false);
      expect(resolution.attempts.some((a) => a.route === "bare-specifier" && a.ok === false)).toBe(
        true,
      );
      expect(resolution.attempts.some((a) => a.route === "source-checkout" && a.ok === false)).toBe(
        true,
      );

      // The actual registry entry point every other provider goes through — must degrade the same
      // way, never throw. Injected the SAME way, via the test-only `ctx.resolveLocalRerankerModule`
      // seam `RERANKERS.local.build` forwards (registry.ts) — the only injection point
      // `resolveReranker` itself exposes.
      const alwaysFailResolveModule = async () => ({ ok: false as const, attempts: [] });
      const reranker = await resolveReranker(
        { provider: "local" },
        { resolveLocalRerankerModule: alwaysFailResolveModule },
      );
      expect(reranker).toBeNull();
    } finally {
      // Best-effort (ast-grep no-mkdtemp-without-teardown): a cleanup that throws must never fail
      // the suite in teardown when every assertion above passed.
      try {
        rmTemp(anchorRoot);
      } catch (e) {
        console.warn(
          `[reranker-local-resolution.test.ts] failed to clean up temp dir ${anchorRoot}:`,
          e,
        );
      }
    }
  });

  // The one case inherently tied to the REAL, fixed checkout path — reuses it read-only if it's
  // there, else builds it in place (behind a lock) and leaves it, or skips outright if a partial
  // build is already sitting there. See file header and ./reranker-local-stage.ts's own comment on
  // why this ONE case cannot use a staged copy instead.
  describe("route (iii): automatic source-checkout fallback against the REAL checkout", () => {
    it("resolves via the automatic source-checkout fallback (route iii) with no config at all", async (ctx) => {
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

      const resolution = await resolveLocalRerankerModule({ provider: "local" }, {});
      expect(resolution.ok).toBe(true);
      const succeeded = resolution.attempts.find((a) => a.ok);
      expect(succeeded?.route).toBe("source-checkout");
      expect(typeof resolution.mod?.createReranker).toBe("function");
    }, 450_000);
  });

  describe("once packages/reranker-local is built (a staged, throwaway copy)", () => {
    let stageRoot: string;
    let stagedDistEntry: string;

    beforeAll(() => {
      // Unique per file: reranker-auto-select.test.ts stages its OWN copy under its own root, so
      // the two can run in parallel without racing each other (unlike the real dist they both used
      // to share).
      stageRoot = mkdtempSync(join(tmpdir(), "obtc-reranker-local-resolution-"));
      const stagedPkg = stageRerankerLocalSource(RERANKER_LOCAL_DIR, stageRoot);
      stagedDistEntry = buildStagedRerankerLocal(stagedPkg);
      expect(existsSync(stagedDistEntry)).toBe(true);
    }, 180_000);

    afterAll(() => {
      try {
        rmTemp(stageRoot);
      } catch (e) {
        console.warn(
          `[reranker-local-resolution.test.ts] failed to clean up temp dir ${stageRoot}:`,
          e,
        );
      }
    });

    it("resolves via an explicit localModulePath override (route i) — same mechanics as route iii, pointed elsewhere", async () => {
      const resolution = await resolveLocalRerankerModule(
        { provider: "local", localModulePath: stagedDistEntry },
        {},
      );
      expect(resolution.ok).toBe(true);
      expect(resolution.attempts[0]).toMatchObject({ route: "localModulePath", ok: true });
    });

    it("returns a WORKING Reranker through the real module, with a STUBBED inference pipeline — no transformers, no weights", async () => {
      const resolution = await resolveLocalRerankerModule(
        { provider: "local", localModulePath: stagedDistEntry },
        {},
      );
      expect(resolution.ok).toBe(true);

      // The real package's real createReranker, exercising its real tokenize -> model -> rank
      // wiring — only the SESSION LOADER is stubbed, so this never imports @huggingface/transformers
      // and never touches model weights. logits: doc1 most relevant, doc2 next, doc0 least.
      const stubLoadSession = async (_localModelPath: string) => ({
        tokenizer: (queries: string[], _opts: unknown) => ({ batch: queries.length }),
        model: async (_inputs: unknown) => ({ logits: { data: [-1, 4, 0] } }),
      });
      const reranker = resolution.mod?.createReranker({}, stubLoadSession);
      expect(typeof reranker).toBe("function");

      const hits = await reranker?.("what is a vault", ["doc a", "doc b", "doc c"], 0, []);
      expect(hits?.map((h) => h.index)).toEqual([1, 2, 0]);
      expect(hits?.[0]?.relevanceScore).toBeGreaterThan(hits?.[1]?.relevanceScore ?? 1);
    });

    it("resolveReranker (the real boot call site) returns a working reranker for a declared 'local' block", async () => {
      const reranker = await resolveReranker(
        { provider: "local", localModulePath: stagedDistEntry },
        {},
      );
      expect(typeof reranker).toBe("function");
    });
  });
});
