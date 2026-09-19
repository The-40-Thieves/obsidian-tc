// THE-1079 (GH #947): a regression guard against the BUILT BUNDLE specifically. Every other test
// covering the local-reranker resolution ladder (reranker-local-resolution.test.ts,
// reranker-auto-select.test.ts) imports registry.ts's exports directly, running under `bun` from
// `src/` — exactly the one location the old fixed `../../../` walk happened to land correctly from.
// It never caught that `packages/server/dist/cli.js` (one directory level shallower) computed a
// path missing its `packages/` segment entirely, so the doctor remedy it printed ("bun run build in
// packages/reranker-local") was a no-op for every stdio install: the resolver never looked in the
// place that command builds.
//
// Runs the REAL built `packages/server/dist/cli.js`, but relocated into a throwaway monorepo-shaped
// tree (`<stage>/fake-root/packages/{server/dist,reranker-local}`) rather than in place: the
// resolution ladder's upward walk is exercised exactly as the real bug reproduced it (three levels
// under `packages/`), while never touching the SHARED `packages/reranker-local/dist` that
// reranker-local-resolution.test.ts and reranker-auto-select.test.ts build and delete in their own
// beforeAll/afterAll — vitest runs test files in parallel, and racing a second builder against that
// same directory is exactly the hazard those files' own comments already document. reranker-local's
// package.json content is never read by the resolver (only `existsSync` on the path), so the fake
// root's copy is a placeholder; migrations are compiled into the bundle (db/migrations-embedded.ts)
// rather than read from `dist/migrations` at runtime, so nothing else needs copying alongside cli.js.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SHARED_DIR = join(REPO_ROOT, "packages", "shared");
const RERANKER_LOCAL_SRC = join(REPO_ROOT, "packages", "reranker-local");

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let stage: string;
let configPath: string;
let fakeCliJs: string;

describe.skipIf(!bunAvailable)(
  "doctor CLI (BUILT bundle) — local-reranker auto-select (THE-1079, GH #947/#949)",
  { timeout: 180_000 },
  () => {
    beforeAll(() => {
      stage = mkdtempSync(join(tmpdir(), "obtc-bundle-reranker-"));

      // 1) Build reranker-local in an ISOLATED copy of its source, never the shared
      // packages/reranker-local/dist — see the file header for why. Its tsconfig extends
      // "../../tsconfig.base.json", so the copy must sit two levels under a copy of that file too.
      const isolatedReranker = join(stage, "packages", "reranker-local");
      mkdirSync(isolatedReranker, { recursive: true });
      cpSync(join(REPO_ROOT, "tsconfig.base.json"), join(stage, "tsconfig.base.json"));
      for (const f of ["package.json", "tsconfig.json", "bun.lock"]) {
        cpSync(join(RERANKER_LOCAL_SRC, f), join(isolatedReranker, f));
      }
      cpSync(join(RERANKER_LOCAL_SRC, "src"), join(isolatedReranker, "src"), { recursive: true });
      execFileSync("bun", ["install", "--frozen-lockfile"], {
        cwd: isolatedReranker,
        stdio: "pipe",
      });
      execFileSync("bun", ["run", "build"], { cwd: isolatedReranker, stdio: "pipe" });
      const isolatedRerankerDist = join(isolatedReranker, "dist");
      expect(existsSync(join(isolatedRerankerDist, "index.js"))).toBe(true);

      // 2) Build packages/server for real, in place — nothing else contends this directory.
      // packages/shared must be built first (packages/server's bundler resolves it via its
      // package.json `main`, not source); packages/native needs no build: its checked-in index.js
      // falls back to pure JS with no .node present (G2.2 component 9).
      execFileSync("bun", ["run", "build"], { cwd: SHARED_DIR, stdio: "pipe" });
      execFileSync("bun", ["run", "build"], { cwd: SERVER_DIR, stdio: "pipe" });
      const realCliJs = join(SERVER_DIR, "dist", "cli.js");
      expect(existsSync(realCliJs)).toBe(true);

      // 3) Assemble the fake monorepo root: packages/server/dist/cli.js three levels under
      // packages/reranker-local/{package.json,dist/index.js} — the exact shape the real bug's
      // fixed-`../../../` walk got wrong from. Relocating the ALREADY-BUILT cli.js is what makes
      // this a genuine test of "wherever this module actually runs", not a repeat of the in-place
      // case route (iii) always happened to pass from source.
      const fakeRoot = join(stage, "fake-root");
      const fakeServerDist = join(fakeRoot, "packages", "server", "dist");
      const fakeReranker = join(fakeRoot, "packages", "reranker-local");
      mkdirSync(fakeServerDist, { recursive: true });
      cpSync(realCliJs, join(fakeServerDist, "cli.js"));
      // Anchor file: only `existsSync`-checked by the resolver, never parsed — content is moot.
      mkdirSync(fakeReranker, { recursive: true });
      writeFileSync(join(fakeReranker, "package.json"), "{}\n");
      // The WHOLE dist dir, not just index.js — it imports sibling model-fetch.js/model-info.js by
      // relative specifier.
      cpSync(isolatedRerankerDist, join(fakeReranker, "dist"), { recursive: true });
      fakeCliJs = join(fakeServerDist, "cli.js");

      configPath = join(stage, "config.json");
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            // No reranker block, no gateway URL, default `ollama` embeddings (no modelTier.full) —
            // exactly autoSelectLocalRerankerConfigAllows's "yes" case, on a supported platform
            // (this box is linux glibc): auto-select "local" is attempted at boot.
            vaults: [{ id: "smoke", path: join(stage, "vault") }],
            cacheDir: join(stage, "cache"),
          },
          null,
          2,
        )}\n`,
      );
    }, 180_000);

    afterAll(() => {
      // packages/shared and packages/server aren't shared with any other test's fixtures, but
      // clean up anyway to match the "leave no built dist lying around" convention.
      rmSync(join(SERVER_DIR, "dist"), { recursive: true, force: true });
      rmSync(join(SHARED_DIR, "dist"), { recursive: true, force: true });
      try {
        rmTemp(stage);
      } catch {
        // best effort
      }
    });

    it("bun is on PATH, so this suite is actually running", () => {
      expect(bunAvailable).toBe(true);
    });

    it("reranker.buildable resolves the auto-selected local reranker via source-checkout, from the BUILT dist/cli.js", () => {
      const r = spawnSync("bun", [fakeCliJs, "doctor", configPath, "--json"], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const report = JSON.parse(r.stdout) as {
        checks: Record<
          string,
          { status: string; summary: string; details?: Record<string, unknown> }
        >;
      };
      const check = report.checks["reranker.buildable"];
      expect(check, "doctor produced no reranker.buildable check").toBeTruthy();
      // The bug: from the built bundle, the ladder's source-checkout route probed a path missing
      // its `packages/` segment and could never find a build that genuinely exists on disk.
      expect(check?.status).toBe("ok");
      expect(check?.summary).toContain('auto-selected "local"');
      expect(check?.details?.route).toBe("source-checkout");
    });
  },
);
