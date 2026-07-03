// esbuild bundler for the obsidian-tc companion plugin. Produces dist/main.js (the
// single CommonJS bundle Obsidian loads) and copies manifest.json beside it. The
// Obsidian runtime, Electron, CodeMirror, and Node builtins are externalized — they
// are provided by the host app, not bundled. Run `node esbuild.config.mjs production`
// for a minified release build (CI), or with no arg for an unminified dev build.
import { copyFileSync, mkdirSync } from "node:fs";
import process from "node:process";
import builtins from "builtin-modules";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: "dist/main.js",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
});

copyFileSync("manifest.json", "dist/manifest.json");
// styles.css ships beside main.js so the plugin's community-store / BRAT 3-file set is complete
// (THE-206). Obsidian loads it automatically; it is committed (even if minimal) so this never misses.
copyFileSync("styles.css", "dist/styles.css");
