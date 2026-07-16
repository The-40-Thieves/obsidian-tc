// Copy runtime SQL assets next to the bundled bin so dist/cli.js resolves them the same way it
// does from source (via new URL("./migrations/...", import.meta.url)), and vendor the companion
// plugin into dist/plugin/ so the `plugin install` CLI can write it into a vault.
import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
cpSync(join(root, "src", "migrations"), join(dist, "migrations"), { recursive: true });
console.log("copied migration assets -> dist/");

// Vendor the agent onboarding guide. SKILLS.md lives at the repo root, which belongs to the
// unpublished `obsidian-tc-monorepo` package, and npm's `files` cannot reference paths outside
// the package directory — so copy it in at build time and let files:["SKILLS.md"] pick it up.
// Root stays the single source of truth; this copy is generated and gitignored.
const skillsSrc = join(root, "..", "..", "SKILLS.md");
if (existsSync(skillsSrc)) {
  cpSync(skillsSrc, join(root, "SKILLS.md"));
  console.log("copied SKILLS.md -> packages/server/");
} else {
  console.warn("WARNING: SKILLS.md not found at repo root — package will ship without it");
}

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
const vendorDir = join(dist, "plugin");
try {
  const pluginDir = join(root, "..", "plugin");
  const pluginDist = join(pluginDir, "dist");

  // ALWAYS rebuild. This previously built only when dist/main.js was ABSENT, so a stale build left
  // over from before a version bump was vendored verbatim: v1.9.1 shipped a 1.7.0 companion with CI
  // green. check-version-coherence.mjs cannot catch that — it asserts packages/plugin/manifest.json
  // (the SOURCE, which was correctly 1.9.1); nothing asserted the build output. The build is ~40ms,
  // so unconditionally rebuilding is cheaper than the class of bug it removes.
  console.log("building companion plugin...");
  execSync("node esbuild.config.mjs production", { cwd: pluginDir, stdio: "inherit" });

  mkdirSync(vendorDir, { recursive: true });
  cpSync(join(pluginDist, "main.js"), join(vendorDir, "main.js"));
  cpSync(join(pluginDist, "manifest.json"), join(vendorDir, "manifest.json"));

  // Build-output counterpart to check-version-coherence.mjs's source assert: the artifact actually
  // entering the tarball must carry the repo version. The plugin is in repo-version lockstep
  // (decision 2026-07-02), so any mismatch here means the build did not take.
  const vendored = JSON.parse(readFileSync(join(vendorDir, "manifest.json"), "utf8")).version;
  const serverVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (vendored !== serverVersion) {
    throw new Error(
      `vendored plugin is ${vendored} but the server package is ${serverVersion} — refusing to ship a mismatched companion`,
    );
  }
  console.log(`vendored companion plugin ${vendored} -> dist/plugin/`);
} catch (e) {
  // Best-effort by design: a plugin-build failure must not break the server build/tests. But it must
  // never leave a stale or mismatched plugin behind to be published — drop the vendor dir so
  // `plugin install` honestly reports the plugin as unavailable instead of silently shipping wrong.
  rmSync(vendorDir, { recursive: true, force: true });
  console.warn(
    `WARNING: could not vendor companion plugin (plugin install unavailable): ${e instanceof Error ? e.message : String(e)}`,
  );
}
