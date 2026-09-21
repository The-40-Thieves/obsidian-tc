// GH #958 / THE-1085: reranker-local-resolution.test.ts and reranker-auto-select.test.ts both need
// a REAL, `tsc`-built copy of packages/reranker-local to exercise the resolution ladder's
// non-stubbed mechanics (a stub resolver is what let the original THE-705/THE-944 bugs ship
// unnoticed — see those files' own headers). They used to build that copy IN PLACE, in the real
// `packages/reranker-local/dist` — a developer's own build, unconditionally `rm -rf`'d in
// beforeAll/afterAll, and racy besides: vitest runs test files in parallel, and both files touched
// the same directory.
//
// This helper stages a throwaway copy of the package's SOURCE (no node_modules, no dist — the
// "unbuilt checkout" shape) under a caller-supplied temp root instead, and builds it there with the
// exact same commands the original in-place tests used. Each caller passes its own
// `mkdtempSync`-generated root, so two files staging in parallel can never collide.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Copies just what `tsc` needs to build packages/reranker-local — package.json, bun.lock (for
 *  `--frozen-lockfile`), tsconfig.json, and src/ — into `<stageRoot>/packages/reranker-local`,
 *  alongside the repo-root tsconfig.base.json its tsconfig extends via `../../tsconfig.base.json`
 *  (preserving that same relative nesting depth under `stageRoot`). Returns the staged package's
 *  directory. */
export function stageRerankerLocalSource(realRerankerLocalDir: string, stageRoot: string): string {
  const stagedPkg = join(stageRoot, "packages", "reranker-local");
  mkdirSync(stagedPkg, { recursive: true });
  for (const name of ["package.json", "bun.lock", "tsconfig.json"]) {
    cpSync(join(realRerankerLocalDir, name), join(stagedPkg, name));
  }
  cpSync(join(realRerankerLocalDir, "src"), join(stagedPkg, "src"), { recursive: true });
  cpSync(
    join(realRerankerLocalDir, "..", "..", "tsconfig.base.json"),
    join(stageRoot, "tsconfig.base.json"),
  );
  return stagedPkg;
}

/** `bun install --frozen-lockfile && bun run build` — the same two commands the original in-place
 *  tests ran, just pointed at the staged copy. Returns the built entry file's absolute path. */
export function buildStagedRerankerLocal(stagedPkg: string): string {
  execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: stagedPkg, stdio: "pipe" });
  execFileSync("bun", ["run", "build"], { cwd: stagedPkg, stdio: "pipe" });
  return join(stagedPkg, "dist", "index.js");
}
