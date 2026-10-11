#!/usr/bin/env node
/**
 * #1231 — root `build` warning for the two optional local packages.
 *
 * `packages/embedder-local` and `packages/reranker-local` sit outside the root workspace on purpose:
 * their runtime (`@huggingface/transformers`, which pulls in `onnxruntime-node`) is ~230 MB, and a
 * root install would pay that on every checkout (see packages/reranker-local/README.md, "Why this
 * package is NOT a root workspace member"). So a root `bun install` + `bun run build` never builds
 * them, and the default `local` embeddings provider and local reranker stay unavailable until the
 * per-package steps run. This prints that gap. It never fails the build: a missing optional build
 * is advice, not an error.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LOCAL_PACKAGES = [
  {
    name: "@the-40-thieves/obsidian-tc-embedder-local",
    dir: "packages/embedder-local",
    needed: 'the default embeddings.provider "local" (dense search and indexing)',
  },
  {
    name: "@the-40-thieves/obsidian-tc-reranker-local",
    dir: "packages/reranker-local",
    needed: "the default local reranker (auto-selected when no reranker or gateway is configured)",
  },
];

/** Resolves the way the server does: from packages/server, so an npm-installed copy counts too. */
function serverResolves(root, name) {
  try {
    createRequire(join(root, "packages", "server", "package.json")).resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/** Pure given its inputs. A package is ready when its source build exists in this checkout, or when
 *  the server can resolve it (an installed copy). Anything else is unbuilt. */
export function findUnbuiltLocalPackages({
  root = ROOT,
  resolvesFromServer = (name) => serverResolves(root, name),
} = {}) {
  return LOCAL_PACKAGES.filter(
    (pkg) => !existsSync(join(root, pkg.dir, "dist", "index.js")) && !resolvesFromServer(pkg.name),
  );
}

/** The warning text, or "" when nothing is unbuilt. Names the exact commands to run. */
export function formatUnbuiltWarning(unbuilt) {
  if (unbuilt.length === 0) return "";
  const lines = [
    "warning: optional local packages are not built, so their default providers are unavailable on this checkout.",
  ];
  for (const pkg of unbuilt) {
    lines.push(`  - ${pkg.dir} is needed for ${pkg.needed}. Build it with:`);
    lines.push(`      cd ${pkg.dir} && bun install && bun run build`);
  }
  lines.push(
    "This warning does not fail the build. Run the commands above, then re-run `bun run build` to clear it.",
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const message = formatUnbuiltWarning(findUnbuiltLocalPackages());
  if (message !== "") process.stderr.write(message);
  // Always exit 0 (no process.exitCode set): see the header for why this never fails the build.
}

// Importing this module (as its test file does) must have no side effects. Only run when this file
// is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
