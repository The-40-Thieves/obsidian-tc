// esbuild bundler for the FINAL `obsidian-tc` release (THE-943 rename sunset build). Mirrors
// ../esbuild.config.mjs (same externals, same production/dev switch) but with its own
// entry/outdir so it never collides with the renamed plugin's own dist/. Run from
// packages/plugin: `node legacy/esbuild.config.mjs production` for the release build CI uses
// (.github/workflows/publish.yml, build-plugin job) — there is no `bun run` script for this;
// it exists solely for that one release-time step, not the day-to-day dev loop.
import { copyFileSync, mkdirSync } from "node:fs";
import process from "node:process";
import builtins from "builtin-modules";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

mkdirSync("legacy/dist", { recursive: true });

await esbuild.build({
  entryPoints: ["legacy/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: "legacy/dist/main.js",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
});

copyFileSync("legacy/manifest.json", "legacy/dist/manifest.json");
copyFileSync("legacy/styles.css", "legacy/dist/styles.css");
