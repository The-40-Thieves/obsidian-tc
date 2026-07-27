import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  // Dev: resolve the shared workspace package to source (not built to dist in dev).
  resolve: {
    alias: { "@the-40-thieves/obsidian-tc-shared": resolve(here, "../shared/src/index.ts") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Worker cap OUTSIDE CI. Vitest defaults maxWorkers to available parallelism, i.e. one worker
    // per core — which is right on a dedicated runner and wrong on a shared dev host. This repo is
    // developed on a 4-core box that also runs ~43 containers, Falco, and a remote desktop, so
    // roughly 0.8 cores are committed before a suite starts. One unbounded run saturates it; two
    // concurrent runs (parallel agents, or a suite next to the perf harness) oversubscribe it.
    //
    // That is not hypothetical: THE-503 measured a perf run overlapping the vitest suite reading
    // throughput 51% low and dispatch p99 at 16ms vs 1ms isolated — and the gate still passed,
    // because latency there is warn-only. Oversubscription corrupts measurements before it fails
    // anything.
    //
    // CI keeps full parallelism: a GitHub runner is dedicated, and capping there would slow every
    // PR for no reason. `undefined` restores vitest's own default rather than guessing a number.
    //
    // This bounds ONE process. It cannot bound two agents each starting a capped run — that needs
    // the lock in scripts/with-host-budget.sh, which is what `bun run test:local` uses.
    maxWorkers: process.env.CI ? undefined : 2,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      // Honest excludes only: type-only files, the composition root + barrel (exercised via the
      // integration suites, not unit), the runtime DB adapters (bun-sqlite is covered by the
      // separate bun-smoke runner; better-sqlite3 is the runtime adapter — vitest runs on
      // node:sqlite), and the stdio transport entrypoint. None hold unit-testable branch logic.
      exclude: [
        "src/**/*.d.ts",
        "src/index.ts",
        "src/cli.ts",
        "src/db/types.ts",
        "src/db/bun-sqlite.ts",
        "src/db/node-better-sqlite3.ts",
        "src/transports/stdio.ts",
      ],
      // THE-602: vitest 4 made AST-aware branch remapping mandatory (the
      // experimentalAstAwareRemapping flag is gone), which changed the denominators — statements
      // counted fell 27,824 -> 12,679. Same tests, same source, same thresholds, different (more
      // accurate) measurement:
      //   vitest 3.2.6:  statements 91.16%  branches 81.26%  functions 90.11%  lines 91.16%
      //   vitest 4.1.10: statements 87.30%  branches 75.49%  functions 88.79%  lines 89.11%
      // Branch coverage did not regress under the upgrade — 81.26% was inflated by counting
      // constructs the new remapping correctly excludes. 75.49% was the honest number and always
      // was, which left the 75% floor only 0.49 points from binding (THE-602). Real tests then
      // raised branch coverage of the M0-M6 tool handlers' defensive error paths to ~81% (measured
      // here on this commit), restoring the ~6-point margin the vitest-3-era numbers implied.
      // Statement/function/line coverage sits ~88-90%, comfortably above 80. These are real
      // measures on both bases — no coverage theater.
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 75 },
    },
  },
});
