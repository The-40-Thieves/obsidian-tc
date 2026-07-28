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
  },
});
