#!/usr/bin/env node
// THE-705 — downloads the pinned cross-encoder weights into a GITIGNORED local dir
// (packages/reranker-local/models/), verifying each file's sha256 against src/model-info.ts before
// it is considered usable.
//
// WHY NOT COMMIT THE WEIGHTS: this repo has vault-leak and size hygiene conventions (see root
// CLAUDE.md) and keeps the diff reviewable — a 23 MB binary blob in a PR is neither. Instead this
// script is the reproducible, checksum-pinned substitute: run it once, get byte-identical files to
// what CI/tests expect, verified against the exact revision recorded in model-info.ts.
//
// Usage:
//   node scripts/fetch-model.mjs                 # download into ./models (default)
//   node scripts/fetch-model.mjs --dir <path>     # download elsewhere (matches reranker.localModelPath)
//   node scripts/fetch-model.mjs --check          # verify only, do not download; exit 1 if incomplete
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ID, MODEL_REVISION, PINNED_FILES } from "../src/model-info.ts";

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

async function sha256File(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function verify(modelDir) {
  const results = [];
  for (const f of PINNED_FILES) {
    const p = join(modelDir, f.path);
    if (!existsSync(p)) {
      results.push({ file: f, ok: false, reason: "missing" });
      continue;
    }
    const size = statSync(p).size;
    if (size !== f.sizeBytes) {
      results.push({ file: f, ok: false, reason: `size ${size} != expected ${f.sizeBytes}` });
      continue;
    }
    const digest = await sha256File(p);
    if (digest !== f.sha256) {
      results.push({ file: f, ok: false, reason: `sha256 ${digest} != expected ${f.sha256}` });
      continue;
    }
    results.push({ file: f, ok: true });
  }
  return results;
}

async function download(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  await new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    // node fetch's Response.body is a web ReadableStream; Readable.fromWeb bridges it, but to keep
    // this script's only dependency the Node std lib across the Node floor this repo supports, pipe
    // via the async iterator instead.
    (async () => {
      try {
        for await (const chunk of res.body) out.write(chunk);
        out.end();
      } catch (e) {
        reject(e);
      }
    })();
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

async function main() {
  const { dir, checkOnly } = parseArgs(process.argv.slice(2));
  const modelDir = join(dir, MODEL_ID);

  if (checkOnly) {
    const results = await verify(modelDir);
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
  for (const f of PINNED_FILES) {
    const dest = join(modelDir, f.path);
    const existing = await verify(modelDir);
    const already = existing.find((r) => r.file.path === f.path)?.ok;
    if (already) {
      console.log(`  ${f.path}: already present, verified`);
      continue;
    }
    const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${f.path}`;
    console.log(`  ${f.path}: downloading from ${url}`);
    await download(url, dest);
    const digest = await sha256File(dest);
    if (digest !== f.sha256) {
      await rm(dest, { force: true });
      throw new Error(
        `reranker-local: ${f.path} failed sha256 verification (got ${digest}, expected ${f.sha256}) — ` +
          "deleted the corrupt download. Re-run this script; if it fails again, the pinned revision " +
          "may have moved upstream (report as a bug, do not loosen the check).",
      );
    }
    console.log(`  ${f.path}: verified sha256 ${digest}`);
  }
  console.log(`reranker-local: done. ${PINNED_FILES.length} files verified in ${modelDir}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
