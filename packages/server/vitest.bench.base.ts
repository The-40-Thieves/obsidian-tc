import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import codspeedPlugin from "@codspeed/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// Shared by vitest.bench.config.ts (Simulation) and vitest.bench.walltime.config.ts (Walltime):
// the two differ only in which bench files they collect, and bench/instruments.ts says which files
// go where and why.
//
// Kept apart from vitest.config.ts on purpose: the benchmarks are pure, in-memory CPU work, so
// none of the test suite's tmp-guard / HOME-isolation setup files apply, and the CodSpeed plugin
// only instruments `vitest bench` runs. Outside a CodSpeed run the plugin is inert and
// `vitest bench` behaves like plain tinybench.
export function benchConfig(files: { include: string[]; exclude?: string[] }) {
  return defineConfig({
    plugins: [codspeedPlugin()],
    resolve: {
      alias: { "@the-40-thieves/obsidian-tc-shared": resolve(here, "../shared/src/index.ts") },
    },
    test: {
      environment: "node",
      benchmark: {
        include: files.include,
        ...(files.exclude ? { exclude: files.exclude } : {}),
        // The benchmarks import TypeScript source, so calls between src modules go through Vite's
        // module-runner export getters. That overhead is constant across runs, so it does not hide
        // regressions; the warning is silenced rather than printed on every run. Bench files bind
        // their hot-loop imports to locals to keep the overhead out of the bench bodies themselves.
        suppressExportGetterWarnings: true,
      },
    },
  });
}
