import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  // Dev: resolve the shared workspace package to source (not built to dist in dev).
  resolve: { alias: { "@obsidian-tc/shared": resolve(here, "../shared/src/index.ts") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // node:sqlite is experimental on Node 22; inject the flag into worker processes.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
