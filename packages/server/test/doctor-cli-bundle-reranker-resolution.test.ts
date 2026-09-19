// THE-1079 (GH #947): a regression guard against the BUILT BUNDLE specifically. Every other test
// covering the local-reranker resolution ladder (reranker-local-resolution.test.ts,
// reranker-auto-select.test.ts) imports registry.ts's exports directly, running under `bun` from
// `src/` — exactly the one location the old fixed `../../../` walk happened to land correctly from.
// It never caught that `packages/server/dist/cli.js` (one directory level shallower) computed a
// path missing its `packages/` segment entirely, so the doctor remedy it printed ("bun run build in
// packages/reranker-local") was a no-op for every stdio install: the resolver never looked in the
// place that command builds.
//
// Runs a REAL built cli.js, but assembled into a throwaway monorepo-shaped tree
// (`<stage>/fake-root/packages/{server/dist,reranker-local}`) rather than in place: the resolution
// ladder's upward walk is exercised exactly as the real bug reproduced it (three levels under
// packages/), while never touching the SHARED `packages/reranker-local/dist` that
// reranker-local-resolution.test.ts and reranker-auto-select.test.ts build and delete in their own
// beforeAll/afterAll — vitest runs test files in parallel, and racing a second builder against that
// same directory is exactly the hazard those files' own comments already document.
//
// Cross-vendor review hardening: this file used to `bun run build` packages/server IN PLACE (real
// packages/server/dist) and unconditionally `rm -rf` it in cleanup — clobbering a developer's own
// build and racing anything else that touches that path. packages/server's own bundle step needs no
// package.json `main` resolution for ITS OWN output, so it can target a private `--outdir` directly
// (bypassing `bun run build` — replicated here without the copy-assets.mjs step, which only vendors
// migrations/plugin assets this test never needs: migrations are compiled into the bundle via
// db/migrations-embedded.ts, not read from `dist/migrations` at runtime). packages/shared has no
// such escape hatch — bun's bundler resolves `@the-40-thieves/obsidian-tc-shared` via ITS OWN
// package.json `main` (`./dist/index.js`), a path fixed relative to that package's real directory,
// so its dist MUST exist there for packages/server to bundle at all.
//
// Round 2 review fix: an earlier version RENAMED a pre-existing packages/shared/dist aside and
// restored it in afterAll with no try/finally — killed between the rename and afterAll (SIGKILL,
// OOM, or the 180s hook budget expiring; the isolated reranker-local `bun install` above runs
// FIRST and can eat most of that budget) and the developer's real dist is stranded under the
// backup name, with a rerun then building a fresh one and afterAll deleting it, restoring nothing.
// Fixed by never renaming the real dist at all: if it already exists, USE it as-is (this test only
// needs shared's `main` entry to resolve for bundling; vitest.config.ts separately aliases shared
// to source for everything else, so a stale-but-present dist is fine here); if absent, build it in
// place and LEAVE it — a built dist is the normal state of a checkout, not test debris to clean up.
// `reclaimStrandedSharedDistBackups` self-heals a tree already damaged by the old version.
// reranker-local's `package.json` content is never read by the resolver's fallback branch (only
// `existsSync`), but the real ladder's PRIMARY anchor check now reads `name` (THE-1079 hardening) —
// see `writeAnchor` below, which writes the real name. Its own isolated `bun install` runs
// `--ignore-scripts`: this build needs no lifecycle scripts (`build` is plain `tsc`, invoked
// explicitly afterward), so there is no reason to run any.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SHARED_DIR = join(REPO_ROOT, "packages", "shared");
const SHARED_DIST = join(SHARED_DIR, "dist");
const RERANKER_LOCAL_SRC = join(REPO_ROOT, "packages", "reranker-local");
const REAL_RERANKER_LOCAL_NAME = "@the-40-thieves/obsidian-tc-reranker-local";
const SHARED_DIST_BACKUP_PREFIX = "dist.obtc-bundle-test-backup-";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let stage: string;
let configPath: string;
let fakeCliJs: string;

/** Self-heals a tree damaged by an earlier version of this test that renamed the real dist aside
 *  and could be killed before restoring it (see the file header). Any leftover backup found on
 *  start either IS the developer's real dist (nothing has replaced it since) — rename it back — or
 *  a real dist already exists (a since-completed run rebuilt one) — the backup is then a stale
 *  orphan, safe to delete. */
function reclaimStrandedSharedDistBackups(): void {
  for (const name of readdirSync(SHARED_DIR)) {
    if (!name.startsWith(SHARED_DIST_BACKUP_PREFIX)) continue;
    const backup = join(SHARED_DIR, name);
    if (existsSync(SHARED_DIST)) {
      rmSync(backup, { recursive: true, force: true });
    } else {
      renameSync(backup, SHARED_DIST);
    }
  }
}

