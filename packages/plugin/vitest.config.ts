import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // routes.ts imports `obsidian`, which resolves to a package that only functions inside the
      // Obsidian runtime. Aliasing it is what makes this package testable at all — without it the
      // import fails at module load and NO test in the package can run, which is how it ended up
      // with zero tests despite src/routes.ts being one of the largest files in the repo.
      obsidian: fileURLToPath(new URL("./test/__mocks__/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Matches packages/server: the box this repo is developed on has 4 cores shared with ~43
    // containers, and CI runners are dedicated. See packages/server/vitest.config.ts.
    maxWorkers: process.env.CI ? undefined : 2,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      // Honest exclude only: src/main.ts is the Obsidian `Plugin` subclass entrypoint — it
      // `extends Plugin` from the real `obsidian` package, which the test/__mocks__/obsidian.ts
      // stub above deliberately does NOT export (see that file's header). Importing it under
      // vitest fails at module load before any assertion runs, the same way routes.ts did before
      // the obsidian alias existed. It has no branch logic of its own beyond dispatching to
      // buildRoutes() (src/routes.ts, 100% covered) — it is a thin composition root exercised
      // manually against a real vault (THE-282), matching why packages/server excludes its own
      // entrypoints (src/index.ts, src/cli.ts).
      exclude: ["src/**/*.d.ts", "src/main.ts"],
      // THE-929: this is a RATCHET FLOOR against silent regression, not an aspirational target.
      // Measured on this commit (55 tests, packages/plugin, main.ts excluded per above):
      //   statements 50.52%  branches 26.9%  functions 87.32%  lines 55.2%
      // Branch coverage is genuinely low — most route-family handlers only unit-test the happy
      // path, not every plugin_missing/plugin_unreachable/invalid_input degrade branch (git.ts and
      // datacore.ts drag the average down hardest). Thresholds are floored to the nearest 10 below
      // the measured value on each dimension so the current suite passes with room, not to imply
      // this coverage is sufficient.
      thresholds: { lines: 50, statements: 50, functions: 80, branches: 20 },
    },
  },
});
