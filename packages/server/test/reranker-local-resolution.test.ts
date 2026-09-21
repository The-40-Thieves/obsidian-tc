// THE-705 round 2 (adversarial review, confirmed finding 1 + required fix 3): a REAL success-path
// test for the "local" reranker's resolution ladder — every other reranker-related test in this
// suite injects a stub resolver, which is exactly what let the first cut's dead "bun add ..." advice
// ship unnoticed (the real resolution path was never exercised). This file owns building a REAL
// tsc-built copy of packages/reranker-local (small/fast — no model weights involved) and proves
// BOTH halves in one deterministic, ordered sequence within a single file (never relying on ambient
// repo state or cross-test-file ordering, which the ladder's filesystem-sensitive route (iii) makes
// a real hazard otherwise):
//
//   1. before the package is built anywhere packages/server can see it, resolution fails cleanly —
//      `ok: false`, and `resolveReranker`/`buildLocalReranker` return `null`, never throw.
//   2. once built, the SAME registry entry point (`resolveReranker`) returns a working `Reranker`,
//      reached via route (iii)'s automatic source-checkout fallback AND via an explicit
//      `localModulePath` override (route (i), same mechanics), with a STUBBED inference pipeline
//      (no @huggingface/transformers import, no model weights) — proving the real module's real
//      exported `createReranker` wiring (tokenize -> model -> rank) works end-to-end.
//
// GH #958 / THE-1085: this file used to build (and unconditionally `rm -rf`) the REAL
// `packages/reranker-local/dist` — a developer's own build, destroyed by simply running `bun run
// test` after following the doctor remedy from #947/THE-1079. It never builds into, reads as
// authoritative, or deletes that real directory anymore:
//
//   - the "not built yet" half below can only be proven true without touching anything real, so it
//     only runs when the real dist ALREADY doesn't exist (never forced by deleting it);
//   - the "automatic route (iii), no config at all" case is the one assertion that is INHERENTLY
//     tied to that real, fixed path (registry.ts computes `SOURCE_CHECKOUT_LOCAL_RERANKER_PATH`
//     once, from ITS OWN real `import.meta.url` — there is no per-call override), so it only runs
//     when the real dist ALREADY exists, reusing it strictly read-only;
//   - every other "once built" assertion runs unconditionally, against a throwaway copy staged and
//     built under this file's own `mkdtempSync` root (see ./reranker-local-stage.ts) — proving the
//     same route (i) "localModulePath" mechanics without ever touching the real checkout.
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalRerankerModule, resolveReranker } from "../src/providers/registry";
import { buildStagedRerankerLocal, stageRerankerLocalSource } from "./reranker-local-stage";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const RERANKER_LOCAL_DIR = join(HERE, "..", "..", "reranker-local");
const REAL_DIST_ENTRY = join(RERANKER_LOCAL_DIR, "dist", "index.js");

// Read-only observation, taken before anything below runs (nothing in this file ever builds into,
// or deletes, REAL_DIST_ENTRY) — drives which real-path-dependent case can run without touching it,
// and backs the regression guard in the outer afterAll.
const REAL_DIST_EXISTED_AT_START = existsSync(REAL_DIST_ENTRY);
const REAL_DIST_MTIME_AT_START = REAL_DIST_EXISTED_AT_START
  ? statSync(REAL_DIST_ENTRY).mtimeMs
  : undefined;

describe("local reranker — REAL resolution ladder (THE-705 round 2)", () => {
  // GH #958 / THE-1085 regression guard: proves the real checkout is untouched by this suite,
  // whichever branches above happened to run.
  afterAll(() => {
    expect(existsSync(REAL_DIST_ENTRY)).toBe(REAL_DIST_EXISTED_AT_START);
    if (REAL_DIST_EXISTED_AT_START) {
      expect(statSync(REAL_DIST_ENTRY).mtimeMs).toBe(REAL_DIST_MTIME_AT_START);
    }
  });

  // Can only be proven without mutating the real checkout when it is ALREADY unbuilt — see file
  // header. When a developer (or a prior `bun run build` in packages/reranker-local) has already
  // built it, this case is skipped rather than deleting that build to force it.
  it.skipIf(REAL_DIST_EXISTED_AT_START)(
    "fails cleanly — never throws — before the package is built or installed anywhere packages/server resolves",
    async () => {
      expect(existsSync(REAL_DIST_ENTRY)).toBe(false);

      const resolution = await resolveLocalRerankerModule({ provider: "local" }, {});
      expect(resolution.ok).toBe(false);
      expect(resolution.attempts.some((a) => a.route === "bare-specifier" && a.ok === false)).toBe(
        true,
      );
      expect(resolution.attempts.some((a) => a.route === "source-checkout" && a.ok === false)).toBe(
        true,
      );

      // The actual registry entry point every other provider goes through — must degrade the same
      // way, never throw. This is the exact call site that hard-crashed boot before this fix.
      const reranker = await resolveReranker({ provider: "local" }, {});
      expect(reranker).toBeNull();
    },
  );

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
      } catch {
        // best effort
      }
    });

    // Only meaningful when the real dist already existed BEFORE this file touched anything (strict
    // read-only reuse, per file header) — route (iii) always targets that real, fixed path, and this
    // file never builds one there itself.
    it.skipIf(!REAL_DIST_EXISTED_AT_START)(
      "resolves via the automatic source-checkout fallback (route iii) with no config at all",
      async () => {
        const resolution = await resolveLocalRerankerModule({ provider: "local" }, {});
        expect(resolution.ok).toBe(true);
        const succeeded = resolution.attempts.find((a) => a.ok);
        expect(succeeded?.route).toBe("source-checkout");
        expect(typeof resolution.mod?.createReranker).toBe("function");
      },
    );

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