describe.skipIf(!bunAvailable)(
  "doctor CLI (BUILT bundle) — local-reranker auto-select (THE-1079, GH #947/#949)",
  { timeout: 180_000 },
  () => {
    beforeAll(() => {
      stage = mkdtempSync(join(tmpdir(), "obtc-bundle-reranker-"));
      reclaimStrandedSharedDistBackups();

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
      // --ignore-scripts: this build needs no lifecycle script — "build" is plain `tsc`, run
      // explicitly below — so there is no reason to execute any package's install hooks.
      execFileSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
        cwd: isolatedReranker,
        stdio: "pipe",
      });
      execFileSync("bun", ["run", "build"], { cwd: isolatedReranker, stdio: "pipe" });
      const isolatedRerankerDist = join(isolatedReranker, "dist");
      expect(existsSync(join(isolatedRerankerDist, "index.js"))).toBe(true);

      // 2) packages/shared: bun's bundler resolves it via ITS OWN package.json `main`
      // (./dist/index.js, fixed relative to packages/shared itself) — there is no `--outdir` that
      // redirects a DEPENDENCY's own resolution, so this is the one directory this test cannot
      // avoid touching. NEVER rename a pre-existing dist aside (see file header) — reuse it as-is
      // when present; only build (and only then LEAVE it — a built dist is the normal state of a
      // checkout) when absent.
      if (!existsSync(join(SHARED_DIST, "index.js"))) {
        execFileSync("bun", ["run", "build"], { cwd: SHARED_DIR, stdio: "pipe" });
      }
      expect(existsSync(join(SHARED_DIST, "index.js"))).toBe(true);

      // 3) packages/server: build straight into a PRIVATE outdir under `stage`, bypassing
      // `bun run build` (which hardcodes `--outdir ./dist`) so the real packages/server/dist is
      // never touched at all. Only cli.ts — this test never needs the MCP server entry (index.ts)
      // or copy-assets.mjs's migrations/plugin vendoring (see file header).
      const privateServerDist = join(stage, "server-dist");
      execFileSync(
        "bun",
        [
          "build",
          "./src/cli.ts",
          "--outdir",
          privateServerDist,
          "--target",
          "node",
          "--external",
          "better-sqlite3",
          "--external",
          REAL_RERANKER_LOCAL_NAME,
          "--minify",
        ],
        { cwd: SERVER_DIR, stdio: "pipe" },
      );
      const realCliJs = join(privateServerDist, "cli.js");
      expect(existsSync(realCliJs)).toBe(true);

      // 4) Assemble the fake monorepo root: packages/server/dist/cli.js three levels under
      // packages/reranker-local/{package.json,dist/index.js} — the exact shape the real bug's
      // fixed-`../../../` walk got wrong from. Relocating the ALREADY-BUILT cli.js is what makes
      // this a genuine test of "wherever this module actually runs", not a repeat of the in-place
      // case route (iii) always happened to pass from source.
      const fakeRoot = join(stage, "fake-root");
      const fakeServerDist = join(fakeRoot, "packages", "server", "dist");
      const fakeReranker = join(fakeRoot, "packages", "reranker-local");
      mkdirSync(fakeServerDist, { recursive: true });
      cpSync(realCliJs, join(fakeServerDist, "cli.js"));
      mkdirSync(fakeReranker, { recursive: true });
      // THE-1079 hardening: the anchor's `name` field is now actually READ and checked, so this
      // must be the real package name, not an inert placeholder.
      writeFileSync(
        join(fakeReranker, "package.json"),
        `${JSON.stringify({ name: REAL_RERANKER_LOCAL_NAME })}\n`,
      );
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
      // packages/shared/dist is left alone, whether it pre-existed or we just built it — a built
      // dist is the normal state of a checkout, not test debris (see file header for why this test
      // used to delete it, and why that was wrong). packages/server/dist was never touched at all
      // (built into a private outdir instead).
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

      // GH #949, asserted against the BUILT bundle too (not just the source-level unit test in
      // doctor-checks.test.ts): retrieval.heads must reflect the SAME resolved auto-select in this
      // SAME run, not still read RRF-only — a bundler/minify slip dropping the threaded
      // `autoSelectLocalRerankerResolved` field would silently pass the reranker.buildable
      // assertion above but fail here.
      const heads = report.checks["retrieval.heads"];
      expect(heads, "doctor produced no retrieval.heads check").toBeTruthy();
      expect(heads?.details?.reranker).toContain("auto-select resolved the local reranker module");
      expect(heads?.details?.reranker).not.toContain("RRF-only");
    });
  },
);
