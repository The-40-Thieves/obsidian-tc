#!/usr/bin/env bun
// CLI wrapper around src/model-fetch.ts's shared download+verify+atomic-rename machinery, which
// the provider's own lazy loader (src/index.ts's loadSession) now ALSO calls, on the first
// embed() call, if the pinned weights are not already present. This script remains the manual /
// offline / CI alternative that machinery's own error message names when a fetch fails: run this
// once on a machine with network access, then ship or mount the resulting directory
// (`<dir>/<model-id>/<revision>/`) wherever `embeddings`'s model cache is expected — the runtime
// finds it already verified and never touches the network.
//
// BUN ONLY — same reason as packages/reranker-local's identical script: this file imports
// ../src/model-fetch.ts and ../src/model-info.ts by their .ts source paths, and model-fetch.ts
// itself imports "./model-info.js" (a TypeScript extension-rewrite convention bun's loader
// resolves to the sibling .ts file). Plain `node` does not rewrite that .js specifier to .ts.
//
// Usage:
//   bun scripts/fetch-model.mjs                        # download the default model into ./models
//   bun scripts/fetch-model.mjs --model all-MiniLM-L6-v2  # a different catalog entry
//   bun scripts/fetch-model.mjs --fp32                  # the full-precision variant (default: q8)
//   bun scripts/fetch-model.mjs --dir <path>            # download elsewhere
//   bun scripts/fetch-model.mjs --check                 # verify only; exit 1 if incomplete
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAndVerifyModel,
  modelDirFor,
  specFromModelInfo,
  verifyModelDir,
} from "../src/model-fetch.ts";
import { catalogModelNames, DEFAULT_MODEL_NAME, modelInfoByName } from "../src/model-info.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  let dir = join(PACKAGE_ROOT, "models");
  let checkOnly = false;
  let modelName = DEFAULT_MODEL_NAME;
  let quantized = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir = argv[++i];
    else if (argv[i] === "--check") checkOnly = true;
    else if (argv[i] === "--model") modelName = argv[++i];
    else if (argv[i] === "--fp32") quantized = false;
  }
  return { dir, checkOnly, modelName, quantized };
}

async function main() {
  const { dir, checkOnly, modelName, quantized } = parseArgs(process.argv.slice(2));
  const info = modelInfoByName(modelName);
  if (!info) {
    console.error(
      `embedder-local: unknown model "${modelName}" — supported: ${catalogModelNames().join(", ")}.`,
    );
    process.exitCode = 2;
    return;
  }
  const spec = specFromModelInfo(info, quantized);

  if (checkOnly) {
    const modelDir = modelDirFor(dir, spec);
    const results = await verifyModelDir(modelDir, spec);
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) {
      console.error(`embedder-local: ${bad.length}/${results.length} pinned files not verified:`);
      for (const r of bad) console.error(`  ${r.file.path}: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `embedder-local: all ${results.length} pinned files present and verified in ${modelDir}`,
    );
    return;
  }

  console.log(
    `embedder-local: fetching ${info.modelId}@${info.revision} (${quantized ? "q8" : "fp32"}) into ${dir}`,
  );
  const modelDir = await fetchAndVerifyModel(dir, spec);
  console.log(`embedder-local: done. all pinned files verified in ${modelDir}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
