#!/usr/bin/env node
/**
 * GH #1161 — one owner for the pinned embedder identity.
 *
 * packages/embedder-local/src/model-info.ts declares each catalog model's HF repo, revision,
 * width, pooling and per-file sha256. packages/server/eval/modal_embed_nomic.py (a Modal GPU batch
 * embedder) must run the SAME pinned graph, or its vectors are wrong in a way only an eval notices.
 * Rather than let the Python restate those values and hope, it READS
 * packages/server/eval/embedder-model-pins.json, which this script derives from model-info.ts.
 * Two things can then drift, and this gate refuses both:
 *
 *   1. the committed JSON no longer equals what model-info.ts produces (a pin was bumped and the
 *      artifact not regenerated) — fix with `node scripts/check-model-pins.mjs --write`;
 *   2. a Python file under eval/ restates a pinned value (a catalog repo id, revision or sha256) as
 *      a literal, which is a second copy nothing keeps in step.
 *
 * Floor: an empty catalog, an unreadable JSON, or zero scanned Python files is a failure, never a
 * silent pass.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MODEL_INFO_FILE = "packages/embedder-local/src/model-info.ts";
export const PINS_FILE = "packages/server/eval/embedder-model-pins.json";
export const PY_DIR = "packages/server/eval";
/** The Python scripts that embed with a catalog model. modal_rerank_gte.py pins a reranker, which
 *  reranker-local owns; it is out of this gate's scope and carries a revision of its own. */
export const PY_EMBEDDER_RE = /^modal_embed_.*\.py$/;

/** Shape of the committed artifact. Plain data derived from model-info.ts, nothing else. */
export function buildPins(catalog, pinnedFilesFor, dtypeFor) {
  const models = {};
  for (const info of catalog) {
    const variant = (quantized) => ({
      dtype: dtypeFor(info, quantized),
      files: pinnedFilesFor(info, quantized).map((f) => ({
        path: f.path,
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
      })),
    });
    models[info.name] = {
      modelId: info.modelId,
      revision: info.revision,
      dimensions: info.dimensions,
      pooling: info.pooling,
      variants: { q8: variant(true), fp32: variant(false) },
    };
  }
  return { generatedFrom: MODEL_INFO_FILE, models };
}

/** Literals in a Python source that restate a pinned value: a catalog repo id, a revision, or any
 *  sha256 / 40-hex commit shape. Returns human-readable findings. */
export function findRestatedPins(pySource, catalog) {
  const found = [];
  for (const info of catalog) {
    if (pySource.includes(info.modelId)) found.push(`repo id "${info.modelId}"`);
    if (pySource.includes(info.revision)) found.push(`revision ${info.revision}`);
  }
  for (const m of pySource.matchAll(/\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b/g)) {
    found.push(`hex digest ${m[0]}`);
  }
  return [...new Set(found)];
}

/** Pure comparison: committed JSON text vs. what the catalog produces, plus the Python scan. */
export function checkPins({ catalog, pinnedFilesFor, dtypeFor, committedJson, pyFiles }) {
  const problems = [];
  if (!catalog || catalog.length === 0) problems.push("model-info.ts exported an empty catalog");
  const want = buildPins(catalog ?? [], pinnedFilesFor, dtypeFor);
  let have;
  try {
    have = JSON.parse(committedJson);
  } catch (e) {
    problems.push(`${PINS_FILE} is not valid JSON: ${e.message}`);
  }
  if (have && JSON.stringify(have) !== JSON.stringify(want)) {
    problems.push(
      `${PINS_FILE} does not match ${MODEL_INFO_FILE}. Regenerate: node scripts/check-model-pins.mjs --write`,
    );
  }
  if (pyFiles.length === 0)
    problems.push(`no modal_embed_*.py found under ${PY_DIR} (gate scanned nothing)`);
  for (const { name, source } of pyFiles) {
    for (const f of findRestatedPins(source, catalog ?? [])) {
      problems.push(`${name} restates a pinned value (${f}); read ${PINS_FILE} instead`);
    }
  }
  return { problems, want };
}

function readPyFiles(root) {
  return readdirSync(join(root, PY_DIR))
    .filter((n) => PY_EMBEDDER_RE.test(n))
    .map((n) => ({
      name: `${PY_DIR}/${n}`,
      source: readFileSync(join(root, PY_DIR, n), "utf8"),
    }));
}

async function main() {
  const write = process.argv.includes("--write");
  const info = await import(pathToFileURL(join(ROOT, MODEL_INFO_FILE)).href);
  const committedJson = (() => {
    try {
      return readFileSync(join(ROOT, PINS_FILE), "utf8");
    } catch {
      return "";
    }
  })();
  const { problems, want } = checkPins({
    catalog: info.MODEL_CATALOG,
    pinnedFilesFor: info.pinnedFilesFor,
    dtypeFor: info.dtypeFor,
    committedJson,
    pyFiles: readPyFiles(ROOT),
  });
  if (write) {
    writeFileSync(join(ROOT, PINS_FILE), `${JSON.stringify(want, null, 2)}\n`);
    console.log(`wrote ${PINS_FILE} (${Object.keys(want.models).length} model(s))`);
    // Only the staleness problem is cured by writing; a restated pin in Python still fails.
    const rest = problems.filter(
      (p) => !p.includes("does not match") && !p.includes("not valid JSON"),
    );
    if (rest.length === 0) return;
    problems.length = 0;
    problems.push(...rest);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-model-pins: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `check-model-pins: ${PINS_FILE} matches ${MODEL_INFO_FILE} (${Object.keys(want.models).length} model(s)); no Python file restates a pin`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
