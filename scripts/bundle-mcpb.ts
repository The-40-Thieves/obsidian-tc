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
// pack --help` — no `--manifest` option; re-checked for THE-951, still true on 2.1.2, the latest
// published to npm as of 2026-09). THE-951: packing therefore happens from a throwaway staging
// directory (scripts/lib/mcpb-staging.mjs) that carries the MCPB manifest as its own manifest.json
// — the live tree is never written to except `outFile` itself. The previous approach swapped the
// MCPB manifest onto the live root manifest.json for the duration of the pack call and restored it
// in a `finally`, which was not kill-safe: a process killed between the swap and the restore left
// the plugin's manifest.json permanently overwritten on disk (reproduced with `kill -9` by the
// THE-950 review).
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { embedderBundlePlugin, ORT_PLATFORMS, ortNativeFiles } from "./lib/embedder-bundle.mjs";
import { packFromStaging, stageRuntimeModules } from "./lib/mcpb-staging.mjs";
import { fetchVerifiedNpmPackage } from "./lib/npm-tarball.mjs";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const repoRoot = resolve(import.meta.dir, "..");
const serverEntry = join(repoRoot, "packages", "server", "dist", "cli.js");
const mcpbManifestPath = join(repoRoot, "mcpb", "manifest.json");
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

// 2. The bundle's node_modules: sqlite-vec (every platform's vec0) and the bundled local embedder.
// packages/embedder-local is its own install root, so it is installed and built here when it is not.
const embedderDir = join(repoRoot, "packages", "embedder-local");
const ortNodeDir = join(embedderDir, "node_modules", "onnxruntime-node");
if (!existsSync(join(embedderDir, "dist", "index.js")) || !existsSync(ortNodeDir)) {
  console.log("embedder-local not installed/built — installing + building…");
  await $`bun install --frozen-lockfile`.cwd(embedderDir);
  await $`bun run build`.cwd(embedderDir);
}
const embedderVersion = JSON.parse(readFileSync(join(embedderDir, "package.json"), "utf8")).version;
const vecDir = join(repoRoot, "packages", "server", "node_modules", "sqlite-vec");
const vecManifest = JSON.parse(readFileSync(join(vecDir, "package.json"), "utf8"));
const scratch = await mkdtemp(join(tmpdir(), "obtc-mcpb-modules-"));

// 3. Validate the MCPB manifest, then stage the bundle inputs into a throwaway directory and pack
// from there — see scripts/lib/mcpb-staging.mjs for why. The staging directory is always removed,
// success or failure.
try {
  await mkdir(outDir, { recursive: true });
  await $`npx -y ${MCPB} validate ${mcpbManifestPath}`.cwd(repoRoot);

  const bundled = await Bun.build({
    entrypoints: [join(embedderDir, "dist", "index.js")],
    outdir: scratch,
    naming: "embedder.mjs",
    target: "node",
    format: "esm",
    minify: true,
    plugins: [embedderBundlePlugin()],
  });
  if (!bundled.success) {
    for (const log of bundled.logs) console.error(String(log));
    throw new Error("bundling the local embedder failed");
  }
  // One sqlite-vec platform package per entry in its own optionalDependencies, fetched from the
  // registry (and integrity-checked) because the host install only has its own.
  const platformPackages = await Promise.all(
    Object.entries(vecManifest.optionalDependencies as Record<string, string>).map(
      async ([name, version]) => ({
        name,
        dir: await fetchVerifiedNpmPackage(name, version, (m) => console.log(`sqlite-vec: ${m}`)),
      }),
    ),
  );
  try {
    await packFromStaging(repoRoot, outFile, {
      populate: (stagingDir) =>
        stageRuntimeModules(stagingDir, {
          sqliteVec: { dir: vecDir, platformPackages },
          embedder: {
            version: embedderVersion,
            bundleFile: join(scratch, "embedder.mjs"),
            ortFiles: Object.fromEntries(
              Object.keys(ORT_PLATFORMS).map((key) => [key, ortNativeFiles(ortNodeDir, key)]),
            ),
          },
        }),
      pack: (stagingDir, out) => $`npx -y ${MCPB} pack ${stagingDir} ${out}`.cwd(repoRoot),
    });
  } finally {
    await Promise.all(
      platformPackages.map((p) => rm(dirname(p.dir), { recursive: true, force: true })),
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// 4. Confirm the artifact exists and report its size.
if (!existsSync(outFile)) throw new Error(`bundle was not produced: ${outFile}`);
const sizeMb = (statSync(outFile).size / 1_048_576).toFixed(2);
console.log(`\n✓ packed ${outFile} (${sizeMb} MB)`);
