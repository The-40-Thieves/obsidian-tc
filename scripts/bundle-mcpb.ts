// Pack obsidian-tc into a distributable MCPB bundle at dist/obsidian-tc.mcpb.
//
//   bun run bundle
//
// Ships the built server (packages/server/dist), the MCPB 0.3 manifest, and package
// metadata; honors .mcpbignore. The manifest is validated before packing, and the MCPB
// CLI version is pinned for reproducible output.
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const repoRoot = resolve(import.meta.dir, "..");
const serverEntry = join(repoRoot, "packages", "server", "dist", "cli.js");
const manifestPath = join(repoRoot, "manifest.json");
const outDir = join(repoRoot, "dist");
const outFile = join(outDir, "obsidian-tc.mcpb");

// 1. The bundle ships built dist/, not TypeScript sources — build it if it is missing.
if (!existsSync(serverEntry)) {
  console.log("server entry missing — building shared + server…");
  await $`bun run --filter=@the-40-thieves/obsidian-tc-shared --filter=obsidian-tc build`.cwd(
    repoRoot,
  );
}
if (!existsSync(serverEntry)) {
  throw new Error(`server entry not found after build: ${serverEntry}`);
}

// 2. Validate the manifest, then pack the directory (the CLI reads .mcpbignore).
await mkdir(outDir, { recursive: true });
await $`npx -y ${MCPB} validate ${manifestPath}`.cwd(repoRoot);
await $`npx -y ${MCPB} pack ${repoRoot} ${outFile}`.cwd(repoRoot);

// 3. Confirm the artifact exists and report its size.
if (!existsSync(outFile)) throw new Error(`bundle was not produced: ${outFile}`);
const sizeMb = (statSync(outFile).size / 1_048_576).toFixed(2);
console.log(`\n✓ packed ${outFile} (${sizeMb} MB)`);
