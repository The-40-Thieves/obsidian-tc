// Copy runtime SQL assets next to the bundled bin so dist/cli.js resolves them the same way it
// does from source (via new URL("./migrations/...", import.meta.url)), and vendor the companion
// plugin into dist/plugin/ so the `plugin install` CLI can write it into a vault.
import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
cpSync(join(root, "src", "migrations"), join(dist, "migrations"), { recursive: true });
cpSync(join(root, "src", "schema.sql"), join(dist, "schema.sql"));
console.log("copied SQL assets -> dist/");

// Make dist/cli.js a proper executable. `bun build` emits no shebang, so the published `bin`
// starts with `import{...}` and has none. npm's launcher shim only inserts the interpreter when it
// reads a shebang off the target, so without one the generated Windows `.ps1`/`.cmd` shims invoke
// the `.js` directly — Windows hands it to the file association (Script Host), which silently
// no-ops (exit 0, no output), so `obsidian-tc serve` appears to do nothing while `node dist/cli.js`
// works. Prepend `#!/usr/bin/env node` to cli.js only, shift the linked sourcemap down one line so
// stack traces stay accurate, and set the POSIX exec bit. Shell-agnostic (JS string, no shell
// path-mangling) and idempotent.
const cliPath = join(dist, "cli.js");
const cli = readFileSync(cliPath, "utf8");
if (!cli.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env node\n${cli}`);
  const mapPath = join(dist, "cli.js.map");
  if (existsSync(mapPath)) {
    const map = JSON.parse(readFileSync(mapPath, "utf8"));
    if (typeof map.mappings === "string") {
      map.mappings = `;${map.mappings}`; // one empty generated line for the prepended shebang
      writeFileSync(mapPath, JSON.stringify(map));
    }
  }
  try {
    chmodSync(cliPath, 0o755); // POSIX exec bit for direct invocation (npm also sets it on install)
  } catch {
    // non-POSIX filesystem (Windows): chmod unsupported / no-op — ignore.
  }
  console.log("prepended node shebang -> dist/cli.js");
}

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
  console.warn(
    `WARNING: could not vendor companion plugin (plugin install unavailable): ${e instanceof Error ? e.message : String(e)}`,
  );
}
