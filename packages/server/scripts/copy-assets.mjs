// Copy runtime SQL assets next to the bundled bin so dist/cli.js resolves them the same way it
// does from source (via new URL("./migrations/...", import.meta.url)), and vendor the companion
// plugin into dist/plugin/ so the `plugin install` CLI can write it into a vault.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
cpSync(join(root, "src", "migrations"), join(dist, "migrations"), { recursive: true });
cpSync(join(root, "src", "schema.sql"), join(dist, "schema.sql"));
console.log("copied SQL assets -> dist/");

// Vendor the companion plugin (main.js + manifest.json). The monorepo's parallel
// `build --filter='*'` gives no ordering guarantee, so build the plugin here if it is missing.
// Best-effort: a plugin-build failure must not break the server build/tests — `plugin install`
// then reports at runtime that the plugin was not vendored.
try {
  const pluginDir = join(root, "..", "plugin");
  const pluginDist = join(pluginDir, "dist");
  if (!existsSync(join(pluginDist, "main.js")) || !existsSync(join(pluginDist, "manifest.json"))) {
    console.log("building companion plugin...");
    execSync("node esbuild.config.mjs production", { cwd: pluginDir, stdio: "inherit" });
  }
  mkdirSync(join(dist, "plugin"), { recursive: true });
  cpSync(join(pluginDist, "main.js"), join(dist, "plugin", "main.js"));
  cpSync(join(pluginDist, "manifest.json"), join(dist, "plugin", "manifest.json"));
  console.log("vendored companion plugin -> dist/plugin/");
} catch (e) {
  console.warn(`WARNING: could not vendor companion plugin (plugin install unavailable): ${e.message}`);
}
