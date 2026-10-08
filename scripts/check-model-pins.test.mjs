// Tests for scripts/check-model-pins.mjs (GH #1161). The gate must be GREEN on the real repo and RED
// on each way the pinned embedder identity can drift: a bumped pin with a stale artifact, a
// hand-edited artifact, and a Python script that restates a pin as a literal.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPins,
  checkPins,
  findRestatedPins,
  MODEL_INFO_FILE,
  PINS_FILE,
  PY_DIR,
  PY_EMBEDDER_RE,
} from "./check-model-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const info = await import(pathToFileURL(join(ROOT, MODEL_INFO_FILE)).href);
const committedJson = readFileSync(join(ROOT, PINS_FILE), "utf8");
const pyFiles = readdirSync(join(ROOT, PY_DIR))
  .filter((n) => PY_EMBEDDER_RE.test(n))
  .map((n) => ({ name: n, source: readFileSync(join(ROOT, PY_DIR, n), "utf8") }));

const run = (over = {}) =>
  checkPins({
    catalog: info.MODEL_CATALOG,
    pinnedFilesFor: info.pinnedFilesFor,
    dtypeFor: info.dtypeFor,
    committedJson,
    pyFiles,
    ...over,
  });

/** model-info's catalog with one field changed on the nomic entry, as a pin bump would. */
const driftedCatalog = (patch) =>
  info.MODEL_CATALOG.map((m) => (m.name === "nomic-embed-text-v1.5" ? patch(m) : m));

test("GREEN: the committed artifact equals model-info.ts and the real Python restates nothing", () => {
  assert.deepEqual(run().problems, []);
});

test("floor: the real run scanned a Python script and the nomic fp32 pins are in the artifact", () => {
  assert.ok(pyFiles.some((f) => f.name === "modal_embed_nomic.py"));
  const nomic = JSON.parse(committedJson).models["nomic-embed-text-v1.5"];
  assert.equal(nomic.dimensions, 768);
  assert.equal(nomic.variants.fp32.files.length, 4);
});

test("RED: a bumped revision in model-info.ts with a stale artifact", () => {
  const catalog = driftedCatalog((m) => ({ ...m, revision: "0".repeat(40) }));
  const { problems } = run({ catalog });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not match .*model-info\.ts.*--write/);
});

test("RED: a drifted sha256 in model-info.ts", () => {
  const catalog = driftedCatalog((m) => ({
    ...m,
    fp32: { ...m.fp32, onnxFile: { ...m.fp32.onnxFile, sha256: "f".repeat(64) } },
  }));
  assert.match(run({ catalog }).problems[0], /does not match/);
});

test("RED: a hand-edited artifact", () => {
  const edited = JSON.parse(committedJson);
  edited.models["nomic-embed-text-v1.5"].dimensions = 384;
  assert.match(run({ committedJson: JSON.stringify(edited) }).problems[0], /does not match/);
});

test("RED: an artifact that is not JSON", () => {
  assert.match(run({ committedJson: "{oops" }).problems[0], /not valid JSON/);
});

test("RED: the Python restating the repo id, the revision, or a checksum as a literal", () => {
  const nomic = info.modelInfoByName("nomic-embed-text-v1.5");
  const leaks = [
    `MODEL_ID = "${nomic.modelId}"`,
    `REVISION = "${nomic.revision}"`,
    `"onnx/model.onnx": "${nomic.fp32.onnxFile.sha256}",`,
    `PIN = "${"a".repeat(64)}"`,
  ];
  for (const source of leaks) {
    const { problems } = run({ pyFiles: [{ name: "modal_embed_x.py", source }] });
    assert.equal(problems.length > 0, true, source);
    assert.match(problems[0], /modal_embed_x\.py restates a pinned value/);
  }
});

test("RED: an empty catalog, and zero Python files scanned, are failures not silent passes", () => {
  assert.match(run({ catalog: [] }).problems[0], /empty catalog/);
  assert.match(run({ pyFiles: [] }).problems.join("\n"), /scanned nothing/);
});

test("findRestatedPins: a plain script with no pinned literal is clean", () => {
  assert.deepEqual(findRestatedPins('PINS = load_pins("pins.json")', info.MODEL_CATALOG), []);
});

test("buildPins: every catalog model carries both variants with their checksummed files", () => {
  const pins = buildPins(info.MODEL_CATALOG, info.pinnedFilesFor, info.dtypeFor);
  assert.deepEqual(Object.keys(pins.models), info.catalogModelNames());
  for (const m of Object.values(pins.models)) {
    assert.ok(m.variants.fp32.files.some((f) => f.path === "onnx/model.onnx"));
    assert.ok(m.variants.q8.files.some((f) => f.path === "onnx/model_quantized.onnx"));
  }
});
