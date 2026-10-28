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
 * `models` is derived from model-info.ts and gated for equality. `evalOnly` is hand-maintained: it
 * pins GPU-only eval models (EmbeddingGemma 2) that are not local-provider catalog entries, so no
 * derivation can produce them. The gate checks its shape and that no Python restates its repo id or
 * revision; `--write` carries it over verbatim, never regenerates it.
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

const TOP_KEYS = ["generatedFrom", "models", "evalOnly"];
const ENTRY_KEYS = ["modelId", "revision", "dimensions", "pooling", "format", "note", "files"];
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Shape of the hand-maintained `evalOnly` block. Its values are not derivable from model-info.ts,
 *  so the gate checks their form only. Returns problems; none for an absent block. */
export function validateEvalOnly(evalOnly) {
  if (evalOnly === undefined) return [];
  if (!isObject(evalOnly)) return ["evalOnly must be an object keyed by eval-model name"];
  const problems = [];
  if (Object.keys(evalOnly).length === 0)
    problems.push("evalOnly must name at least one eval model (or be absent)");
  for (const [name, e] of Object.entries(evalOnly)) {
    const at = `evalOnly.${name}`;
    if (!isObject(e)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    for (const k of Object.keys(e)) {
      if (!ENTRY_KEYS.includes(k)) problems.push(`${at} has unknown key "${k}"`);
    }
    if (typeof e.modelId !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(e.modelId))
      problems.push(`${at}.modelId must be "owner/name"`);
    if (typeof e.revision !== "string" || !HEX40.test(e.revision))
      problems.push(`${at}.revision must be a 40-hex commit`);
    if (!Number.isInteger(e.dimensions) || e.dimensions <= 0)
      problems.push(`${at}.dimensions must be a positive integer`);
    if (typeof e.pooling !== "string" || e.pooling === "")
      problems.push(`${at}.pooling must be a non-empty string`);
    if (e.format !== "safetensors" && e.format !== "onnx")
      problems.push(`${at}.format must be "safetensors" or "onnx"`);
    if (!Array.isArray(e.files) || e.files.length === 0) {
      problems.push(`${at}.files must be a non-empty array`);
      continue;
    }
    const seenPaths = new Set();
    e.files.forEach((f, i) => {
      const fat = `${at}.files[${i}]`;
      if (!isObject(f) || typeof f.path !== "string" || f.path === "")
        problems.push(`${fat}.path must be a non-empty string`);
      else if (seenPaths.has(f.path))
        problems.push(`${fat}.path duplicates an earlier file's path`);
      else seenPaths.add(f.path);
      if (!isObject(f) || typeof f.sha256 !== "string" || !HEX64.test(f.sha256))
        problems.push(`${fat}.sha256 must be 64-hex`);
      if (!isObject(f) || !Number.isInteger(f.sizeBytes) || f.sizeBytes <= 0)
        problems.push(`${fat}.sizeBytes must be a positive integer`);
    });
  }
  return problems;
}

/** Literals in a Python source that restate a pinned value: a catalog or eval-only repo id or
 *  revision, or any sha256 / 40-hex commit shape. Returns human-readable findings. */
export function findRestatedPins(pySource, catalog, evalOnlyEntries = []) {
  const found = [];
  const pinned = [...catalog, ...evalOnlyEntries.filter(isObject)];
  for (const p of pinned) {
    if (typeof p.modelId === "string" && p.modelId !== "" && pySource.includes(p.modelId))
      found.push(`repo id "${p.modelId}"`);
    if (typeof p.revision === "string" && p.revision !== "" && pySource.includes(p.revision))
      found.push(`revision ${p.revision}`);
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
  if (have !== undefined) {
    if (!isObject(have)) {
      problems.push(`${PINS_FILE} is not a JSON object`);
    } else {
      for (const k of Object.keys(have)) {
        if (!TOP_KEYS.includes(k)) problems.push(`${PINS_FILE} has unknown top-level key "${k}"`);
      }
      const derived = (o) => JSON.stringify({ generatedFrom: o.generatedFrom, models: o.models });
      if (derived(have) !== derived(want)) {
        problems.push(
          `${PINS_FILE} does not match ${MODEL_INFO_FILE}. Regenerate: node scripts/check-model-pins.mjs --write`,
        );
      }
      problems.push(...validateEvalOnly(have.evalOnly));
    }
  }
  const evalOnly = isObject(have) && isObject(have.evalOnly) ? Object.values(have.evalOnly) : [];
  if (pyFiles.length === 0)
    problems.push(`no modal_embed_*.py found under ${PY_DIR} (gate scanned nothing)`);
  for (const { name, source } of pyFiles) {
    for (const f of findRestatedPins(source, catalog ?? [], evalOnly)) {
      problems.push(`${name} restates a pinned value (${f}); read ${PINS_FILE} instead`);
    }
  }
  return { problems, want };
}

/** What `--write` puts in the file: the derived `models`, plus the committed `evalOnly` block copied
 *  verbatim. A committed file that cannot be read has no block to copy, so the write is refused
 *  rather than dropping it. An absent file (first write) has nothing to keep. */
export function pinsToWrite({ catalog, pinnedFilesFor, dtypeFor, committedJson }) {
  const want = buildPins(catalog ?? [], pinnedFilesFor, dtypeFor);
  if (committedJson.trim() === "") return want;
  let have;
  try {
    have = JSON.parse(committedJson);
  } catch (e) {
    throw new Error(
      `${PINS_FILE} is not valid JSON, so its evalOnly block cannot be preserved: ${e.message}`,
    );
  }
  if (isObject(have)) {
    // A misspelt block (say `evalonly`) would be dropped by the regeneration; refuse it instead.
    for (const k of Object.keys(have)) {
      if (!TOP_KEYS.includes(k))
        throw new Error(
          `${PINS_FILE} has unknown top-level key "${k}"; --write refuses to drop it`,
        );
    }
    if (have.evalOnly !== undefined) want.evalOnly = have.evalOnly;
  }
  return want;
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
  const readCommitted = () => {
    try {
      return readFileSync(join(ROOT, PINS_FILE), "utf8");
    } catch {
      return "";
    }
  };
  if (write) {
    const next = pinsToWrite({
      catalog: info.MODEL_CATALOG,
      pinnedFilesFor: info.pinnedFilesFor,
      dtypeFor: info.dtypeFor,
      committedJson: readCommitted(),
    });
    writeFileSync(join(ROOT, PINS_FILE), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${PINS_FILE} (${Object.keys(next.models).length} model(s))`);
  }
  // Checked after any write, so a restated Python pin or a malformed evalOnly still fails the run.
  const { problems, want } = checkPins({
    catalog: info.MODEL_CATALOG,
    pinnedFilesFor: info.pinnedFilesFor,
    dtypeFor: info.dtypeFor,
    committedJson: readCommitted(),
    pyFiles: readPyFiles(ROOT),
  });
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
