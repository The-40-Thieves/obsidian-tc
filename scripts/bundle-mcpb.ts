// Pack obsidian-tc into a distributable MCPB bundle at dist/obsidian-tc.mcpb.
//
//   bun run bundle
//
// Ships the built server (packages/server/dist), the MCPB 0.3 manifest, and package
// metadata; honors .mcpbignore. The manifest is validated before packing, and the MCPB
// CLI version is pinned for reproducible output.
//
// THE-950: the repo-root manifest.json is now the companion plugin's Obsidian manifest (Obsidian's
// community-directory validator reads it from the repo's default branch, and it must live there —
// see docs/RELEASING.md). The MCPB bundle manifest that used to live at the repo root now lives at
// mcpb/manifest.json. `mcpb pack <dir>` always reads manifest.json from the root of the directory
// it packs and has no flag to point it elsewhere on the pinned CLI (`npx @anthropic-ai/mcpb@2.1.2
// pack --help` — no `--manifest` option; a newer/unreleased CLI.md documents one, but 2.1.2 is the
// latest version published to npm as of 2026-09). So the MCPB manifest is swapped onto the root
// manifest.json for the duration of the pack call only, then the plugin manifest is restored — in
// a try/finally so a failed pack never leaves the plugin's manifest.json overwritten on disk.
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const repoRoot = resolve(import.meta.dir, "..");
const serverEntry = join(repoRoot, "packages", "server", "dist", "cli.js");
const mcpbManifestPath = join(repoRoot, "mcpb", "manifest.json");
const rootManifestPath = join(repoRoot, "manifest.json");
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

// 2. Validate the MCPB manifest, swap it onto the bundle root (root manifest.json is the plugin's
// the rest of the time), pack, then restore the plugin manifest — always, even on a failed pack.
await mkdir(outDir, { recursive: true });
await $`npx -y ${MCPB} validate ${mcpbManifestPath}`.cwd(repoRoot);
const originalRootManifest = await readFile(rootManifestPath);
try {
  await writeFile(rootManifestPath, await readFile(mcpbManifestPath));
  await $`npx -y ${MCPB} pack ${repoRoot} ${outFile}`.cwd(repoRoot);
} finally {
  await writeFile(rootManifestPath, originalRootManifest);
}

// 3. Confirm the artifact exists and report its size.
if (!existsSync(outFile)) throw new Error(`bundle was not produced: ${outFile}`);
const sizeMb = (statSync(outFile).size / 1_048_576).toFixed(2);
console.log(`\n✓ packed ${outFile} (${sizeMb} MB)`);
