// THE-705 round 2 (adversarial review, confirmed finding 1 + required fix 3): a REAL success-path
// test for the "local" reranker's resolution ladder — every other reranker-related test in this
// suite injects a stub resolver, which is exactly what let the first cut's dead "bun add ..." advice
// ship unnoticed (the real resolution path was never exercised). This file owns building
// packages/reranker-local's dist (small/fast — `tsc`, no model weights involved) and proves BOTH
// halves in one deterministic, ordered sequence within a single file (never relying on ambient
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
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalRerankerModule, resolveReranker } from "../src/providers/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const RERANKER_LOCAL_DIR = join(HERE, "..", "..", "reranker-local");
const DIST_DIR = join(RERANKER_LOCAL_DIR, "dist");
const DIST_ENTRY = join(DIST_DIR, "index.js");

describe("local reranker — REAL resolution ladder (THE-705 round 2)", () => {
  beforeAll(() => {
    // Clean slate: this suite is the one place that gets to assume dist's presence/absence, rather
    // than trusting whatever a prior local `bun run build` or another process left behind.
    rmSync(DIST_DIR, { recursive: true, force: true });
  });

  it("fails cleanly — never throws — before the package is built or installed anywhere packages/server resolves", async () => {
    expect(existsSync(DIST_ENTRY)).toBe(false);

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
      // Don't leave a built artifact lying around for other test files to accidentally depend on —
      // packages/server/test/reranker-slot-wiring.test.ts's "wireGatewaySeams ... degrades" test
      // asserts the OPPOSITE (unresolvable) and must not become order-dependent on this file.
      rmSync(DIST_DIR, { recursive: true, force: true });
    });

    it("resolves via the automatic source-checkout fallback (route iii) with no config at all", async () => {
      const resolution = await resolveLocalRerankerModule({ provider: "local" }, {});
      expect(resolution.ok).toBe(true);
      const succeeded = resolution.attempts.find((a) => a.ok);
      expect(succeeded?.route).toBe("source-checkout");
      expect(typeof resolution.mod?.createReranker).toBe("function");
    });

    it("resolves via an explicit localModulePath override (route i) — same mechanics as route iii, pointed elsewhere", async () => {
      const resolution = await resolveLocalRerankerModule(
        { provider: "local", localModulePath: DIST_ENTRY },
        {},
      );
      expect(resolution.ok).toBe(true);
      expect(resolution.attempts[0]).toMatchObject({ route: "localModulePath", ok: true });
    });

    it("returns a WORKING Reranker through the real module, with a STUBBED inference pipeline — no transformers, no weights", async () => {
      const resolution = await resolveLocalRerankerModule(
        { provider: "local", localModulePath: DIST_ENTRY },
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

      const hits = await reranker?.("what is a vault", ["doc a", "doc b", "doc c"], 0);
      expect(hits?.map((h) => h.index)).toEqual([1, 2, 0]);
      expect(hits?.[0]?.relevanceScore).toBeGreaterThan(hits?.[1]?.relevanceScore ?? 1);
    });

    it("resolveReranker (the real boot call site) returns a working reranker for a declared 'local' block", async () => {
      const reranker = await resolveReranker(
        { provider: "local", localModulePath: DIST_ENTRY },
        {},
      );
      expect(typeof reranker).toBe("function");
    });
  });
});
