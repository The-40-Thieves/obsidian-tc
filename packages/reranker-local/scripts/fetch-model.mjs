#!/usr/bin/env node
// THE-705 / THE-944 — CLI wrapper around src/model-fetch.ts's shared download+verify+atomic-rename
// machinery, which the provider's own lazy loader (src/index.ts's loadSession) now ALSO calls, on
// the first rerank() call, if the pinned weights are not already present. This script remains the
// manual / offline / CI alternative that machinery's own error message names when a fetch fails:
// run this once on a machine with network access, then ship or mount the resulting directory
// (`<dir>/<model-id>/<revision>/`) wherever `reranker.localModelPath` points — the runtime finds it
// already verified and never touches the network.
//
// Usage:
//   node scripts/fetch-model.mjs                 # download into ./models (default)
//   node scripts/fetch-model.mjs --dir <path>     # download elsewhere (matches reranker.localModelPath)
//   node scripts/fetch-model.mjs --check          # verify only, do not download; exit 1 if incomplete
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAndVerifyModel, modelDirFor, verifyModelDir } from "../src/model-fetch.ts";
import { MODEL_ID, MODEL_REVISION } from "../src/model-info.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  let dir = join(PACKAGE_ROOT, "models");
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir = argv[++i];
    else if (argv[i] === "--check") checkOnly = true;
  }
  return { dir, checkOnly };
}

async function main() {
  const { dir, checkOnly } = parseArgs(process.argv.slice(2));
  const modelDir = modelDirFor(dir);

  if (checkOnly) {
    const results = await verifyModelDir(modelDir);
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) {
      console.error(`reranker-local: ${bad.length}/${results.length} pinned files not verified:`);
      for (const r of bad) console.error(`  ${r.file.path}: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `reranker-local: all ${results.length} pinned files present and verified in ${modelDir}`,
    );
    return;
  }

  console.log(`reranker-local: fetching ${MODEL_ID}@${MODEL_REVISION} into ${modelDir}`);
  await fetchAndVerifyModel(dir);
  console.log(`reranker-local: done. all pinned files verified in ${modelDir}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
